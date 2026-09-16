import os
import sounddevice as sd
import soundfile as sf
import warnings

# Suppress some standard PyTorch warnings to keep the terminal clean
warnings.filterwarnings("ignore")

from src.verification.challenge_generator import ChallengeGenerator
from src.verification.digit_asr import UrduASRInference
from src.verification.liveness_validator import LivenessValidator

def record_audio(duration=4, fs=16000, filename="tests/temp_live_audio.wav"):
    """Records audio from the default microphone and saves it."""
    print(f"\n🔴 RECORDING FOR {duration} SECONDS... SPEAK NOW!")
    # Capture audio from the mic
    recording = sd.rec(int(duration * fs), samplerate=fs, channels=1, dtype='float32')
    sd.wait() # Block execution until the recording finishes
    print("✅ Recording complete.")
    
    os.makedirs("tests", exist_ok=True)
    sf.write(filename, recording, fs)
    return filename

def run_live_test():
    print("Loading AI Models into Memory... (Please wait)")
    
    # 1. Initialize our three core pipeline modules
    generator = ChallengeGenerator()
    asr_engine = UrduASRInference()
    validator = LivenessValidator(pass_threshold=0.80)

    # 2. Get a random challenge array (e.g., [4, 9, 1])
    challenge = generator.generate_numeric_challenge(length=3)
    
    # Map it to words so you know what to read
    digit_to_word = {0: "sifar", 1: "ek", 2: "do", 3: "teen", 4: "char", 
                     5: "panch", 6: "che", 7: "saat", 8: "aath", 9: "nau"}
    prompt_words = [digit_to_word[d] for d in challenge]

    print("\n" + "="*50)
    print("🎯 LIVE ACTIVE LIVENESS CHALLENGE")
    print("="*50)
    print(f"Number Challenge:  {challenge}")
    print(f"Please say aloud:  {prompt_words}")
    print("="*50)

    input("\nPress [ENTER] when you are ready to speak...")

    # 3. Record the user speaking
    audio_path = record_audio(duration=4)

    # 4. Transcribe the audio
    print("\n🧠 AI is processing and transcribing your voice...")
    detected_words = asr_engine.transcribe(audio_path)
    
    # 5. Validate the results
    result = validator.evaluate_challenge(challenge, detected_words)

    print("\n" + "="*50)
    print("⚖️  FINAL VERIFICATION RESULT")
    print("="*50)
    for key, value in result.items():
        if key == "liveness_passed":
            status = "🟢 PASSED" if value else "🔴 FAILED"
            print(f"{key.ljust(20)}: {status}")
        else:
            print(f"{key.ljust(20)}: {value}")
            
    # Clean up the temporary audio file
    #if os.path.exists(audio_path):
       # os.remove(audio_path)

if __name__ == "__main__":
    run_live_test()