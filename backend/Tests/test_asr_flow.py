import sys
import os
import time
import numpy as np
import sounddevice as sd
import soundfile as sf
from scipy.io.wavfile import write
from pydub import AudioSegment
import torch
import torchaudio
import warnings
from dotenv import load_dotenv

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

# Add the 'backend' folder to Python's path so we can import 'src'
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# --- IMPORT YOUR ACTUAL MODULES ---
from src.verification.gatekeeper import SecurityGatekeeper
from src.verification.digit_asr import UrduASRInference
from src.verification.liveness_validator import LivenessValidator
from src.verification.ecapa_engine import EcapaVerifier
from src.verification.challenge_generator import ChallengeGenerator

# --- CONFIGURATION ---
SAMPLE_RATE = 16000
DURATION = 5
USER_ID = "test_user_001" # Ensure this user has an enrollment file
MASTER_TEMPLATE = f"data/enrollments/{USER_ID}_baseline.pt"

def cosine_sim(a, b):
    return np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b))

def run_engine_test():
    print("="*50)
    print("🚀 INITIALIZING AWAAZ-ONBOARD CORE ENGINE")
    print("="*50)
    
    if not os.path.exists(MASTER_TEMPLATE):
        print(f"❌ ERROR: Master template missing at {MASTER_TEMPLATE}")
        print("Please run an enrollment first before testing verification.")
        return
    load_dotenv()
    hf_token = os.getenv("HF_TOKEN")
    # 1. Load Models 
    print("\n🧠 Loading AI Models into RAM...")
    gatekeeper = SecurityGatekeeper(hf_token)
    asr = UrduASRInference() # Updated class name
    validator = LivenessValidator() # Updated class name
    ecapa = EcapaVerifier() # Updated class name
    challenge_gen = ChallengeGenerator()
    
    # 2. Cache Audio Digits
    print("🎙️ Caching Audio Assets...")
    audio_cache = {}
    for i in range(10):
        audio_cache[str(i)] = AudioSegment.from_wav(f"data/audio_digits/{i}.wav")
    audio_cache["silence"] = AudioSegment.silent(duration=500)
    print("✅ System Ready.\n")

    # 3. Generate & Stitch Challenge
    challenge_data = challenge_gen.generate_numeric_challenge(length=3)
    challenge_str = ",".join(map(str, challenge_data))
    
    print(f"--- STEP 1: Spoken Challenge ---")
    print(f"Generated Sequence: {challenge_str}")
    
    combined = AudioSegment.empty()
    for d in challenge_data:
        combined += audio_cache[str(d)] + audio_cache["silence"]
    
    prompt_path = "data/temp/local_prompt.wav"
    combined.export(prompt_path, format="wav")
    
    print("🔊 Playing Challenge Prompt...")
    os.startfile(prompt_path) # Plays audio natively on Windows
    time.sleep(3) # Wait for audio to finish playing
    
    # 4. Record User Response
    print(f"\n--- STEP 2: Recording Response ---")
    print(f"🎤 Speak these numbers clearly: {challenge_str}")
    print("🔴 RECORDING STARTED...")
    
    # Int16 dtype fix is applied here to prevent crashes
    recording = sd.rec(int(DURATION * SAMPLE_RATE), samplerate=SAMPLE_RATE, channels=1, dtype=np.int16)
    sd.wait()
    print("🟩 RECORDING STOPPED.")
    
    response_path = "data/temp/local_response.wav"
    write(response_path, SAMPLE_RATE, recording)

    # 5. THE GAUNTLET
    print(f"\n--- STEP 3: The AI Gauntlet ---")
    
    # Stage A: Gatekeeper
    print("🛡️ Checking Coercion/Liveness (Gatekeeper)...")
    is_live, msg = gatekeeper.check_liveness(response_path)
    if not is_live:
        print(f"❌ DENIED BY GATEKEEPER: {msg}")
        return
    print("✅ Gatekeeper Passed.")
    
    # Stage B: ASR
    print("\n📝 Transcribing Audio (Whisper)...")
    transcription = asr.transcribe(response_path)
    print(f"Heard: '{transcription}'")
    
    val_result = validator.evaluate_challenge(challenge_data, transcription)
    if not val_result["liveness_passed"]:
        print(f"❌ DENIED BY ASR: {val_result['status_message']}")
        return
    print("✅ Active Liveness Passed.")

    # Stage C: ECAPA Biometrics
    print("\n🧬 Extracting Biometrics (ECAPA-TDNN)...")
    try: 
        master_dict = torch.load(MASTER_TEMPLATE, weights_only=False)
    except: 
        master_dict = torch.load(MASTER_TEMPLATE)
        
    emb_clean = np.array(master_dict["clean"].detach().cpu().numpy()).flatten()
    emb_telephony = np.array(master_dict["telephony"].detach().cpu().numpy()).flatten()
    emb_live = np.array(ecapa.extract_embedding(response_path)).flatten()

    score = float(max(cosine_sim(emb_clean, emb_live), cosine_sim(emb_telephony, emb_live)))
    
    print(f"Biometric Score: {score:.4f} (Threshold: 0.2393)")
    if score >= 0.2393:
        print("\n🎉 VERIFICATION SUCCESSFUL! IDENTITY CONFIRMED. 🎉")
    else:
        print("\n🚫 VERIFICATION FAILED! IDENTITY MISMATCH. 🚫")

    # Cleanup
    if os.path.exists(prompt_path): os.remove(prompt_path)
    if os.path.exists(response_path): os.remove(response_path)

if __name__ == "__main__":
    os.makedirs("data/temp", exist_ok=True)
    run_engine_test()