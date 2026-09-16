import sys
import os
from dotenv import load_dotenv
import torch
import torchaudio
import soundfile as sf
import numpy as np

# --- PATH FIX ---
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

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
from src.verification.gatekeeper import SecurityGatekeeper
from src.verification.digit_asr import UrduASRInference
from src.verification.liveness_validator import LivenessValidator
from src.verification.ecapa_engine import EcapaVerifier

def cosine_sim(a, b):
    return np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b))

def main():
    print("🚀 Booting up the Ultimate Gauntlet (Loading all Models into RAM)...")
    
    # 1. Load Models (This simulates FastAPI startup)
    load_dotenv()
    hf_token = os.getenv("HF_TOKEN")
    
    gatekeeper = SecurityGatekeeper(hf_token)
    asr = UrduASRInference(model_size="base")
    validator = LivenessValidator(pass_threshold=0.80)
    verifier = EcapaVerifier(finetuned_weights_path="models/best_urdu_triplet_ecapa.pth")
    
    print("\n✅ All models loaded successfully! Server is ready.")
    print("--------------------------------------------------")
    
    # --- SIMULATE THE LIVE API REQUEST ---
    # Put a test file here where you are actually speaking!
    test_file = "data/samples/Haseeb_Sample_Clean.wav" 
    master_template = "data/enrollments/Haseeb_001_baseline.pt"
    
    # Mocking the Challenge Generator: Let's pretend the system asked you to say "2, 4, 5"
    system_challenge = [2, 4, 5] 
    
    if not os.path.exists(test_file):
        print(f"❌ Error: Test file {test_file} not found.")
        return
        
    print(f"📥 Incoming Live Call: {test_file}")
    
    # --- STAGE 1: Gatekeeper Check ---
    print("🛡️ STAGE 1: Gatekeeper Check...")
    is_live, msg = gatekeeper.check_audio_security(test_file)
    if not is_live:
        print(f"❌ REJECTED: {msg}")
        return
    print("  -> Passed! (Single human detected)")
        
    # --- STAGE 2: ASR & Liveness Check ---
    print("🗣️ STAGE 2: ASR Transcription & Challenge Validation...")
    transcribed_sequence = asr.transcribe(test_file)
    print(f"  -> Heard: {transcribed_sequence}")
    
    validation_result = validator.evaluate_challenge(system_challenge, transcribed_sequence)
    if not validation_result["liveness_passed"]:
        print(f"❌ REJECTED: {validation_result['status_message']}")
        print(f"  -> Confidence: {validation_result['confidence_score']}%")
        # NOTE: For testing memory/ECAPA without recording a new file, you can comment out the 'return' below.
        #return 
    print(f"  -> Passed! (Confidence: {validation_result['confidence_score']}%)")
        
    # --- STAGE 3: ECAPA Verification ---
    print("🧬 STAGE 3: ECAPA Biometric Verification...")
    try:
        master_dict = torch.load(master_template, weights_only=False)
    except Exception:
        master_dict = torch.load(master_template)
        
    emb_clean = np.array(master_dict["clean"].detach().cpu().numpy()).flatten()
    emb_telephony = np.array(master_dict["telephony"].detach().cpu().numpy()).flatten()
    emb_live = np.array(verifier.extract_embedding(test_file)).flatten()

    # Max-Pooling against the multi-template dictionary
    score = max(cosine_sim(emb_clean, emb_live), cosine_sim(emb_telephony, emb_live))
    
    if score >= 0.2393:
        print(f"\n✅ ACCESS GRANTED (Score: {score:.4f})")
    else:
        print(f"\n❌ ACCESS DENIED (Score: {score:.4f})")

if __name__ == "__main__":
    main()