import os
import torch
import soundfile as sf
import torchaudio
import sys

# 1. Trick SpeechBrain's internal check
if not hasattr(torchaudio, "list_audio_backends"):
    torchaudio.list_audio_backends = lambda: ["soundfile"] 
    # TEACH PYTHON TO FIND THE 'src' FOLDER
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))


# 2. THE NUCLEAR OPTION: Completely bypass Torchaudio's broken loader
def custom_audio_load(filepath, channels_first=True, **kwargs):
    """Loads audio using soundfile directly, skipping torchaudio internals."""
    data, samplerate = sf.read(filepath, dtype='float32')
    tensor = torch.from_numpy(data)
    
    if tensor.ndim == 1:
        tensor = tensor.unsqueeze(0)  # Shape: (1, frames)
    else:
        tensor = tensor.t()           # Shape: (channels, frames)
        
    if not channels_first:
        tensor = tensor.t()           # Shape: (frames, channels)
        
    return tensor, samplerate

torchaudio.load = custom_audio_load

# Now import SpeechBrain safely
from src.verification.ecapa_engine import EcapaVerifier

def main():
    verifier = EcapaVerifier()
    
    file_path_1 = "data/samples/Haseeb_Sample_Clean.wav"
    file_path_2 = "data/samples/Haseeb_Sample_Rough.wav"

    # Check if BOTH files exist
    if os.path.exists(file_path_1) and os.path.exists(file_path_2):
        print(f"\n[RUNNING VERIFICATION]")
        print(f"Comparing File 1: {file_path_1}")
        print(f"Comparing File 2: {file_path_2}")
        
        # Compare the two different files
        score, is_match = verifier.verify_pair(file_path_1, file_path_2)
        
        print(f"\n[RESULTS]")
        print(f"Similarity Score: {score:.4f}")
        print(f"Match Decision: {'MATCH' if is_match else 'NO MATCH'}")
        print("\nNote: Since these are randomly generated dummy files, you should expect a low score and a 'NO MATCH'.")
    else:
        print(f"\n[!] Error: Could not find one or both files.")
        print(f" -> {os.path.abspath(file_path_1)}")
        print(f" -> {os.path.abspath(file_path_2)}")

if __name__ == "__main__":
    main()