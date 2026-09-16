import os
import torch
import torchaudio
try:
    # SpeechBrain >= 1.0
    from speechbrain.inference.speaker import SpeakerRecognition
except ImportError:
    # SpeechBrain < 1.0 (Our stable version for Gatekeeper compatibility)
    from speechbrain.pretrained import SpeakerRecognition

class EcapaVerifier:
    def __init__(self, model_source="speechbrain/spkrec-ecapa-voxceleb", finetuned_weights_path=None):
        """
        Initializes the Biometric Engine.
        If finetuned_weights_path is provided, it injects the custom trained weights.
        """
        print(f"Loading Base ECAPA-TDNN Architecture from {model_source}...")
        self.model = SpeakerRecognition.from_hparams(
            source=model_source,
            savedir=f"models/pretrained/{model_source.split('/')[-1]}"
        )

        # --- THE BRAIN TRANSPLANT ---
        if finetuned_weights_path:
            if os.path.exists(finetuned_weights_path):
                print(f"🧠 Injecting Fine-Tuned Urdu Weights from {finetuned_weights_path}...")
                
                # Load the custom state dictionary (the fine-tuned weights)
                custom_state_dict = torch.load(finetuned_weights_path, map_location="cpu")
                
                # Overwrite the base English embedding model with your new Urdu Telephony model
                self.model.mods.embedding_model.load_state_dict(custom_state_dict)
                print("✅ Fine-Tuned weights loaded successfully!")
            else:
                print(f"⚠️ WARNING: Could not find {finetuned_weights_path}. Defaulting to base English model.")

    def extract_embedding(self, filepath):
        """Extracts the raw 192-dimensional voice print for bulk testing."""
        signal, fs = torchaudio.load(filepath)
        
        # Ensure 16kHz for ECAPA
        if fs != 16000:
            signal = torchaudio.functional.resample(signal, orig_freq=fs, new_freq=16000)
            
        # Move audio to the same device as the model (CPU/GPU)
        signal = signal.to(self.model.device)
        
        with torch.no_grad():
            embeddings = self.model.encode_batch(signal)
            
        return embeddings[0, 0].cpu().numpy()

    def verify_pair(self, path1, path2, custom_threshold=None):
        """
        Compares two audio files and returns the Cosine Similarity score. 
        """
        if not os.path.exists(path1) or not os.path.exists(path2):
            return None, "File(s) not found."

        # SpeechBrain automatically handles loading the files and extracting embeddings
        score, prediction = self.model.verify_files(path1, path2)
        
        # If we have calculated a new Optimal Threshold from evaluate_finetuned.py, use it!
        if custom_threshold is not None:
            # Override SpeechBrain's default prediction logic with our mathematically proven threshold
            is_match = score.item() >= custom_threshold
            return score.item(), is_match
            
        return score.item(), prediction.item()

if __name__ == "__main__":
    # Quick Test Logic
    verifier = EcapaVerifier(finetuned_weights_path="models/best_urdu_ecapa.pth")
    print("Biometric Verifier initialized and ready for production.")