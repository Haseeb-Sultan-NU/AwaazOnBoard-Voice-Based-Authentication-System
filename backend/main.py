import os
import shutil
from contextlib import asynccontextmanager
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, BackgroundTasks
from fastapi.responses import JSONResponse, FileResponse
from pydantic import BaseModel
import torch
import torchaudio
import soundfile as sf
from dotenv import load_dotenv
import warnings
from pydub import AudioSegment
import uuid
from fastapi.responses import FileResponse
from src.models import AuditLog
from fastapi import BackgroundTasks, HTTPException
import io
import base64
from pydantic import BaseModel
from passlib.context import CryptContext
from typing import Optional
from fastapi.middleware.cors import CORSMiddleware
import uuid
import os
import shutil
from pydub import AudioSegment
from fastapi import Form, File, UploadFile, HTTPException, Depends
import numpy as np
import torch
import datetime


from sqlalchemy.orm import Session
from sqlalchemy import desc
from fastapi import Depends
from src.database import get_db
from src.models import User, Enrollment, AuditLog, EnterpriseAPI

# --- SUPPRESS THIRD-PARTY WARNINGS ---
warnings.filterwarnings("ignore", category=UserWarning, message=".*torchaudio._backend.*")
warnings.filterwarnings("ignore", category=UserWarning, message=".*TypedStorage is deprecated.*")
warnings.filterwarnings("ignore", category=UserWarning, message=".*AudioMetaData.*")
warnings.filterwarnings("ignore", module="pyannote.*")
warnings.filterwarnings("ignore", module="speechbrain.*")

# --- WINDOWS MONKEYPATCHES ---
if not hasattr(torchaudio, "list_audio_backends"):
    torchaudio.list_audio_backends = lambda: ["soundfile"]

def custom_audio_load(filepath, channels_first=True, **kwargs):
    data, samplerate = sf.read(filepath, dtype='float32')
    tensor = torch.from_numpy(data)
    if tensor.ndim == 1: tensor = tensor.unsqueeze(0)
    else: tensor = tensor.t()
    if not channels_first: tensor = tensor.t()
    return tensor, samplerate
torchaudio.load = custom_audio_load

# --- IMPORTS ---
from src.verification.gatekeeper import SecurityGatekeeper # Make sure this matches your class name!
from src.verification.digit_asr import UrduASRInference
from src.verification.liveness_validator import LivenessValidator
from src.verification.ecapa_engine import EcapaVerifier
from src.verification.challenge_generator import ChallengeGenerator
from src.verification.enrollment import EnrollmentManager
import numpy as np

# --- GLOBAL AI MODELS ---
models = {}
audio_cache = {}
active_sessions = {}

def cosine_sim(a, b):
    return np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b))

def cleanup_temp_file(filepath: str):
    """Background task to delete temporary audio files"""
    if os.path.exists(filepath):
        os.remove(filepath)

@asynccontextmanager
async def lifespan(app: FastAPI):
    # 1. Boot up the Server & Models
    print("🚀 FASTAPI STARTUP: Loading AI Models into VRAM...")
    load_dotenv()
    hf_token = os.getenv("HF_TOKEN")
    
    # Load everything into the global dictionary
    models["gatekeeper"] = SecurityGatekeeper(hf_token)
    models["asr"] = UrduASRInference(model_size="base")
    models["validator"] = LivenessValidator(pass_threshold=0.80)
    models["ecapa"] = EcapaVerifier(finetuned_weights_path="models/best_urdu_triplet_ecapa.pth")
    models["challenge_gen"] = ChallengeGenerator(prompt_audio_dir="data/audio_digits")
    models["enrollment_mgr"] = EnrollmentManager("models/best_urdu_triplet_ecapa.pth")

    # --- PRELOAD URDU DIGITS INTO RAM ---
    print("🎙️ Caching Urdu IVR Audio Digits into Memory...")
    try:
        for i in range(10):
            file_path = f"data/audio_digits/{i}.wav"
            if os.path.exists(file_path):
                audio_cache[str(i)] = AudioSegment.from_wav(file_path)
            else:
                print(f"⚠️ WARNING: Missing audio file {file_path}")
        # Let's also add a half-second silence gap so the numbers don't blend together
        audio_cache["silence"] = AudioSegment.silent(duration=500) 
        print("✅ Audio assets cached successfully!")
    except Exception as e:
        print(f"❌ Audio Caching Failed: {e}")
    
    print("✅ All models loaded! API is ready to receive traffic.")
    yield
    # 2. Shutdown
    print("🛑 Shutting down server and clearing memory...")
    models.clear()

app = FastAPI(title="Telephony Speaker Verification API", lifespan=lifespan)

# --- ADD THIS BLOCK HERE ---
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allows all origins (React, Mobile, etc.)
    allow_credentials=True,
    allow_methods=["*"],  # Allows POST, GET, OPTIONS, etc.
    allow_headers=["*"],  # Allows all headers
)

# --- SECURITY CONFIGURATION ---
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

def verify_password(plain_password, hashed_password):
    return pwd_context.verify(plain_password, hashed_password)

def get_password_hash(password):
    return pwd_context.hash(password)

# --- PYDANTIC SCHEMAS (Matches React Exactly) ---
class UserSignup(BaseModel):
    cnic: str
    full_name: str
    phone_number: str
    password: str

class UserLogin(BaseModel):
    cnic: str
    password: str

class ProfileUpdate(BaseModel):
    user_id: str
    full_name: Optional[str] = None
    phone_number: Optional[str] = None
    email: Optional[str] = None

# --- ENDPOINTS ---

@app.get("/health")
async def health_check():
    return {"status": "online", "models_loaded": len(models) > 0}

# --- PROFILE ENDPOINTS ---

@app.get("/profile")
async def get_profile(user_id: str, db: Session = Depends(get_db)):
    """Returns the user's profile data."""
    normalized = user_id.replace("-", "").replace(" ", "").strip()
    user = db.query(User).filter(User.user_id == normalized).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found.")
    return {
        "user_id": user.user_id,
        "cnic": user.cnic,
        "full_name": user.full_name,
        "phone_number": user.phone_number,
        "email": getattr(user, "email", None),
        "network_operator": user.network_operator,
    }

@app.put("/profile")
async def update_profile(payload: ProfileUpdate, db: Session = Depends(get_db)):
    """Updates the user's profile fields."""
    normalized = payload.user_id.replace("-", "").replace(" ", "").strip()
    user = db.query(User).filter(User.user_id == normalized).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found.")
    
    if payload.full_name is not None:
        user.full_name = payload.full_name
    if payload.phone_number is not None:
        user.phone_number = payload.phone_number
    if payload.email is not None:
        user.email = payload.email
    
    db.add(user)
    db.commit()
    db.refresh(user)
    
    return {
        "status": "success",
        "user_id": user.user_id,
        "cnic": user.cnic,
        "full_name": user.full_name,
        "phone_number": user.phone_number,
        "email": getattr(user, "email", None),
        "network_operator": user.network_operator,
    }

@app.get("/challenge")
async def get_challenge():
    try:
        # 1. Generate sequence
        challenge_data = models["challenge_gen"].generate_numeric_challenge(length=3)
        challenge_str = ",".join(map(str, challenge_data))
        
        # 2. Stitch in memory using BytesIO (No hard drive needed!)
        combined_audio = AudioSegment.empty()
        for digit in challenge_data:
            combined_audio += audio_cache[str(digit)]
            combined_audio += audio_cache["silence"]
        
        # 3. Export to a buffer instead of a file
        buffer = io.BytesIO()
        combined_audio.export(buffer, format="wav")
        
        # 4. Encode to Base64 string
        audio_base64 = base64.b64encode(buffer.getvalue()).decode('utf-8')
        
        print(f"✅ Challenge {challenge_str} generated and encoded.")

        # 5. Return JSON (Atomic response)
        return {
            "challenge_sequence": challenge_str,
            "audio_data": f"data:audio/wav;base64,{audio_base64}"
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    
@app.get("/authenticate/audio/{session_id}")
async def get_challenge_audio(session_id: str):
    """Stitches the challenge audio and sends it to React."""
    sequence = active_sessions.get(session_id)
    if not sequence:
        raise HTTPException(status_code=404, detail="Session not found")
        
    # Uses the stitcher you built in challengegenerator.py!
    result = models["challenge_gen"].stitch_audio_prompt(sequence)
    
    return FileResponse(result["audio_file_path"], media_type="audio/wav")    

@app.post("/enroll")
async def enroll_user(
    user_id: str = Form(...),
    take_1: UploadFile = File(...),
    take_2: UploadFile = File(...),
    take_3: UploadFile = File(...),
    phone_number: Optional[str] = Form(None),
    imsi: Optional[str] = Form(None),
    iccid: Optional[str] = Form(None),
    db: Session = Depends(get_db)
):
    """Creates a secure Multi-Template Dictionary (.pt) and registers the user."""
    
    # Check if user already exists
    # Auto-create a stub user if this CNIC doesn't exist (Sandbox flow)
    existing_user = db.query(User).filter(User.user_id == user_id).first()
    if not existing_user:
        new_user = User(
            user_id=user_id,
            cnic=user_id,
            hashed_password="auto_sandbox_user"
        )
        db.add(new_user)
        db.commit()
        db.refresh(new_user)

    existing_enrollment = db.query(Enrollment).filter(Enrollment.user_id == user_id).first()
    if existing_enrollment:
        raise HTTPException(status_code=400, detail="User is already enrolled.")

    temp_files = []
    try:
        # Helper function to forcefully convert any browser audio to true 16kHz WAV
        def convert_to_wav(upload_file, index):
            raw_path = f"data/temp/{user_id}_raw_{index}.webm"
            clean_path = f"data/temp/{user_id}_take_{index}.wav"
            
            # Save raw browser file
            with open(raw_path, "wb") as buffer:
                shutil.copyfileobj(upload_file.file, buffer)
            
            # Convert to pure 16kHz WAV using pydub
            audio = AudioSegment.from_file(raw_path)
            audio = audio.set_frame_rate(16000).set_channels(1)
            audio.export(clean_path, format="wav")
            
            # Clean up the raw file
            if os.path.exists(raw_path):
                os.remove(raw_path)
                
            return clean_path

        # Convert all three takes
        for i, file in enumerate([take_1, take_2, take_3]):
            clean_file_path = convert_to_wav(file, i)
            temp_files.append(clean_file_path)
            
        print(f"[ENROLLMENT] Starting SECURE MULTI-TEMPLATE enrollment for user: {user_id}")
        success = models["enrollment_mgr"].create_multi_template(user_id, temp_files)
        
        if success:
            template_path = f"data/enrollments/{user_id}_baseline.pt"
            
            new_enrollment = Enrollment(user_id=user_id, template_uri=template_path)
            db.add(new_enrollment)
            
            # Update user with optional SIM data
            user = db.query(User).filter(User.cnic == user_id).first()
            if user:
                if phone_number:
                    user.phone_number = phone_number
                if imsi:
                    user.imei = imsi  # IMSI maps to imei column for SIM tracking
                db.add(user)
            db.commit()
            
            return {"status": "success", "message": f"User {user_id} securely enrolled."}
        else:
            raise HTTPException(status_code=500, detail="Enrollment AI processing failed.")
            
    except Exception as e:
        print(f"Enrollment Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        for f in temp_files:
            cleanup_temp_file(f)


@app.post("/verify")
async def verify_user(
    background_tasks: BackgroundTasks,
    user_id: str = Form(...),
    expected_challenge: str = Form(...),
    audio_file: UploadFile = File(...),
    db: Session = Depends(get_db) # <--- DATABASE INJECTED
):
    """The Ultimate Gauntlet: Pyannote -> ASR -> ECAPA (Fully Audited)"""
    
    # 1. Database Check: Is this a valid, enrolled, unlocked user?
    user = db.query(User).filter(User.user_id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found.")
    if user.locked_out:
        raise HTTPException(status_code=403, detail="Account is locked due to multiple failed attempts.")
        
    enrollment = db.query(Enrollment).filter(Enrollment.user_id == user_id).first()
    if not enrollment:
        raise HTTPException(status_code=404, detail="User has no biometric enrollment.")

    master_template = enrollment.template_uri # Get the path dynamically from PostgreSQL!
    if not os.path.exists(master_template):
        raise HTTPException(status_code=500, detail="Database error: Biometric template file missing from disk.")

    temp_audio_path = f"data/temp/live_{user_id}.wav"
    with open(temp_audio_path, "wb") as buffer:
        shutil.copyfileobj(audio_file.file, buffer)
    background_tasks.add_task(cleanup_temp_file, temp_audio_path)
    
    expected_sequence = [int(x.strip()) for x in expected_challenge.split(",")]

    # Prepare an Audit Log Record
    log_entry = AuditLog(
        user_id=user_id, 
        expected_challenge=expected_challenge,
        liveness_passed=False # Default to false until proven otherwise
    )

    try:
        # STAGE 1: Gatekeeper (Coercion Check)
        is_live, msg = models["gatekeeper"].check_audio_security(temp_audio_path)
        if not is_live:
            log_entry.coercion_detected = True
            log_entry.status = "DENIED_COERCION"
            db.add(log_entry)
            db.commit()
            return JSONResponse(status_code=403, content={"status": "denied", "reason": msg})
            
        # STAGE 2: ASR Check (Active Liveness)
        transcription = models["asr"].transcribe(temp_audio_path)
        log_entry.transcribed_text = transcription
        validation = models["validator"].evaluate_challenge(expected_sequence, transcription)
        
        if not validation["liveness_passed"]:
            log_entry.status = "DENIED_LIVENESS"
            db.add(log_entry)
            db.commit()
            return JSONResponse(status_code=403, content={"status": "denied", "reason": validation["status_message"]})
            
        log_entry.liveness_passed = True
            
        # STAGE 3: ECAPA (Biometric Match)
        try: master_dict = torch.load(master_template, weights_only=False)
        except: master_dict = torch.load(master_template)
            
        emb_clean = np.array(master_dict["clean"].detach().cpu().numpy()).flatten()
        emb_telephony = np.array(master_dict["telephony"].detach().cpu().numpy()).flatten()
        emb_live = np.array(models["ecapa"].extract_embedding(temp_audio_path)).flatten()

        score = float(max(cosine_sim(emb_clean, emb_live), cosine_sim(emb_telephony, emb_live)))
        log_entry.biometric_score = score
        
        if score >= 0.2393:
            log_entry.status = "GRANTED"
            
            # Reset failed attempts on success
            user.failed_attempts = 0
            db.add(user)
            db.add(log_entry)
            db.commit()
            return {"status": "granted", "score": score, "message": "Identity Verified."}
        else:
            log_entry.status = "DENIED_BIOMETRIC"
            
            # Increment failed attempts
            user.failed_attempts += 1
            if user.failed_attempts >= 3:
                user.locked_out = True
                
            db.add(user)
            db.add(log_entry)
            db.commit()
            return JSONResponse(status_code=403, content={"status": "denied", "reason": "Biometric mismatch.", "score": score})
            
    except Exception as e:
        db.rollback() # If python crashes, rollback the database
        raise HTTPException(status_code=500, detail=str(e))
    
# --- UPDATED AUTH ENDPOINTS ---
@app.post("/signup")
async def signup(user_data: UserSignup, db: Session = Depends(get_db)):
    """Registers a new user using CNIC."""
    if db.query(User).filter(User.cnic == user_data.cnic).first():
        raise HTTPException(status_code=400, detail="CNIC already registered.")

    hashed_pw = get_password_hash(user_data.password)
    new_user = User(
        user_id=user_data.cnic, # We use CNIC as the unique User ID
        cnic=user_data.cnic, 
        full_name=user_data.full_name,
        hashed_password=hashed_pw
    )
    
    db.add(new_user)
    db.commit()
    
    return {"status": "success", "message": f"Account for {user_data.full_name} created."}

@app.post("/login")
async def login(credentials: UserLogin, db: Session = Depends(get_db)):
    """Authenticates a user via CNIC and password."""
    user = db.query(User).filter(User.cnic == credentials.cnic).first()
    
    if not user or not verify_password(credentials.password, user.hashed_password):
        raise HTTPException(status_code=401, detail="Invalid CNIC or password.")
        
    if user.locked_out:
        raise HTTPException(status_code=403, detail="Account locked due to biometric failure.")

    # Ensure it checks against the CNIC, since that's how we save templates
    enrollment = db.query(Enrollment).filter(Enrollment.user_id == credentials.cnic).first()
    is_enrolled = True if enrollment else False

    display_name = user.full_name or user.cnic

    return {
        "status": "success", 
        "user_id": user.user_id,
        "cnic": user.cnic,
        "full_name": display_name,
        "token": "demo-token",
        "is_enrolled": is_enrolled 
    }

@app.post("/authenticate/challenge")
async def get_challenge():
    """Generates a dynamic 3-digit numeric challenge using the preloaded ChallengeGenerator."""
    
    # 1. Use YOUR preloaded global model
    challenge_sequence = models["challenge_gen"].generate_numeric_challenge(length=3)
    
    session_id = str(uuid.uuid4())
    active_sessions[session_id] = challenge_sequence
    
    return {
        "session_id": session_id,
        "challenge": challenge_sequence, # React will use this to play the audio locally
        "sim_swap_warning": False
    }

@app.post("/authenticate/verify")
async def verify_voice(
    session_id: str = Form(...),
    user_id: str = Form(...),  # The CNIC
    voice: UploadFile = File(...),
    db: Session = Depends(get_db)
):
    """Full Pipeline: Gatekeeper -> ASR Liveness -> Multi-Template ECAPA -> Database."""
    
    expected_sequence = active_sessions.get(session_id)
    if not expected_sequence:
        raise HTTPException(status_code=400, detail="Invalid or expired session.")

    temp_files = []
    try:
        # Convert Browser WebM to 16kHz WAV
        raw_path = f"data/temp/{session_id}_raw.webm"
        clean_path = f"data/temp/{session_id}_auth.wav"
        temp_files.extend([raw_path, clean_path])
        
        with open(raw_path, "wb") as buffer:
            shutil.copyfileobj(voice.file, buffer)
            
        audio = AudioSegment.from_file(raw_path)
        audio = audio.set_frame_rate(16000).set_channels(1)
        audio.export(clean_path, format="wav")

        # ==========================================
        # STEP 0: SECURITY GATEKEEPER (Pyannote Diarization)
        # ==========================================
        print(f"[GATEKEEPER] Analyzing audio for multiple speakers or splicing...")
        
        is_secure, security_msg = models["gatekeeper"].check_audio_security(clean_path)
        gatekeeper_score = 1.0 if is_secure else 0.0

        # ==========================================
        # STEP 1: LIVENESS DETECTION (Preloaded ASR)
        # — No early return; store result and continue —
        # ==========================================
        asr_transcription = models["asr"].transcribe(clean_path) 
        liveness_result = models["validator"].evaluate_challenge(expected_sequence, asr_transcription)
        liveness_passed = bool(liveness_result["liveness_passed"])
        liveness_score = liveness_result["confidence_score"] / 100

        # ==========================================
        # STEP 2: BIOMETRIC VERIFICATION (ECAPA-TDNN)
        # — Always runs, even if liveness/gatekeeper failed —
        # ==========================================
        template_path = f"data/enrollments/{user_id.replace(' ', '_')}_baseline.pt"
        if not os.path.exists(template_path):
             raise HTTPException(status_code=400, detail="User biometric template not found.")

        try:
            saved_templates = torch.load(template_path, map_location="cpu", weights_only=False)
        except Exception:
            saved_templates = torch.load(template_path, map_location="cpu")
        
        live_embedding = models["ecapa"].extract_embedding(clean_path) 
        live_flat = np.array(live_embedding).flatten()

        templates_to_check = []
        def add_if_valid(tensor_obj):
            try:
                arr = tensor_obj.detach().cpu().numpy().flatten() if hasattr(tensor_obj, 'detach') else np.array(tensor_obj).flatten()
                if arr.shape[0] == 192:
                    templates_to_check.append(arr)
            except Exception: pass

        if isinstance(saved_templates, dict):
            for key, val in saved_templates.items(): add_if_valid(val)
        elif isinstance(saved_templates, torch.Tensor):
            if saved_templates.ndim == 1: add_if_valid(saved_templates)
            else:
                for row in saved_templates: add_if_valid(row)
        else:
            for item in saved_templates: add_if_valid(item)
                
        if not templates_to_check:
            raise HTTPException(status_code=500, detail="No valid 192-dim voice prints found.")

        max_score = -1.0
        for temp_flat in templates_to_check:
            score = np.dot(live_flat, temp_flat) / (np.linalg.norm(live_flat) * np.linalg.norm(temp_flat))
            if score > max_score: max_score = float(score)

        ai_similarity_score = max_score
        OPTIMAL_THRESHOLD = 0.2393
        is_match = ai_similarity_score >= OPTIMAL_THRESHOLD

        if is_match:
            ux_score = 0.80 + ((ai_similarity_score - OPTIMAL_THRESHOLD) / (1.0 - OPTIMAL_THRESHOLD)) * 0.20
        else:
            ux_score = ((ai_similarity_score - (-1.0)) / (OPTIMAL_THRESHOLD - (-1.0))) * 0.79 
        ux_score = max(0.0, min(1.0, ux_score))

        # ==========================================
        # CONSOLIDATED DECISION (Full Evaluation)
        # ==========================================
        authenticated = is_secure and liveness_passed and is_match

        # Build denial reason (if any)
        if authenticated:
            denial_msg = "Identity Verified."
            risk = 0.1
        else:
            reasons = []
            if not is_secure:
                reasons.append(f"Gatekeeper FAIL: {security_msg}")
            if not liveness_passed:
                reasons.append(f"Liveness FAIL: {liveness_result['status_message']}")
            if not is_match:
                reasons.append("Biometric FAIL: Voice did not match baseline.")
            denial_msg = " | ".join(reasons)
            risk = 0.9 if not is_secure else (0.7 if not liveness_passed else 0.8)

        # Determine final audit status
        if authenticated:
            audit_status = "GRANTED"
        elif not is_secure:
            audit_status = "DENIED_COERCION"
        elif not liveness_passed:
            audit_status = "DENIED_LIVENESS"
        else:
            audit_status = "DENIED_BIOMETRIC"

        del active_sessions[session_id]
        
        final_response = {
            "authenticated": bool(authenticated),
            "similarity_score": float(ux_score),
            "liveness_score": float(liveness_score),
            "risk_score": float(risk),
            "gatekeeper_score": float(gatekeeper_score),
            "session_id": session_id,
            "message": denial_msg
        }

        # ==========================================
        # STEP 3: SAVE TO DATABASE (Updates Dashboard!)
        # ==========================================
        try:
            expected_str = ",".join(map(str, expected_sequence))
            new_log = AuditLog(
                user_id=user_id,
                coercion_detected=not is_secure,
                expected_challenge=expected_str,
                transcribed_text=str(asr_transcription),
                liveness_passed=liveness_passed,
                biometric_score=float(ai_similarity_score),
                status=audit_status,
            )
            db.add(new_log)
            db.commit()
            print("[DATABASE] Session saved successfully.")
        except Exception as db_err:
            print(f"[DATABASE ERROR] Could not save session: {db_err}")
            db.rollback()

        return final_response

    except Exception as e:
        print(f"Verification Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        for f in temp_files: cleanup_temp_file(f)

# --- SUPER ADMIN CNIC (with or without dashes) ---
SUPER_ADMIN_CNIC = "0000000000000"

def _normalize_cnic(raw: str) -> str:
    """Strip dashes so '00000-0000000-0' becomes '0000000000000'."""
    return raw.replace("-", "").replace(" ", "").strip()

def _is_super_admin(user_id: str) -> bool:
    return _normalize_cnic(user_id) == SUPER_ADMIN_CNIC

@app.get("/authenticate/sessions")
async def get_real_sessions(
    user_id: Optional[str] = None,
    db: Session = Depends(get_db)
):
    """Fetches the actual session history from the database.
    Super Admin (CNIC 0000000000000) sees ALL logs; others see only their own."""
    try:
        query = db.query(AuditLog).order_by(desc(AuditLog.id))
        
        if user_id and _is_super_admin(user_id):
            # Super admin: no filter, return all
            logs = query.limit(50).all()
        elif user_id:
            logs = query.filter(AuditLog.user_id == _normalize_cnic(user_id)).limit(20).all()
        else:
            logs = query.limit(10).all()
        
        sessions_data = []
        for log in logs:
            sessions_data.append({
                "id": str(log.id),
                "user_id": log.user_id,
                "session_type": "VOICE AUTH",
                "session_timestamp": log.attempt_time.isoformat() if log.attempt_time else datetime.datetime.now().isoformat(),
                "status": log.status,
                "biometric_score": log.biometric_score,
                "liveness_passed": log.liveness_passed,
                "coercion_detected": log.coercion_detected,
            })
            
        return {"sessions": sessions_data}
    except Exception as e:
        print(f"Failed to fetch sessions: {e}")
        return {"sessions": []}


@app.get("/enrollments")
async def get_enrollments(
    user_id: Optional[str] = None,
    db: Session = Depends(get_db)
):
    """Returns enrolled profiles.
    Super Admin sees ALL enrollments (joined with User); standard user sees only their own."""
    try:
        query = db.query(Enrollment, User).join(User, Enrollment.user_id == User.user_id)
        
        if user_id and _is_super_admin(user_id):
            results = query.order_by(Enrollment.id.desc()).all()
        elif user_id:
            results = query.filter(Enrollment.user_id == _normalize_cnic(user_id)).all()
        else:
            results = query.order_by(Enrollment.id.desc()).all()

        enrollments_data = []
        for enrollment, user in results:
            enrollments_data.append({
                "user_id": enrollment.user_id,
                "full_name": user.full_name,
                "phone_number": user.phone_number,
                "network_operator": user.network_operator,
                "enrolled_at": enrollment.created_at.isoformat() if enrollment.created_at else None,
                "audio_quality_snr": enrollment.audio_quality_snr,
                "status": enrollment.status or "ACTIVE",
                "embedding_dim": enrollment.embedding_dim,
            })

        return {"enrollments": enrollments_data}
    except Exception as e:
        print(f"Failed to fetch enrollments: {e}")
        return {"enrollments": []}

    
@app.get("/transactions")
async def get_mock_transactions():
    """Feeds the Dashboard Transactions count (Reserved for FYP 2)."""
    return {"transactions": []}

@app.get("/enroll/status")
async def get_mock_enrollment():
    """Feeds the Dashboard Enrollment Banner."""
    return {"enrollment": {
        "is_enrolled": True, 
        "enrollment_date": datetime.datetime.now().isoformat(), 
        "confidence_score": 0.99
    }}