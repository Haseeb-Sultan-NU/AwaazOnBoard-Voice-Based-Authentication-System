import sys
import os
import shutil
import numpy as np
import torchaudio
from sklearn.metrics import roc_curve
from scipy.optimize import brentq
from scipy.interpolate import interp1d
from tqdm import tqdm

# --- 🩹 PYTHON PATH FIX ---
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Import your Verifier and Simulator
from src.verification.ecapa_engine import EcapaVerifier
from src.audio.simulator import TelephonySimulator 

# --- CONFIGURATION ---
EVAL_DIR = "data/evaluation"
CLEAN_DIR = os.path.join(EVAL_DIR, "clean_enrollment")
TELEPHONY_DIR = os.path.join(EVAL_DIR, "telephony_verification")
TEMP_SIM_DIR = os.path.join(EVAL_DIR, "temp_multi_condition")
FINETUNED_MODEL_PATH = "models/best_urdu_triplet_ecapa.pth"

def cosine_sim(a, b):
    """Helper function to calculate Cosine Similarity"""
    return np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b))

def main():
    print("🚀 Starting Multi-Condition Enrollment Evaluation...")
    
    # 1. Create a temporary folder for the degraded audio files
    if os.path.exists(TEMP_SIM_DIR):
        shutil.rmtree(TEMP_SIM_DIR)
    os.makedirs(TEMP_SIM_DIR)

    simulator = TelephonySimulator(target_sr=8000) 
    verifier = EcapaVerifier(finetuned_weights_path=FINETUNED_MODEL_PATH)
    
    enroll_embs = {}
    clean_files = [f for f in os.listdir(CLEAN_DIR) if f.endswith('.wav')]
    
    # 2. Extract 3x Embeddings per Enrollment File
    print("\n🎛️ Processing Multi-Condition Enrollments (3 profiles per user)...")
    for file in tqdm(clean_files, desc="Enrolling"):
        in_path = os.path.join(CLEAN_DIR, file)
        wav, sr = torchaudio.load(in_path)
        
        # CONDITION 1: Raw Clean Audio
        emb_clean = verifier.extract_embedding(in_path)
        
        # CONDITION 2: Light Telephony (8kHz + Bandpass Filter, NO Noise)
        wav_8k = simulator.resample(wav, sr)
        wav_bp = simulator.apply_telephony_filter(wav_8k)
        path_bp = os.path.join(TEMP_SIM_DIR, f"bp_{file}")
        torchaudio.save(path_bp, wav_bp, 8000)
        emb_bp = verifier.extract_embedding(path_bp)
        
        # CONDITION 3: Full Telephony (8kHz + Bandpass + 15dB White Noise)
        wav_noisy, sim_sr = simulator.process(wav, sr, snr_db=15)
        path_noisy = os.path.join(TEMP_SIM_DIR, f"noisy_{file}")
        torchaudio.save(path_noisy, wav_noisy, sim_sr)
        emb_noisy = verifier.extract_embedding(path_noisy)
        
        # Store all three embeddings in a list for this specific file
        enroll_embs[file] = [emb_clean, emb_bp, emb_noisy]

    # 3. Extract standard embeddings for the live verification audio
    print("\n🧠 Extracting Embeddings for REAL Telephony Verification...")
    tele_files = [os.path.join(TELEPHONY_DIR, f) for f in os.listdir(TELEPHONY_DIR) if f.endswith('.wav')]
    verify_embs = {os.path.basename(f): verifier.extract_embedding(f) for f in tqdm(tele_files)}
    
    # 4. Cross-Match all 10,000 pairs
    print("\n⚔️ Cross-matching all pairs (Taking MAX score of the 3 conditions)...")
    labels = []
    scores = []
    
    for e_file, e_emb_list in enroll_embs.items():
        # Correctly grab "SPK_000"
        e_spk = "_".join(e_file.split('_')[:2]) 
        
        for v_file, v_emb in verify_embs.items():
            v_spk = "_".join(v_file.split('_')[:2])
            
            # Compare the live verification audio against all 3 saved enrollment conditions
            sim_scores = [cosine_sim(e_emb, v_emb) for e_emb in e_emb_list]
            
            # THE MAGIC: Take the highest similarity score out of the 3!
            best_score = max(sim_scores)
            
            scores.append(best_score)
            labels.append(1 if e_spk == v_spk else 0)

    # 5. Calculate Final Metrics
    fpr, tpr, thresholds = roc_curve(labels, scores)
    eer = brentq(lambda x: 1. - x - interp1d(fpr, tpr)(x), 0., 1.)
    optimal_threshold = interp1d(fpr, thresholds)(eer)

    print("\n=======================================================")
    print("🏆 MULTI-CONDITION ENROLLMENT METRICS")
    print("=======================================================")
    print(f"Total Trials Computed: {len(scores)}")
    print("-------------------------------------------------------")
    print(f"🔴 Equal Error Rate (EER): {eer * 100:.2f}%")
    print(f"⚙️  Optimal Threshold:      {optimal_threshold:.4f}")
    print("=======================================================")

    # Clean up the temporary folder
    shutil.rmtree(TEMP_SIM_DIR)

if __name__ == "__main__":
    main()