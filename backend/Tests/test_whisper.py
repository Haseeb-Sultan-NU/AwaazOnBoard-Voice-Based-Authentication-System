import whisper
import soundfile as sf
import torch
import torchaudio.transforms as T
import warnings

# Suppress the FP16 warning for a cleaner terminal
warnings.filterwarnings("ignore", message="FP16 is not supported on CPU")

print("Loading Whisper...")
model = whisper.load_model("tiny") 

print("Loading audio...")
audio_np, sr = sf.read("Recording (5).wav", dtype="float32")
waveform = torch.from_numpy(audio_np).unsqueeze(0) if audio_np.ndim == 1 else torch.from_numpy(audio_np).t()

# Stereo to Mono
if waveform.shape[0] > 1:
    waveform = torch.mean(waveform, dim=0, keepdim=True)

# --- THE VAD (Voice Activity Detection) ---
# We MUST trim the heavy breath/static at the start and end of the audio.
# This prevents Whisper from hallucinating on the background noise.
energies = torch.abs(waveform[0])
mask = energies > 0.015 # Slightly stricter threshold for close-mic distortion

if mask.any():
    non_zero_indices = torch.nonzero(mask).squeeze()
    if non_zero_indices.dim() > 0:
        start_idx = non_zero_indices[0].item()
        end_idx = non_zero_indices[-1].item()
        
        pad = int(sr * 0.1) 
        start_idx = max(0, start_idx - pad)
        end_idx = min(waveform.shape[1], end_idx + pad)
        waveform = waveform[:, start_idx:end_idx]
# ----------------------------------------

# Resample to 16kHz
if sr != 16000:
    waveform = T.Resample(sr, 16000)(waveform)

audio_1D_array = waveform.squeeze().numpy()

print("Transcribing with Anti-Hallucination settings...")
# --- ANTI-HALLUCINATION DECODING PARAMETERS ---
result = model.transcribe(
    audio_1D_array, 
    language="ur",
    initial_prompt="ایک دو تین چار پانچ چھ سات آٹھ نو صفر", 
    condition_on_previous_text=False, # Stops Whisper from looping random words
    temperature=(0.0, 0.2),           # Forces Whisper to be highly literal, not creative
    no_speech_threshold=0.6           # Tells Whisper to ignore pure static
)

print(f"\n==================================")
print(f"WHISPER TRANSCRIBED: {result['text']}")
print(f"==================================")