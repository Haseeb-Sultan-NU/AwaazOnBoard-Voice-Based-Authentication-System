import os
import shutil
import asyncio
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
from fastapi import Form, File, UploadFile, HTTPException, Depends, Request, Response
import numpy as np
import torch
import datetime
import re
import time


from sqlalchemy.orm import Session
from sqlalchemy import desc, or_, func, false
from fastapi import Depends
from src.database import get_db, engine, Base, SessionLocal, _using_sqlite
from src.models import User, Enrollment, AuditLog, EnterpriseAPI, Customer, CustomerEnrollment, AuthLog

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
active_auth_sessions = {}  # real auth sessions: token -> user_data

def cosine_sim(a, b):
    return np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b))

def cleanup_temp_file(filepath: str):
    """Background task to delete temporary audio files"""
    if os.path.exists(filepath):
        os.remove(filepath)

@asynccontextmanager
async def lifespan(app: FastAPI):
    # 0. Provision database tables (safe no-op on Postgres, essential for in-memory SQLite)
    Base.metadata.create_all(bind=engine)
    print("✅ Database tables dynamically verified/created.")

    # 0a. Lightweight migration: create_all() never ALTERs existing tables,
    # so add the AuthLog telemetry columns if auth_logs pre-dates them.
    if not _using_sqlite:
        from sqlalchemy import text
        _authlog_cols = [
            "cnic VARCHAR NOT NULL DEFAULT ''",
            "liveness_score DOUBLE PRECISION",
            "match_confidence DOUBLE PRECISION",
            "failure_reason VARCHAR",
            "latency_ms INTEGER NOT NULL DEFAULT 0",
        ]
        try:
            with engine.begin() as conn:
                for col in _authlog_cols:
                    conn.execute(text(f"ALTER TABLE auth_logs ADD COLUMN IF NOT EXISTS {col}"))
            print("✅ auth_logs telemetry columns verified.")
        except Exception as mig_err:
            print(f"[MIGRATION WARNING] auth_logs column check failed: {mig_err}")

    # 0b. Seed default demo users ONLY on a completely empty database.
    # Never drops/deletes/overwrites existing rows — data persists across restarts.
    seed_db = SessionLocal()
    try:
        if seed_db.query(User).count() == 0:
            _seed_users = [
                {"user_id": "0000000000000", "cnic": "0000000000000",
                 "full_name": "Enterprise Admin", "password": "admin123"},
                {"user_id": "1111111111111", "cnic": "1111111111111",
                 "full_name": "Demo Evaluator", "password": "demo123"},
            ]
            for u in _seed_users:
                seed_db.add(User(
                    user_id=u["user_id"],
                    cnic=u["cnic"],
                    full_name=u["full_name"],
                    hashed_password=get_password_hash(u["password"]),
                ))
            seed_db.commit()
            print("🌱 Empty database detected — seeded master account (CNIC: 0000000000000) and demo evaluator.")
        else:
            print("✅ Existing data found — skipping seed. Database persisted across restart.")
    except Exception as seed_err:
        print(f"⚠️  Demo seed skipped: {seed_err}")
        seed_db.rollback()
    finally:
        seed_db.close()

    # 0c. Self-healing migration: detect and rehash any plain-text passwords
    heal_db = SessionLocal()
    try:
        all_users = heal_db.query(User).all()
        rehashed_count = 0
        for user in all_users:
            pw = user.hashed_password or ""
            # Valid bcrypt hashes always start with $2b$ or $2a$ (passlib/bcrypt)
            if not (pw.startswith("$2b$") or pw.startswith("$2a$")):
                user.hashed_password = get_password_hash(pw)
                heal_db.add(user)
                rehashed_count += 1
        if rehashed_count:
            heal_db.commit()
            print(f"🔐 Auto-healed {rehashed_count} user(s) with plain-text passwords.")
        else:
            print("✅ All passwords are already properly hashed.")
    except Exception as heal_err:
        print(f"⚠️  Password auto-heal skipped: {heal_err}")
        heal_db.rollback()
    finally:
        heal_db.close()

    # 1. Boot up the Server & Models
    print("🚀 FASTAPI STARTUP: Loading AI Models into VRAM...")
    load_dotenv()
    hf_token = os.getenv("HF_TOKEN")
    
    # Load everything into the global dictionary
    models["gatekeeper"] = SecurityGatekeeper(hf_token)
    models["asr"] = UrduASRInference(model_size="small")  # keep in sync with bank-backend WHISPER_MODEL_SIZE
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

def validate_cnic(raw_cnic: str) -> str:
    """Normalize and validate a Pakistani CNIC. Returns canonical 13-digit string."""
    normalized = re.sub(r'[\s\-]', '', raw_cnic)
    if not normalized.isdigit():
        raise HTTPException(status_code=422, detail="CNIC must contain only digits (no letters or special characters).")
    if len(normalized) != 13:
        raise HTTPException(status_code=422, detail="CNIC must be exactly 13 digits.")
    return normalized

def validate_password(password: str):
    """Enforce minimum password requirements."""
    if len(password) < 8:
        raise HTTPException(status_code=422, detail="Password must be at least 8 characters.")

# --- PYDANTIC SCHEMAS (Matches React Exactly) ---
class UserSignup(BaseModel):
    cnic: str
    full_name: str
    phone_number: str
    password: str
    email: Optional[str] = None

class UserLogin(BaseModel):
    cnic: Optional[str] = None
    email: Optional[str] = None
    password: str

class ProfileUpdate(BaseModel):
    user_id: str
    full_name: Optional[str] = None
    phone_number: Optional[str] = None
    email: Optional[str] = None
    network_operator: Optional[str] = None

class PasswordChange(BaseModel):
    user_id: str
    current_password: str
    new_password: str

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
    enrollment = db.query(Enrollment).filter(Enrollment.user_id == normalized).first()
    return {
        "user_id": user.user_id,
        "cnic": user.cnic,
        "full_name": user.full_name,
        "phone_number": user.phone_number,
        "email": getattr(user, "email", None),
        "network_operator": user.network_operator,
        "is_enrolled": enrollment is not None,
        "enrollment_status": (enrollment.status or "ACTIVE") if enrollment else None,
        "audio_quality_snr": enrollment.audio_quality_snr if enrollment else None,
        "enrolled_at": enrollment.created_at.isoformat() if enrollment and enrollment.created_at else None,
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
    if payload.network_operator is not None:
        user.network_operator = payload.network_operator
    
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

@app.put("/profile/password")
async def change_password(payload: PasswordChange, db: Session = Depends(get_db)):
    """Changes the user's password after verifying the current one."""
    normalized = payload.user_id.replace("-", "").replace(" ", "").strip()
    user = db.query(User).filter(User.user_id == normalized).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found.")

    if not verify_password(payload.current_password, user.hashed_password):
        raise HTTPException(status_code=401, detail="Current password is incorrect.")

    validate_password(payload.new_password)

    user.hashed_password = get_password_hash(payload.new_password)
    db.add(user)
    db.commit()

    return {"status": "success", "message": "Password updated successfully."}



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
    
    # Strict check: user must already exist via /signup
    existing_user = db.query(User).filter(User.user_id == user_id).first()
    if not existing_user:
        raise HTTPException(status_code=404, detail="User not found. Please register via /signup first.")

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
            
            # Update existing user with optional SIM data (no duplicate INSERT)
            if phone_number:
                existing_user.phone_number = phone_number
            if imsi:
                existing_user.imei = imsi  # IMSI maps to imei column for SIM tracking
            db.add(existing_user)
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

@app.delete("/enroll")
async def revoke_enrollment(user_id: str, db: Session = Depends(get_db)):
    """Revokes a user's voice enrollment: deletes the DB record and the .pt template file."""
    normalized = user_id.replace("-", "").replace(" ", "").strip()
    enrollment = db.query(Enrollment).filter(Enrollment.user_id == normalized).first()
    if not enrollment:
        raise HTTPException(status_code=404, detail="No voice enrollment found for this user.")

    # Delete the .pt template file from disk
    template_path = enrollment.template_uri
    if template_path and os.path.exists(template_path):
        try:
            os.remove(template_path)
            print(f"[REVOKE] Deleted template file: {template_path}")
        except OSError as e:
            print(f"[REVOKE] Warning: could not delete template file: {e}")

    db.delete(enrollment)
    db.commit()

    return {"status": "success", "message": "Voice profile revoked successfully."}

@app.delete("/customers/enroll")
async def revoke_customer_enrollment(customer_cnic: str, db: Session = Depends(get_db)):
    """Permanently deletes a customer's voice enrollment, template file, and Customer record."""
    normalized = customer_cnic.replace("-", "").replace(" ", "").strip()

    # 1. Find and delete the CustomerEnrollment record
    enrollment = db.query(CustomerEnrollment).filter(
        CustomerEnrollment.customer_id == normalized
    ).first()

    if enrollment:
        # Delete the .pt template file from disk
        template_path = enrollment.template_uri
        if template_path and os.path.exists(template_path):
            try:
                os.remove(template_path)
                print(f"[CUSTOMER REVOKE] Deleted template file: {template_path}")
            except OSError as e:
                print(f"[CUSTOMER REVOKE] Warning: could not delete template file: {e}")
        db.delete(enrollment)

    # 2. Delete the Customer record itself
    customer = db.query(Customer).filter(Customer.customer_id == normalized).first()
    if not customer and not enrollment:
        raise HTTPException(status_code=404, detail="No customer enrollment found for this CNIC.")
    if customer:
        db.delete(customer)

    db.commit()
    return {"status": "success", "message": f"Customer {normalized} permanently deleted."}

# --- CUSTOMER ENROLLMENT (B2B — End-Users without dashboard accounts) ---

@app.post("/customers/enroll")
async def enroll_customer(
    background_tasks: BackgroundTasks,
    customer_cnic: str = Form(...),
    customer_name: str = Form(...),
    take_1: UploadFile = File(...),
    take_2: UploadFile = File(...),
    take_3: UploadFile = File(...),
    phone_number: Optional[str] = Form(None),
    network_operator: Optional[str] = Form(None),
    imei: Optional[str] = Form(None),
    admin_user_id: Optional[str] = Form(None),
    sandbox: bool = Form(False),
    db: Session = Depends(get_db)
):
    """Enrolls an external customer's voice. Auto-creates their Customer record if needed.
    
    When sandbox=True the ML pipeline runs normally but NO Customer or CustomerEnrollment
    rows are written to the database, and the generated .pt template is cleaned up
    automatically so the disk stays pristine.
    """
    # Normalize and validate the customer's CNIC
    normalized_cnic = validate_cnic(customer_cnic)

    # In sandbox mode skip the duplicate-enrollment guard (no DB record exists)
    if not sandbox:
        # Check if already enrolled
        existing_enrollment = db.query(CustomerEnrollment).filter(
            CustomerEnrollment.customer_id == normalized_cnic
        ).first()
        if existing_enrollment:
            raise HTTPException(status_code=400, detail="This customer is already enrolled.")

    # Resolve admin ownership
    resolved_admin_id = _normalize_cnic(admin_user_id) if admin_user_id else None

    if not sandbox:
        # Auto-create Customer record if it doesn't exist
        customer = db.query(Customer).filter(Customer.customer_id == normalized_cnic).first()
        if not customer:
            customer = Customer(
                customer_id=normalized_cnic,
                cnic=normalized_cnic,
                full_name=customer_name.strip() or None,
                phone_number=phone_number,
                network_operator=network_operator,
                imei=imei,
                admin_user_id=resolved_admin_id,
            )
            db.add(customer)
            db.flush()  # Ensure FK is available before enrollment insert
        else:
            # Update name if re-enrolling after revocation
            if customer_name.strip():
                customer.full_name = customer_name.strip()
            if phone_number:
                customer.phone_number = phone_number
            if network_operator:
                customer.network_operator = network_operator
            # Claim orphaned customer if no admin was previously set
            if resolved_admin_id and not customer.admin_user_id:
                customer.admin_user_id = resolved_admin_id
            db.add(customer)

    temp_files = []
    try:
        def convert_to_wav(upload_file, index):
            raw_path = f"data/temp/{normalized_cnic}_raw_{index}.webm"
            clean_path = f"data/temp/{normalized_cnic}_take_{index}.wav"
            with open(raw_path, "wb") as buffer:
                shutil.copyfileobj(upload_file.file, buffer)
            audio = AudioSegment.from_file(raw_path)
            audio = audio.set_frame_rate(16000).set_channels(1)
            audio.export(clean_path, format="wav")
            if os.path.exists(raw_path):
                os.remove(raw_path)
            return clean_path

        for i, file in enumerate([take_1, take_2, take_3]):
            temp_files.append(convert_to_wav(file, i))

        print(f"[CUSTOMER ENROLLMENT] Processing voice for customer: {normalized_cnic} (sandbox={sandbox})")
        success = models["enrollment_mgr"].create_multi_template(normalized_cnic, temp_files)

        if success:
            template_path = f"data/enrollments/{normalized_cnic}_baseline.pt"

            if sandbox:
                # Sandbox mode: ML ran successfully but we skip all DB writes.
                # Schedule the generated .pt file for background deletion so the
                # disk stays clean between sandbox runs.
                background_tasks.add_task(cleanup_temp_file, template_path)
                print(f"[SANDBOX] Enrollment complete — DB skipped, .pt scheduled for cleanup.")
                return {"status": "success", "message": f"[SANDBOX] Voice template generated for {normalized_cnic}. No DB record created."}

            new_enrollment = CustomerEnrollment(
                customer_id=normalized_cnic,
                template_uri=template_path,
            )
            db.add(new_enrollment)
            db.commit()

            return {"status": "success", "message": f"Customer {normalized_cnic} securely enrolled."}
        else:
            raise HTTPException(status_code=500, detail="Enrollment AI processing failed.")

    except HTTPException:
        raise
    except Exception as e:
        if not sandbox:
            db.rollback()
        print(f"Customer Enrollment Error: {e}")
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
    # Reject if running on SQLite fallback (no real persistence)
    if _using_sqlite:
        raise HTTPException(status_code=503, detail="Authentication service is temporarily unavailable. Please try again.")

    normalized_cnic = validate_cnic(user_data.cnic)
    validate_password(user_data.password)

    if db.query(User).filter(User.cnic == normalized_cnic).first():
        raise HTTPException(status_code=400, detail="CNIC already registered.")

    hashed_pw = get_password_hash(user_data.password)
    new_user = User(
        user_id=normalized_cnic,
        cnic=normalized_cnic,
        full_name=user_data.full_name,
        email=user_data.email,
        hashed_password=hashed_pw
    )
    
    db.add(new_user)
    db.commit()
    
    return {"status": "success", "message": f"Account for {user_data.full_name} created."}

@app.post("/login")
async def login(credentials: UserLogin, response: Response, db: Session = Depends(get_db)):
    """Authenticates a user via CNIC or email + password. Sets HttpOnly session cookie."""
    # Reject if running on SQLite fallback
    if _using_sqlite:
        raise HTTPException(status_code=503, detail="Authentication service is temporarily unavailable. Please try again.")

    raw_cnic = (credentials.cnic or "").strip()
    raw_email = (credentials.email or "").strip()

    if not raw_cnic and not raw_email:
        raise HTTPException(status_code=422, detail="CNIC or email is required.")

    user = None
    # Priority: CNIC first. If both are submitted, CNIC wins.
    if raw_cnic:
        normalized_cnic = validate_cnic(raw_cnic)
        user = db.query(User).filter(User.cnic == normalized_cnic).first()
    elif raw_email:
        user = db.query(User).filter(func.lower(User.email) == raw_email.lower()).first()

    if not user or not verify_password(credentials.password, user.hashed_password):
        raise HTTPException(status_code=401, detail="Invalid credentials.")

    if user.locked_out:
        raise HTTPException(status_code=403, detail="Account locked due to biometric failure.")

    enrollment = db.query(Enrollment).filter(Enrollment.user_id == user.user_id).first()
    is_enrolled = True if enrollment else False

    display_name = user.full_name or user.cnic

    # Generate real session token and store server-side
    session_token = str(uuid.uuid4())
    active_auth_sessions[session_token] = {
        "user_id": user.user_id,
        "cnic": user.cnic,
        "full_name": display_name,
    }

    # Set HttpOnly cookie (not accessible via JavaScript)
    response.set_cookie(
        key="session_token",
        value=session_token,
        httponly=True,
        samesite="lax",
        path="/",
        max_age=86400,  # 24 hours
    )

    return {
        "status": "success",
        "user_id": user.user_id,
        "cnic": user.cnic,
        "full_name": display_name,
        "is_enrolled": is_enrolled
    }

@app.get("/me")
async def get_current_user(request: Request, db: Session = Depends(get_db)):
    """Returns the currently authenticated user from the session cookie."""
    session_token = request.cookies.get("session_token")
    if not session_token or session_token not in active_auth_sessions:
        raise HTTPException(status_code=401, detail="Not authenticated.")

    session_data = active_auth_sessions[session_token]
    cnic = session_data["cnic"]

    enrollment = db.query(Enrollment).filter(Enrollment.user_id == cnic).first()
    is_enrolled = True if enrollment else False

    return {
        "user_id": session_data["user_id"],
        "cnic": session_data["cnic"],
        "full_name": session_data["full_name"],
        "is_enrolled": is_enrolled,
    }
    
@app.delete("/profile")
async def delete_account(
    request: Request,
    response: Response,
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Permanently deletes the authenticated agent and all their associated data.

    Deletion order (child before parent to satisfy FK constraints):
    1. AuthLog rows for each of the agent's customers (no FK, but clean up anyway).
    2. CustomerEnrollment rows for the agent's customers.
    3. Customer rows owned by the agent.
    4. Enrollment row for the agent (staff voice profile).
    5. AuditLog rows for the agent.
    6. User row for the agent.
    7. Invalidate the session cookie.
    """
    agent_cnic = current_user["cnic"]

    # --- 1. Find all customers this agent enrolled ---
    owned_customers = db.query(Customer).filter(
        Customer.admin_user_id == agent_cnic
    ).all()
    customer_ids = [c.customer_id for c in owned_customers]

    # --- 2. Delete AuthLog rows for those customers ---
    if customer_ids:
        db.query(AuthLog).filter(
            func.replace(AuthLog.cnic, "-", "").in_(customer_ids)
        ).delete(synchronize_session=False)

    # --- 3. Delete CustomerEnrollment rows ---
    if customer_ids:
        db.query(CustomerEnrollment).filter(
            CustomerEnrollment.customer_id.in_(customer_ids)
        ).delete(synchronize_session=False)

    # --- 4. Delete Customer rows ---
    if customer_ids:
        db.query(Customer).filter(
            Customer.customer_id.in_(customer_ids)
        ).delete(synchronize_session=False)

    # --- 5. Delete the agent's own Enrollment (staff voiceprint) ---
    db.query(Enrollment).filter(Enrollment.user_id == agent_cnic).delete(
        synchronize_session=False
    )

    # --- 6. Delete the agent's AuditLog rows ---
    db.query(AuditLog).filter(AuditLog.user_id == agent_cnic).delete(
        synchronize_session=False
    )

    # --- 7. Delete the User row ---
    db.query(User).filter(User.user_id == agent_cnic).delete(
        synchronize_session=False
    )

    db.commit()

    # Invalidate the session in memory and clear the cookie
    session_token = request.cookies.get("session_token")
    if session_token and session_token in active_auth_sessions:
        del active_auth_sessions[session_token]
    response.delete_cookie(key="session_token", path="/")

    return {"status": "success", "message": f"Account {agent_cnic} permanently deleted."}

@app.post("/logout")
async def logout(request: Request, response: Response):
    """Clears the session cookie and invalidates the server-side session."""
    session_token = request.cookies.get("session_token")
    if session_token and session_token in active_auth_sessions:
        del active_auth_sessions[session_token]
    response.delete_cookie(key="session_token", path="/")
    return {"status": "success", "message": "Logged out."}

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

# ECAPA-TDNN decision threshold (raw cosine similarity at the evaluated EER point).
# Shared by /authenticate/verify, /authenticate/continuous and the forensic log API.
ECAPA_EER_THRESHOLD = 0.2393


def _log_auth_attempt(
    db: Session,
    session_id: str,
    cnic: str,
    status: str,
    start_time: float,
    liveness_score: Optional[float] = None,
    match_confidence: Optional[float] = None,
    failure_reason: Optional[str] = None,
) -> None:
    """Insert a telemetry row into auth_logs (isolated commit)."""
    try:
        latency_ms = int((time.perf_counter() - start_time) * 1000)
        db.add(AuthLog(
            session_id=session_id,
            cnic=cnic,
            status=status,
            liveness_score=liveness_score,
            match_confidence=match_confidence,
            failure_reason=failure_reason,
            latency_ms=latency_ms,
        ))
        db.commit()
    except Exception as log_err:
        print(f"[AUTH LOG ERROR] Could not record attempt: {log_err}")
        db.rollback()

@app.post("/authenticate/verify")
async def verify_voice(
    background_tasks: BackgroundTasks,
    session_id: str = Form(...),
    user_id: str = Form(...),  # The CNIC
    voice: UploadFile = File(...),
    sandbox: bool = Form(False),
    db: Session = Depends(get_db)
):
    """Full Pipeline: Gatekeeper -> ASR Liveness -> Multi-Template ECAPA -> Database.
    
    When sandbox=True: the full ML pipeline executes normally but NO AuditLog or AuthLog
    rows are written to the database, and the {user_id}_baseline.pt template file is
    deleted from data/enrollments/ at the end of the request so sandbox runs are ephemeral.
    """
    start_time = time.perf_counter()
    
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
        # SHORT-CIRCUIT: If Gatekeeper fails, skip all
        # downstream ML inference (Whisper + ECAPA) to
        # avoid false-positive cosine scores from noise.
        # ==========================================
        if not is_secure:
            print(f"[SHORT-CIRCUIT] Gatekeeper failed: {security_msg}. Skipping ASR + ECAPA.")

            del active_sessions[session_id]

            final_response = {
                "authenticated": False,
                "similarity_score": 0.0,
                "raw_similarity": None,          # biometric stage never ran
                "threshold": ECAPA_EER_THRESHOLD,
                "liveness_score": 0.0,
                "liveness_passed": False,
                "risk_score": 0.9,
                "gatekeeper_score": 0.0,
                "session_id": session_id,
                "message": (
                    f"Gatekeeper FAIL: {security_msg}"
                    " | Liveness FAIL: Skipped — no human speech detected."
                    " | Biometric FAIL: Skipped — no human speech detected."
                ),
            }

            # Save to database (skipped in sandbox mode)
            if not sandbox:
                try:
                    expected_str = ",".join(map(str, expected_sequence))
                    new_log = AuditLog(
                        user_id=user_id,
                        coercion_detected=True,
                        expected_challenge=expected_str,
                        transcribed_text="[short-circuited — no speech]",
                        liveness_passed=False,
                        biometric_score=0.0,
                        status="DENIED_COERCION",
                    )
                    db.add(new_log)
                    db.commit()
                    print("[DATABASE] Short-circuit session saved.")
                except Exception as db_err:
                    print(f"[DATABASE ERROR] Could not save session: {db_err}")
                    db.rollback()

                # Gatekeeper failure counts as a blocked threat
                _log_auth_attempt(
                    db, session_id, user_id, "FAIL", start_time,
                    failure_reason=f"Gatekeeper Rejected: {security_msg}",
                )
            else:
                print("[SANDBOX] Gatekeeper short-circuit — DB write skipped.")

            return final_response

        # ==========================================
        # STEP 1: LIVENESS DETECTION (Preloaded ASR)
        # — Only runs if Gatekeeper passed —
        # ==========================================
        asr_transcription = models["asr"].transcribe(clean_path) 
        liveness_result = models["validator"].evaluate_challenge(expected_sequence, asr_transcription)
        liveness_passed = bool(liveness_result["liveness_passed"])
        liveness_score = liveness_result["confidence_score"] / 100

        # ==========================================
        # STEP 2: BIOMETRIC VERIFICATION (ECAPA-TDNN)
        # — Only runs if Gatekeeper passed —
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
        OPTIMAL_THRESHOLD = ECAPA_EER_THRESHOLD
        is_match = ai_similarity_score >= OPTIMAL_THRESHOLD

        if is_match:
            ux_score = 0.80 + ((ai_similarity_score - OPTIMAL_THRESHOLD) / (1.0 - OPTIMAL_THRESHOLD)) * 0.20
        else:
            ux_score = ((ai_similarity_score - (-1.0)) / (OPTIMAL_THRESHOLD - (-1.0))) * 0.79 
        ux_score = max(0.0, min(1.0, ux_score))

        # ==========================================
        # CONSOLIDATED DECISION (Full Evaluation)
        # ==========================================
        authenticated = liveness_passed and is_match

        # Build denial reason (if any)
        if authenticated:
            denial_msg = "Identity Verified."
            risk = 0.1
        else:
            reasons = []
            if not liveness_passed:
                reasons.append(f"Liveness FAIL: {liveness_result['status_message']}")
            if not is_match:
                reasons.append("Biometric FAIL: Voice did not match baseline.")
            denial_msg = " | ".join(reasons)
            risk = 0.7 if not liveness_passed else 0.8

        # Determine final audit status
        if authenticated:
            audit_status = "GRANTED"
        elif not liveness_passed:
            audit_status = "DENIED_LIVENESS"
        else:
            audit_status = "DENIED_BIOMETRIC"

        del active_sessions[session_id]
        
        final_response = {
            "authenticated": bool(authenticated),
            "similarity_score": float(ux_score),
            "raw_similarity": round(float(ai_similarity_score), 4),   # ECAPA cosine
            "threshold": ECAPA_EER_THRESHOLD,
            "liveness_score": float(liveness_score),
            "liveness_passed": bool(liveness_passed),
            "risk_score": float(risk),
            "gatekeeper_score": float(gatekeeper_score),
            "session_id": session_id,
            "message": denial_msg
        }

        # ==========================================
        # STEP 3: SAVE TO DATABASE (Updates Dashboard!)
        # Skipped entirely when sandbox=True.
        # ==========================================
        if not sandbox:
            try:
                expected_str = ",".join(map(str, expected_sequence))
                new_log = AuditLog(
                    user_id=user_id,
                    coercion_detected=False,
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

            # PASS only if both Liveness and ECAPA-TDNN succeeded
            if authenticated:
                _log_auth_attempt(
                    db, session_id, user_id, "PASS", start_time,
                    liveness_score=float(liveness_score),
                    match_confidence=float(ux_score),
                )
            elif not liveness_passed:
                _log_auth_attempt(
                    db, session_id, user_id, "FAIL", start_time,
                    liveness_score=float(liveness_score),
                    failure_reason="Liveness Failed (Incorrect Digits)",
                )
            else:
                _log_auth_attempt(
                    db, session_id, user_id, "FAIL", start_time,
                    liveness_score=float(liveness_score),
                    match_confidence=float(ux_score),
                    failure_reason="Biometric Mismatch",
                )
        else:
            print("[SANDBOX] Verification complete — DB write and auth log skipped.")
            # Clean up the sandbox .pt template file from disk
            pt_path = f"data/enrollments/{user_id.replace(' ', '_')}_baseline.pt"
            try:
                os.remove(pt_path)
                print(f"[SANDBOX] Cleaned up template file: {pt_path}")
            except OSError:
                pass  # File may not exist (e.g. enroll also ran in sandbox and already cleaned up)

        return final_response

    except Exception as e:
        print(f"Verification Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        for f in temp_files: cleanup_temp_file(f)


@app.post("/authenticate/continuous")
async def continuous_verify(
    session_id: str = Form("continuous"),
    user_id: str = Form(...),  # The CNIC
    voice: UploadFile = File(...),
    db: Session = Depends(get_db)
):
    """Continuous (step-up) authentication for an already signed-in user.

    Runs Gatekeeper -> ECAPA-TDNN on free speech (e.g. a spoken banking command).
    There is no digit challenge, so active liveness is skipped and no session from
    /authenticate/challenge is required. Initial login must still use /authenticate/verify.
    """
    start_time = time.perf_counter()
    user_id = _normalize_cnic(user_id)
    request_id = f"{session_id}:{uuid.uuid4().hex[:8]}"  # unique per call; session_id may be constant

    template_path = f"data/enrollments/{user_id.replace(' ', '_')}_baseline.pt"
    if not os.path.exists(template_path):
        raise HTTPException(status_code=404, detail="User biometric template not found.")

    raw_path = f"data/temp/{request_id.replace(':', '_')}_raw"
    clean_path = f"data/temp/{request_id.replace(':', '_')}_cont.wav"
    try:
        with open(raw_path, "wb") as buffer:
            shutil.copyfileobj(voice.file, buffer)
        audio = AudioSegment.from_file(raw_path)
        audio.set_frame_rate(16000).set_channels(1).export(clean_path, format="wav")

        # STEP 0: Gatekeeper (multi-speaker / splicing / no speech)
        is_secure, security_msg = models["gatekeeper"].check_audio_security(clean_path)
        if not is_secure:
            _log_auth_attempt(db, request_id, user_id, "FAIL", start_time,
                              failure_reason=f"Continuous Auth: Gatekeeper Rejected: {security_msg}")
            return {
                "authenticated": False,
                "mode": "continuous",
                "similarity_score": 0.0,
                "raw_similarity": None,
                "threshold": ECAPA_EER_THRESHOLD,
                "gatekeeper_score": 0.0,
                "session_id": session_id,
                "message": f"Gatekeeper FAIL: {security_msg}",
            }

        # STEP 1: ECAPA-TDNN match against every stored template
        try:
            saved_templates = torch.load(template_path, map_location="cpu", weights_only=False)
        except Exception:
            saved_templates = torch.load(template_path, map_location="cpu")

        if isinstance(saved_templates, dict):
            candidates = list(saved_templates.values())
        elif isinstance(saved_templates, torch.Tensor):
            candidates = [saved_templates] if saved_templates.ndim == 1 else list(saved_templates)
        else:
            candidates = list(saved_templates)

        templates = []
        for t in candidates:
            try:
                arr = t.detach().cpu().numpy().flatten() if hasattr(t, "detach") else np.array(t).flatten()
                if arr.shape[0] == 192:
                    templates.append(arr)
            except Exception:
                pass
        if not templates:
            raise HTTPException(status_code=500, detail="No valid 192-dim voice prints found.")

        live = np.array(models["ecapa"].extract_embedding(clean_path)).flatten()
        raw_score = max(
            float(np.dot(live, t) / (np.linalg.norm(live) * np.linalg.norm(t))) for t in templates
        )

        OPTIMAL_THRESHOLD = ECAPA_EER_THRESHOLD
        is_match = raw_score >= OPTIMAL_THRESHOLD
        if is_match:
            ux_score = 0.80 + ((raw_score - OPTIMAL_THRESHOLD) / (1.0 - OPTIMAL_THRESHOLD)) * 0.20
        else:
            ux_score = ((raw_score + 1.0) / (OPTIMAL_THRESHOLD + 1.0)) * 0.79
        ux_score = max(0.0, min(1.0, ux_score))

        if is_match:
            _log_auth_attempt(db, request_id, user_id, "PASS", start_time, match_confidence=float(ux_score))
        else:
            _log_auth_attempt(db, request_id, user_id, "FAIL", start_time, match_confidence=float(ux_score),
                              failure_reason="Continuous Auth: Biometric Mismatch")

        return {
            "authenticated": bool(is_match),
            "mode": "continuous",
            "similarity_score": float(ux_score),
            "raw_similarity": round(float(raw_score), 4),
            "threshold": ECAPA_EER_THRESHOLD,
            "gatekeeper_score": 1.0,
            "session_id": session_id,
            "message": "Identity Verified." if is_match else "Biometric FAIL: Voice did not match baseline.",
        }

    except HTTPException:
        raise
    except Exception as e:
        print(f"Continuous Verification Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        for f in (raw_path, clean_path):
            cleanup_temp_file(f)

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


def _scoped_customer_enrollments(db: Session, user_id: Optional[str]):
    """Single source of truth for 'Enrolled Profiles' — used by BOTH the
    Voice Enrollment table and the dashboard count so they can never drift.

    - Super Admin            -> all customer enrollments
    - Standard agent         -> only customers where admin_user_id == agent
    - No user_id (anonymous) -> nothing (fail closed, no global leak)
    """
    query = db.query(CustomerEnrollment, Customer).join(
        Customer, CustomerEnrollment.customer_id == Customer.customer_id
    )
    if not user_id:
        return query.filter(false())
    if not _is_super_admin(user_id):
        query = query.filter(Customer.admin_user_id == _normalize_cnic(user_id))
    return query


@app.get("/enrollments")
async def get_enrollments(
    user_id: Optional[str] = None,  # Accepted for frontend compatibility; IGNORED (spoofable).
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Returns enrolled customer profiles only (excludes internal admin/staff accounts).
    Super Admin sees ALL customer enrollments; standard user sees only their own customers.
    Identity is taken from the session cookie, never from the query string."""
    secure_id = current_user["cnic"]
    try:
        enrollments_data = []

        cust_results = (
            _scoped_customer_enrollments(db, secure_id)
            .order_by(CustomerEnrollment.id.desc())
            .all()
        )
        for enrollment, customer in cust_results:
            enrollments_data.append({
                "user_id": customer.customer_id,
                "full_name": customer.full_name,
                "phone_number": customer.phone_number,
                "network_operator": customer.network_operator,
                "enrolled_at": enrollment.created_at.isoformat() if enrollment.created_at else None,
                "audio_quality_snr": enrollment.audio_quality_snr,
                "status": enrollment.status or "ACTIVE",
                "embedding_dim": enrollment.embedding_dim,
                "type": "customer",
            })

        return {"enrollments": enrollments_data}
    except Exception as e:
        print(f"Failed to fetch enrollments: {e}")
        return {"enrollments": []}

    
@app.get("/stats/enrollments")
async def get_enrollment_count(
    user_id: Optional[str] = None,  # IGNORED (spoofable).
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Returns the number of enrolled customer profiles visible to the caller."""
    secure_id = current_user["cnic"]
    try:
        count = _scoped_customer_enrollments(db, secure_id).count()
        return {"total_enrollments": count}
    except Exception as e:
        print(f"[STATS] Error counting enrollments: {e}")
        return {"total_enrollments": 0}

def _scoped_auth_logs(db: Session, user_id: Optional[str]):
    """Single source of truth for AuthLog visibility (dashboard + Logs page).

    - Super Admin            -> all auth logs (global system view)
    - Standard agent         -> only attempts by customers they enrolled
    - No user_id (anonymous) -> nothing (fail closed)

    AuthLog.cnic may be stored dashed or undashed, while Customer.customer_id
    is always the normalized CNIC, so dashes are stripped in the join.
    """
    query = db.query(AuthLog)
    if not user_id:
        return query.filter(false())
    if not _is_super_admin(user_id):
        query = query.join(
            Customer, func.replace(AuthLog.cnic, "-", "") == Customer.customer_id
        ).filter(Customer.admin_user_id == _normalize_cnic(user_id))
    return query


@app.get("/dashboard/stats")
async def get_dashboard_stats(
    user_id: Optional[str] = None,  # IGNORED (spoofable).
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Aggregated dashboard metrics: scale + threat prevention (RBAC-scoped)."""
    secure_id = current_user["cnic"]
    try:
        verification_attempts = _scoped_auth_logs(db, secure_id).count()
        threats_blocked = _scoped_auth_logs(db, secure_id).filter(AuthLog.status == "FAIL").count()
        # Must match GET /enrollments exactly (same join + same scoping).
        total_enrollments = _scoped_customer_enrollments(db, secure_id).count()
    except Exception as e:
        print(f"[STATS] Error computing dashboard stats: {e}")
        verification_attempts = threats_blocked = total_enrollments = 0

    return {
        "verification_attempts": verification_attempts,
        "threats_blocked": threats_blocked,
        "active_sessions": len(active_sessions),
        "total_enrollments": total_enrollments,
    }

# Next.js rewrites /api/:path* -> backend /:path*, so expose both paths.
def _raw_cosine_from_confidence(ux: Optional[float]) -> Optional[float]:
    """Invert the UX calibration used by the verify routes to recover raw cosine similarity.

    Forward mapping (see /authenticate/verify):
        match     : ux = 0.80 + (cos - T) / (1 - T) * 0.20      -> ux in [0.80, 1.00]
        non-match : ux = (cos + 1) / (T + 1) * 0.79             -> ux in [0.00, 0.79]
    Both branches are linear and disjoint, so the inverse is exact (except where
    the forward pass clamped at 0.0 / 1.0). No schema change is needed.
    """
    if ux is None:
        return None
    t = ECAPA_EER_THRESHOLD
    raw = t + (ux - 0.80) / 0.20 * (1.0 - t) if ux >= 0.80 else ux / 0.79 * (t + 1.0) - 1.0
    return round(max(-1.0, min(1.0, raw)), 4)


def _classify_auth_log(status: Optional[str], reason: Optional[str]) -> tuple[str, Optional[str]]:
    """(verdict, blocked_stage) for an AuthLog row.

    verdict: PASS | BLOCKED_BIOMETRIC | BLOCKED_LIVENESS | FAIL
    blocked_stage: gatekeeper | liveness | biometric | None
    """
    if (status or "").upper() == "PASS":
        return "PASS", None
    r = (reason or "").lower()
    if any(k in r for k in ("gatekeeper", "replay", "speaker", "silence", "no human speech")):
        return "BLOCKED_LIVENESS", "gatekeeper"
    if "liveness" in r or "incorrect digits" in r:
        return "BLOCKED_LIVENESS", "liveness"
    if "biometric" in r or "mismatch" in r:
        return "BLOCKED_BIOMETRIC", "biometric"
    return "FAIL", None


def _auth_channel(session_id: Optional[str], reason: Optional[str]) -> str:
    """'command' for per-transaction continuous auth (request ids look like
    'tx_command:ab12cd34'), otherwise 'login' (challenge-response UUID sessions)."""
    if (session_id and ":" in session_id) or (reason or "").startswith("Continuous Auth"):
        return "command"
    return "login"


@app.get("/logs")
@app.get("/api/logs")
async def get_auth_logs(
    user_id: Optional[str] = None,  # IGNORED (spoofable).
    current_user: dict = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Returns AuthLog telemetry records visible to the caller, newest first,
    enriched with forensic fields derived from the stored telemetry."""
    secure_id = current_user["cnic"]
    try:
        rows = _scoped_auth_logs(db, secure_id).order_by(desc(AuthLog.timestamp)).all()
        logs = []
        for r in rows:
            verdict, blocked_stage = _classify_auth_log(r.status, r.failure_reason)
            similarity = _raw_cosine_from_confidence(r.match_confidence)
            logs.append({
                "id": r.id,
                "session_id": r.session_id,
                "cnic": r.cnic,
                "status": r.status,
                "verdict": verdict,
                "blocked_stage": blocked_stage,
                "channel": _auth_channel(r.session_id, r.failure_reason),
                "similarity_score": similarity,               # raw ECAPA cosine
                "threshold": ECAPA_EER_THRESHOLD,
                "similarity_margin": round(similarity - ECAPA_EER_THRESHOLD, 4) if similarity is not None else None,
                "match_confidence": r.match_confidence,       # UX-calibrated 0–1
                "liveness_score": r.liveness_score,
                "failure_reason": r.failure_reason,
                "latency_ms": r.latency_ms,
                "timestamp": r.timestamp.isoformat() if r.timestamp else None,
            })
        return {"logs": logs}
    except Exception as e:
        print(f"[LOGS] Error fetching auth logs: {e}")
        return {"logs": []}

@app.get("/enroll/check/{cnic}")
async def check_enrollment_status(cnic: str, db: Session = Depends(get_db)):
    """Lightweight pre-auth gate: checks if a CNIC has a usable voiceprint.
    Returns {enrolled: bool, source: str} without loading any ML models."""

    normalized = _normalize_cnic(cnic)

    # 1. Check if the .pt voiceprint file exists on disk
    template_path = f"data/enrollments/{normalized}_baseline.pt"
    has_file = os.path.exists(template_path)

    # 2. Check database records (CustomerEnrollment OR admin Enrollment)
    db_source = None
    try:
        cust_enrollment = (
            db.query(CustomerEnrollment)
            .filter(CustomerEnrollment.customer_id == normalized)
            .first()
        )
        if cust_enrollment and cust_enrollment.status == "ACTIVE":
            db_source = "customer"

        if not db_source:
            admin_enrollment = (
                db.query(Enrollment)
                .filter(Enrollment.user_id == normalized)
                .first()
            )
            if admin_enrollment and admin_enrollment.status == "ACTIVE":
                db_source = "admin"
    except Exception as e:
        print(f"[ENROLL CHECK] DB query error: {e}")

    # Both file AND db record must exist for a valid enrollment
    enrolled = has_file and db_source is not None

    return {
        "enrolled": enrolled,
        "source": db_source or "none",
        "has_voiceprint_file": has_file,
        "cnic": normalized,
    }

@app.get("/enroll/status")
async def get_mock_enrollment():
    """Feeds the Dashboard Enrollment Banner."""
    return {"enrollment": {
        "is_enrolled": True, 
        "enrollment_date": datetime.datetime.now().isoformat(), 
        "confidence_score": 0.99
    }}


# ── Enterprise B2B Mock Verification Endpoint ──────────────────────────────
# This route simulates the public-facing API a B2B client would call.
# It does NOT run the real ML pipeline — it validates the payload shape
# and returns a realistic response after a simulated 1-second processing delay.

class EnterpriseVerifyRequest(BaseModel):
    cnic: Optional[str] = None
    audio_url: Optional[str] = None
    # Allow extra fields so the sandbox textarea accepts arbitrary JSON
    model_config = {"extra": "allow"}

@app.post("/api/v1/verify")
async def enterprise_verify(payload: EnterpriseVerifyRequest):
    """Mock enterprise verification endpoint for B2B integration demos.

    Accepts any JSON body containing at minimum a `cnic` and `audio_url`.
    Simulates a 1-second pipeline delay and returns a PASS decision with
    realistic confidence scores — no ML models are invoked.
    """
    await asyncio.sleep(1)          # simulate ML pipeline latency

    transaction_id = str(uuid.uuid4())
    timestamp = datetime.datetime.utcnow().isoformat() + "Z"

    return {
        "status": "success",
        "transaction_id": transaction_id,
        "result": "PASS",
        "confidence_score": 0.92,
        "liveness_detected": True,
        "pipeline": {
            "gatekeeper": {"passed": True, "speakers_detected": 1},
            "liveness": {"passed": True, "score": 0.97, "method": "active-challenge"},
            "biometric": {"passed": True, "cosine_similarity": 0.92, "model": "ECAPA-TDNN"},
        },
        "input_received": {
            "cnic": payload.cnic,
            "audio_url": payload.audio_url,
        },
        "timestamp": timestamp,
    }

