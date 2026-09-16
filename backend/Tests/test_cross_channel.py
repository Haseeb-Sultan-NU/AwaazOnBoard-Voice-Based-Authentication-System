import sys
import os
import torch
import torchaudio
import soundfile as sf
import numpy as np

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

if not hasattr(torchaudio, "list_audio_backends"):
    torchaudio.list_audio_backends = lambda: ["soundfile"]

def custom_audio_load(filepath, channels_first=True, **kwargs):
    data, samplerate = sf.read(filepath, dtype='float32')
    tensor = torch.from_numpy(data)
    if tensor.ndim == 1:
        tensor = tensor.unsqueeze(0)
    else:
        tensor = tensor.t()
    if not channels_first:
        tensor = tensor.t()
    return tensor, samplerate

torchaudio.load = custom_audio_load
from src.verification.ecapa_engine import EcapaVerifier

def cosine_sim(a, b):
    return np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b))

def main():
    FINETUNED_MODEL_PATH = "models/best_urdu_triplet_ecapa.pth"
    # We can safely use your original mathematical threshold now!
    OPTIMAL_THRESHOLD = 0.2393

    print("🚀 Booting up Multi-Template Verifier...")
    verifier = EcapaVerifier(finetuned_weights_path=FINETUNED_MODEL_PATH)
    
    master_template_file = "data/enrollments/Haseeb_001_baseline.pt"
    
    # Let's test your brother first to prove he is locked out
    telephony_file = "data/samples/Zain_Sample_Clean.wav" 

    print(f"\n[RUNNING VERIFICATION AGAINST MASTER TEMPLATE]")
    print(f"Incoming Live Call: {telephony_file}")

    # Load the Dictionary Template
    try:
        master_dict = torch.load(master_template_file, weights_only=False)
    except Exception:
        master_dict = torch.load(master_template_file)
        
    emb_clean = np.array(master_dict["clean"].detach().cpu().numpy()).flatten()
    emb_telephony = np.array(master_dict["telephony"].detach().cpu().numpy()).flatten()

    # Extract Live Call
    emb_live = np.array(verifier.extract_embedding(telephony_file)).flatten()

    # Score against both distinct profiles
    score_clean = cosine_sim(emb_clean, emb_live)
    score_telephony = cosine_sim(emb_telephony, emb_live)
    
    # Max-Pooling Strategy
    final_score = max(score_clean, score_telephony)
    is_match = final_score >= OPTIMAL_THRESHOLD

    print(f"\n[RESULTS]")
    print(f"Match against Clean Profile:  {score_clean:.4f}")
    print(f"Match against Noisy Profile:  {score_telephony:.4f}")
    print(f"----------------------------------------")
    print(f"🏆 FINAL MATCH SCORE: {final_score:.4f} (Required: {OPTIMAL_THRESHOLD})")
    print(f"🔒 DECISION: {'✅ ACCESS GRANTED' if is_match else '❌ ACCESS DENIED'}")

if __name__ == "__main__":
    main()