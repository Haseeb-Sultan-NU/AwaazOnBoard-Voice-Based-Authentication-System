import sounddevice as sd
from scipy.io.wavfile import write
import whisper
import warnings
import numpy as np
import os

# Suppress annoying FP16 warnings from Whisper on CPU
warnings.filterwarnings("ignore", message="FP16 is not supported on CPU; using FP32 instead")

SAMPLE_RATE = 16000
DURATION = 5

def test_local_asr():
    print("🧠 Loading Whisper Base Model (This takes a few seconds)...")
    model = whisper.load_model("base")
    print("✅ Model loaded!\n")

    print(f"🎤 Recording for {DURATION} seconds. Speak some Urdu numbers now...")
    # Using int16 to ensure compatibility with all audio processing libraries
    recording = sd.rec(int(DURATION * SAMPLE_RATE), samplerate=SAMPLE_RATE, channels=1, dtype=np.int16)
    sd.wait()
    print("✅ Recording stopped.\n")

    test_file = "local_test_audio.wav"
    write(test_file, SAMPLE_RATE, recording)

    print("🔍 Transcribing audio...")
    # We explicitly tell Whisper to expect Urdu for maximum accuracy
    result = model.transcribe(test_file, language="ur")
    
    print("-" * 40)
    print("📝 RAW TRANSCRIPTION RESULT:")
    print(result["text"])
    print("-" * 40)

    # Cleanup
    if os.path.exists(test_file):
        os.remove(test_file)

if __name__ == "__main__":
    test_local_asr()