import os
import time
import sys
import os
# This forces Python to look in the main project folder for 'src'
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

import time
from src.verification.gatekeeper import SecurityGatekeeper
# ... the rest of your imports ...
# Import your actual classes based on your codebase
from src.verification.gatekeeper import SecurityGatekeeper
from src.verification.ecapa_engine import EcapaVerifier
import warnings
import logging

# Ignore standard Python warnings (like deprecation and future warnings)
warnings.filterwarnings("ignore")

# Silence Pyannote/SpeechBrain/Lightning specific logging warnings
logging.getLogger("pyannote").setLevel(logging.ERROR)
logging.getLogger("speechbrain").setLevel(logging.ERROR)
logging.getLogger("pytorch_lightning").setLevel(logging.ERROR)
# Fallback in case simulator isn't fully ready for the demo script yet
try:
    from src.audio.simulator import AudioSimulator
    HAS_SIMULATOR = True
except ImportError:
    HAS_SIMULATOR = False


def run_live_demo(enrollment_audio, live_test_audio, hf_token, threshold=0.2325):
    print("\n" + "="*60)
    print(" 🚀 AWAAZONBOARD: ENTERPRISE SYSTEM DEMONSTRATION")
    print("="*60)

    # ---------------------------------------------------------
    # STEP 1: INITIALIZATION
    # ---------------------------------------------------------
    print("\n[SYSTEM] Initializing Core Architecture...")
    time.sleep(1) # Added slight delays for dramatic effect in the console
    
    # 1. Init Gatekeeper
    gatekeeper = SecurityGatekeeper(hf_token=hf_token)
    
    # 2. Init ECAPA-TDNN (Injecting your fine-tuned weights)
    weights_path = "models/best_urdu_triplet_ecapa.pth"
    verifier = EcapaVerifier(finetuned_weights_path=weights_path)
    
    print("✅ All modules online. Strict EER Threshold set to:", threshold)


    # ---------------------------------------------------------
    # STEP 2: ENROLLMENT & PROFILING
    # ---------------------------------------------------------
    print(f"\n[ENROLLMENT] Processing user audio: {enrollment_audio}")
    time.sleep(1)
    
    enrollment_profiles = {}
    
    if HAS_SIMULATOR:
        simulator = AudioSimulator()
        # Assuming your simulator generates these and returns a dictionary of paths
        enrollment_profiles = simulator.generate_profiles(enrollment_audio)
        print("[ENROLLMENT] Multi-Condition Profiles Generated (Clean, 8kHz, 15dB)")
    else:
        # Fallback if simulator isn't linked: Just use the clean audio
        enrollment_profiles = {"Profile_Clean": enrollment_audio}
        print("[ENROLLMENT] Single Clean Profile Registered.")


    # ---------------------------------------------------------
    # STEP 3: PRE-VERIFICATION GATEKEEPER
    # ---------------------------------------------------------
    print(f"\n[GATEKEEPER] Scanning live incoming audio: {live_test_audio}")
    time.sleep(1.5)
    
    # Calling your exact method from gatekeeper.py
    passed, msg = gatekeeper.check_audio_security(live_test_audio)
    
    if not passed:
        print(f"❌ [SECURITY ALERT] {msg}")
        print("⛔ VERIFICATION ABORTED. Coercion or unauthorized audio detected.")
        print("="*60 + "\n")
        return

    print(f"✅ [SECURITY CLEARED] {msg}")


    # ---------------------------------------------------------
    # STEP 4: VERIFICATION & CROSS-MATCHING
    # ---------------------------------------------------------
    print("\n[VERIFICATION] Computing High-Dimensional Cosine Similarity...")
    time.sleep(1)
    
    max_score = -1.0
    best_profile = ""
    is_final_match = False

    # Loop through all saved profiles (Clean, Noisy, Filtered) and test against the live audio
    for profile_name, profile_path in enrollment_profiles.items():
        # Calling your exact method from ecapa_engine.py
        score, is_match = verifier.verify_pair(profile_path, live_test_audio, custom_threshold=threshold)
        
        print(f"   ↳ vs {profile_name.ljust(15)} | Score: {score:.4f} | Match: {is_match}")
        
        # MAX() Logic: Take the highest score across all profiles
        if score > max_score:
            max_score = score
            best_profile = profile_name
            is_final_match = is_match


    # ---------------------------------------------------------
    # STEP 5: FINAL DECISION
    # ---------------------------------------------------------
    print("\n" + "="*60)
    print(" 📊 FINAL SYSTEM DECISION")
    print("="*60)
    
    print(f"Highest Confidence Profile : {best_profile}")
    print(f"Peak Cosine Similarity     : {max_score:.4f}")
    print(f"System Threshold           : {threshold}")

    if is_final_match:
        print("\n🟢 ACCESS GRANTED: Speaker Identity Verified.")
    else:
        print("\n🔴 ACCESS DENIED: Identity Mismatch.")
    print("="*60 + "\n")


if __name__ == "__main__":
    # Insert your HuggingFace token for pyannote
    HF_TOKEN = "hf_your_token_here" 
    
    # Paths to your test files. (Update these to real .wav files in your data folder!)
    ENROLLMENT_WAV = "data/samples/Haris_Sample.wav"
    LIVE_TEST_WAV = "data/samples/Haris_Sample_Rough.wav"
    
    if os.path.exists(ENROLLMENT_WAV) and os.path.exists(LIVE_TEST_WAV):
        # We pass 0.2325 directly as you found in your console output!
        run_live_demo(ENROLLMENT_WAV, LIVE_TEST_WAV, HF_TOKEN, threshold=0.2325)
    else:
        print(f"⚠️ ERROR: Could not find audio files.\nCheck paths:\n1. {ENROLLMENT_WAV}\n2. {LIVE_TEST_WAV}")