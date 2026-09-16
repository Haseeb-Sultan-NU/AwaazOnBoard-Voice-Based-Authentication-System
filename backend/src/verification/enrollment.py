import os
import sys
import torch
import torchaudio
import soundfile as sf

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
from src.audio.simulator import TelephonySimulator

class EnrollmentManager:
    def __init__(self, finetuned_weights_path):
        print("Initializing Enrollment Manager...")
        self.verifier = EcapaVerifier(finetuned_weights_path=finetuned_weights_path)
        self.simulator = TelephonySimulator(target_sr=8000)
        self.enrollment_dir = "data/enrollments"
        os.makedirs(self.enrollment_dir, exist_ok=True)

    def create_multi_template(self, user_id, clean_audio_paths):
        print(f"\n[ENROLLMENT] Starting SECURE MULTI-TEMPLATE enrollment for user: {user_id}")
        
        clean_embeddings = []
        telephony_embeddings = []
        
        for i, path in enumerate(clean_audio_paths):
            if not os.path.exists(path):
                continue
                
            print(f"  -> Processing Take {i+1} ({os.path.basename(path)})...")
            wav, sr = torchaudio.load(path)
            
            # 1. Clean Vector
            clean_embeddings.append(self.verifier.extract_embedding(path))
            
            # 2. Degraded Telephony Vector (Phone Filter + Noise)
            wav_noisy, sim_sr = self.simulator.process(wav, sr, snr_db=15)
            torchaudio.save("temp_enr_noisy.wav", wav_noisy, sim_sr)
            telephony_embeddings.append(self.verifier.extract_embedding("temp_enr_noisy.wav"))
            
        print("\n  -> Compiling Secure Multi-Template Dictionary...")
        
        # Save as a Dictionary of distinct centroids, NOT a smeared average!
        master_template = {
            "clean": torch.mean(torch.stack([torch.tensor(e) for e in clean_embeddings]), dim=0),
            "telephony": torch.mean(torch.stack([torch.tensor(e) for e in telephony_embeddings]), dim=0)
        }
        
        save_path = os.path.join(self.enrollment_dir, f"{user_id}_baseline.pt")
        torch.save(master_template, save_path)
        print(f"✅ [SUCCESS] Multi-Template saved securely to: {save_path}")
        
        if os.path.exists("temp_enr_noisy.wav"):
            os.remove("temp_enr_noisy.wav")
        
        return True

if __name__ == "__main__":
    FINETUNED_MODEL_PATH = "models/best_urdu_triplet_ecapa.pth"
    manager = EnrollmentManager(FINETUNED_MODEL_PATH)
    
    sample_takes = [
        "data/debug_audio/Recording (2).wav",
        "data/debug_audio/Recording (4).wav",
        "data/debug_audio/Recording (5).wav"
    ]
    
    # Overwrite the old smeared baseline
    manager.create_multi_template("Haseeb_001", sample_takes)