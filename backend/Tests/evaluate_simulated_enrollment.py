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
TEMP_SIM_DIR = os.path.join(EVAL_DIR, "temp_simulated_enrollment")
FINETUNED_MODEL_PATH = "models/best_urdu_triplet_ecapa.pth"

def main():
    print("🚀 Starting Forward Simulation Evaluation...")
    
    # 1. Create a temporary folder for the degraded enrollment files
    if os.path.exists(TEMP_SIM_DIR):
        shutil.rmtree(TEMP_SIM_DIR)
    os.makedirs(TEMP_SIM_DIR)

    # 2. Initialize the Simulator
    print("🎛️ Artificially degrading Clean Enrollment files...")
    simulator = TelephonySimulator(target_sr=8000) 
    
    clean_files = [f for f in os.listdir(CLEAN_DIR) if f.endswith('.wav')]
    for file in tqdm(clean_files, desc="Simulating Telephony"):
        in_path = os.path.join(CLEAN_DIR, file)
        out_path = os.path.join(TEMP_SIM_DIR, file)
        
        waveform, orig_sr = torchaudio.load(in_path)
        
        # Apply the clean pipeline (Bandpass + Noise only)
        sim_wav, sim_sr = simulator.process(waveform, orig_sr, snr_db=15)
        
        # Save the artificially degraded file for the Verifier to extract
        torchaudio.save(out_path, sim_wav, sim_sr)

    # 3. Initialize Verifier with your Triplet weights
    verifier = EcapaVerifier(finetuned_weights_path=FINETUNED_MODEL_PATH)

    # 4. Extract Embeddings
    print("\n🧠 Extracting Embeddings for SIMULATED Enrollment...")
    sim_files = [os.path.join(TEMP_SIM_DIR, f) for f in os.listdir(TEMP_SIM_DIR) if f.endswith('.wav')]
    enroll_embs = {os.path.basename(f): verifier.extract_embedding(f) for f in tqdm(sim_files)}
    
    print("🧠 Extracting Embeddings for REAL Telephony Verification...")
    tele_files = [os.path.join(TELEPHONY_DIR, f) for f in os.listdir(TELEPHONY_DIR) if f.endswith('.wav')]
    verify_embs = {os.path.basename(f): verifier.extract_embedding(f) for f in tqdm(tele_files)}

    # 5. Cross-Match all 10,000 pairs
    print("\n⚔️ Cross-matching all pairs...")
    labels = []
    scores = []
    
    for e_file, e_emb in enroll_embs.items():
        e_spk = "_".join(e_file.split('_')[:2])  # Grabs "SPK_000"
        for v_file, v_emb in verify_embs.items():
            v_spk = "_".join(v_file.split('_')[:2])  # Grabs "SPK_000"
            
            # Cosine Similarity Math
            score = np.dot(e_emb, v_emb) / (np.linalg.norm(e_emb) * np.linalg.norm(v_emb))
            scores.append(score)
            labels.append(1 if e_spk == v_spk else 0)

    # 6. Calculate Metrics
    fpr, tpr, thresholds = roc_curve(labels, scores)
    eer = brentq(lambda x: 1. - x - interp1d(fpr, tpr)(x), 0., 1.)
    optimal_threshold = interp1d(fpr, thresholds)(eer)

    print("\n=======================================================")
    print("🏆 FORWARD SIMULATION METRICS (Simulated Clean vs Real Telephony)")
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