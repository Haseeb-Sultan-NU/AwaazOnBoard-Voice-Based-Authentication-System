import os
import sys
import warnings
from dotenv import load_dotenv

# ==========================================
# 🛑 SILENCE ALL DEPENDENCY WARNINGS 🛑
# ==========================================
warnings.filterwarnings("ignore", category=UserWarning)
os.environ["PYTHONWARNINGS"] = "ignore"
import logging
logging.getLogger("pyannote").setLevel(logging.ERROR)
logging.getLogger("speechbrain").setLevel(logging.ERROR)

# Ensure 'src' is visible
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from src.verification.gatekeeper import SecurityGatekeeper

# Load environment variables
load_dotenv()
HF_TOKEN = os.getenv("HF_TOKEN")

# Pointing to where your audio files actually live!
SAMPLES_DIR = "data/samples"



def main():
    if not HF_TOKEN:
        print("[!] ERROR: HF_TOKEN not found. Please set it in your .env file.")
        return

    gatekeeper = SecurityGatekeeper(HF_TOKEN)
    
    if not os.path.exists(SAMPLES_DIR):
        print(f"Directory not found: {SAMPLES_DIR}. Please check the path.")
        return

    # Grab all .wav files in the samples directory
    files_to_scan = [f for f in os.listdir(SAMPLES_DIR) if f.endswith('.wav')]
    
    if not files_to_scan:
        print(f"No target samples found in directory: {os.path.abspath(SAMPLES_DIR)}")
        return

    print(f"\n[RUNNING SECURITY BATCH SCAN] - {len(files_to_scan)} samples detected")
    print("-" * 70)
    
    results = []
    for filename in sorted(files_to_scan):
        filepath = os.path.join(SAMPLES_DIR, filename)
        is_secure, message = gatekeeper.check_audio_security(filepath)
        
        status = "✅ ACCEPT" if is_secure else "❌ REJECT"
        results.append((filename, status, message))
        print(f"Processed: {filename}")

    # Final Summary Table
    print("\n" + "="*85)
    print(f"{'FILENAME':<25} | {'STATUS':<12} | {'REASON'}")
    print("-" * 85)
    for res in results:
        print(f"{res[0]:<25} | {res[1]:<12} | {res[2]}")
    print("="*85)

if __name__ == "__main__":
    main()