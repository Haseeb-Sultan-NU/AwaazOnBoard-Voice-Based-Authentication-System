
import sys
import os
import numpy as np
from sklearn.metrics import roc_curve
from tqdm import tqdm
# --- 🩹 PYTHON PATH FIX ---
# This forces Python to look at the root of your project so it can find the 'src' folder
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
# Import YOUR custom engine
# Adjust this import path if your folders are arranged differently
from src.verification.ecapa_engine import EcapaVerifier 

# --- CONFIGURATION ---
EVAL_DIR = "data/evaluation"
CLEAN_DIR = os.path.join(EVAL_DIR, "telephony_verification")
TELEPHONY_DIR = os.path.join(EVAL_DIR, "telephony_verification")

# The weights Colab is currently cooking!
FINETUNED_MODEL_PATH = "models/best_urdu_triplet_ecapa.pth"

def main():
    print("🚀 Starting Fine-Tuned Evaluation...")
    
    # 1. Initialize YOUR engine (It handles the brain transplant automatically!)
    verifier = EcapaVerifier(finetuned_weights_path=FINETUNED_MODEL_PATH)

    clean_files = sorted(os.listdir(CLEAN_DIR))
    telephony_files = sorted(os.listdir(TELEPHONY_DIR))
    
    if not clean_files or not telephony_files:
        print("❌ Error: Evaluation folders are empty.")
        return

    # 2. Extract Embeddings using your engine
    print(f"\nExtracting Embeddings for {len(clean_files)} Clean Audio files (Enrollment)...")
    clean_embs = {f: verifier.extract_embedding(os.path.join(CLEAN_DIR, f)) for f in tqdm(clean_files)}
    
    print(f"Extracting Embeddings for {len(telephony_files)} Telephony Audio files (Verification)...")
    telephony_embs = {f: verifier.extract_embedding(os.path.join(TELEPHONY_DIR, f)) for f in tqdm(telephony_files)}

    # 3. Generate Trials (Target vs Imposter)
    scores = []
    labels = []
    
    print("\nCross-matching all files to calculate metrics...")
    for c_file, c_emb in clean_embs.items():
        c_spk = "_".join(c_file.split("_")[:2]) 
        
        for t_file, t_emb in telephony_embs.items():
            t_spk = "_".join(t_file.split("_")[:2])
            
            cos_sim = np.dot(c_emb, t_emb) / (np.linalg.norm(c_emb) * np.linalg.norm(t_emb))
            scores.append(cos_sim)
            
            if c_spk == t_spk:
                labels.append(1)
            else:
                labels.append(0)

    # 4. Calculate Metrics
    fpr, tpr, thresholds = roc_curve(labels, scores, pos_label=1)
    fnr = 1 - tpr
    
    eer_index = np.nanargmin(np.absolute(fpr - fnr))
    eer = fpr[eer_index]
    optimal_threshold = thresholds[eer_index]

    print("\n" + "="*55)
    print("🏆 POST-TRAINING METRICS (FINE-TUNED ECAPA on URDU TELEPHONY)")
    print("="*55)
    print(f"Total Trials Computed: {len(scores)}")
    print("-" * 55)
    print(f"🔴 Equal Error Rate (EER): {eer * 100:.2f}%  <-- (Target: < 5%)")
    print(f"⚙️  Optimal Threshold:      {optimal_threshold:.4f}")
    print(f"🔒 FAR @ Threshold:        {fpr[eer_index] * 100:.2f}%")
    print(f"❌ FRR @ Threshold:        {fnr[eer_index] * 100:.2f}%")
    print("="*55)

if __name__ == "__main__":
    main()