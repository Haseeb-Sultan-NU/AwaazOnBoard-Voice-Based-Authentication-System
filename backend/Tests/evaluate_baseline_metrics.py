import os
import torch
import torchaudio
import numpy as np
from speechbrain.pretrained import EncoderClassifier
from sklearn.metrics import roc_curve
from tqdm import tqdm

# --- CONFIGURATION ---
EVAL_DIR = "data/evaluation"
CLEAN_DIR = os.path.join(EVAL_DIR, "clean_enrollment")
TELEPHONY_DIR = os.path.join(EVAL_DIR, "telephony_verification")

print("Loading ECAPA-TDNN Model...")
# This downloads/loads the base English model
classifier = EncoderClassifier.from_hparams(
    source="speechbrain/spkrec-ecapa-voxceleb", 
    savedir="tmp_model"
)

def get_embedding(filepath):
    """Extracts the 192-dimensional voice print."""
    signal, fs = torchaudio.load(filepath)
    
    # CRITICAL: ECAPA-TDNN expects 16kHz. 
    # We must upsample the 8kHz telephony audio back to 16kHz for the model.
    if fs != 16000:
        signal = torchaudio.functional.resample(signal, orig_freq=fs, new_freq=16000)
    
    with torch.no_grad():
        embeddings = classifier.encode_batch(signal)
    
    return embeddings[0, 0].numpy()

def main():
    print("🚀 Starting Baseline Evaluation...")
    
    if not os.path.exists(CLEAN_DIR) or not os.path.exists(TELEPHONY_DIR):
        print("Error: Evaluation folders not found. Check your paths.")
        return

    clean_files = sorted(os.listdir(CLEAN_DIR))
    telephony_files = sorted(os.listdir(TELEPHONY_DIR))
    
    if not clean_files or not telephony_files:
        print("Error: Evaluation folders are empty.")
        return

    # 1. Extract Embeddings 
    print(f"\nExtracting Embeddings for {len(clean_files)} Clean Audio files (Enrollment)...")
    clean_embs = {f: get_embedding(os.path.join(CLEAN_DIR, f)) for f in tqdm(clean_files)}
    
    print(f"Extracting Embeddings for {len(telephony_files)} Telephony Audio files (Verification)...")
    telephony_embs = {f: get_embedding(os.path.join(TELEPHONY_DIR, f)) for f in tqdm(telephony_files)}

    # 2. Generate Trials (Target vs Imposter)
    scores = []
    labels = []
    
    print("\nCross-matching all files to calculate metrics...")
    for c_file, c_emb in clean_embs.items():
        # Extract speaker ID from filename (e.g., "SPK_001_clean_0.wav" -> "SPK_001")
        c_spk = "_".join(c_file.split("_")[:2]) 
        
        for t_file, t_emb in telephony_embs.items():
            t_spk = "_".join(t_file.split("_")[:2])
            
            # Calculate Cosine Similarity
            cos_sim = np.dot(c_emb, t_emb) / (np.linalg.norm(c_emb) * np.linalg.norm(t_emb))
            scores.append(cos_sim)
            
            # 1 = Target (Same Speaker), 0 = Imposter (Different Speaker)
            if c_spk == t_spk:
                labels.append(1)
            else:
                labels.append(0)

    # 3. Calculate Metrics
    fpr, tpr, thresholds = roc_curve(labels, scores, pos_label=1)
    fnr = 1 - tpr
    
    # EER is where False Acceptance Rate (FPR) == False Rejection Rate (FNR)
    eer_index = np.nanargmin(np.absolute(fpr - fnr))
    eer = fpr[eer_index]
    optimal_threshold = thresholds[eer_index]

    

    print("\n" + "="*55)
    print("📊 BASELINE METRICS (PRE-TRAINED ECAPA on URDU TELEPHONY)")
    print("="*55)
    print(f"Total Trials Computed: {len(scores)}")
    print(f"Target (Match) Trials: {sum(labels)}")
    print(f"Imposter Trials:       {len(labels) - sum(labels)}")
    print("-" * 55)
    print(f"🔴 Equal Error Rate (EER): {eer * 100:.2f}%")
    print(f"⚙️  Optimal Threshold:      {optimal_threshold:.4f}")
    print(f"🔒 FAR @ Threshold:        {fpr[eer_index] * 100:.2f}%")
    print(f"❌ FRR @ Threshold:        {fnr[eer_index] * 100:.2f}%")
    print("="*55)

if __name__ == "__main__":
    main()