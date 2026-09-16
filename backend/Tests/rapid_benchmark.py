import time
import random
import sounddevice as sd
import soundfile as sf
import warnings
from src.verification.digit_asr import UrduASRInference

warnings.filterwarnings("ignore")

def record_audio(filename="temp_benchmark.wav", duration=4, fs=16000):
    print("🔴 RECORDING... SPEAK NOW!")
    recording = sd.rec(int(duration * fs), samplerate=fs, channels=1, dtype='float32')
    sd.wait()
    sf.write(filename, recording, fs)
    print("✅ Recorded.")
    return filename

def run_rapid_benchmark(num_rounds=10):
    print("==================================================")
    print("🚀 STARTING RAPID-FIRE LIVE BENCHMARK (V2)")
    print("==================================================")
    print(f"You will be given {num_rounds} challenges back-to-back.")
    print("Get ready to speak clearly into your microphone.\n")
    
    asr = UrduASRInference()
    
    digit_map = {
        0: 'sifar', 1: 'ek', 2: 'do', 3: 'teen', 4: 'char', 
        5: 'panch', 6: 'che', 7: 'saat', 8: 'aath', 9: 'nau'
    }

    # Enhanced Metrics Trackers
    total_sequences = 0
    passes = 0
    fails = 0
    
    total_digits = 0
    correct_digits = 0
    
    latencies = []

    input("\nPress [ENTER] when you are ready to start Round 1...")

    for i in range(num_rounds):
        # 1. Generate Challenge
        challenge_nums = [random.randint(0, 9) for _ in range(3)]
        expected_sequence = [digit_map[n] for n in challenge_nums]
        
        print("\n" + "="*45)
        print(f"🎯 ROUND {i+1}/{num_rounds}")
        print(f"Please say: {expected_sequence}")
        print("="*45)
        
        time.sleep(1) # Give you 1 second to read it
        
        # 2. Record
        audio_path = record_audio(duration=4)
        
        # 3. Transcribe & Time
        print("🧠 Processing...")
        start_time = time.time()
        detected_sequence = asr.transcribe(audio_path)
        inference_time = time.time() - start_time
        
        # Track Latency
        latencies.append(inference_time)
        total_sequences += 1
        
        # 4. Calculate Sequence Match
        if expected_sequence == detected_sequence:
            passes += 1
            print(f"🟢 PASS | Latency: {inference_time:.2f}s")
        else:
            fails += 1
            print(f"🔴 FAIL | Latency: {inference_time:.2f}s")
            print(f"   Detected: {detected_sequence}")

        # 5. Calculate Digit Match
        for exp_digit, det_digit in zip(expected_sequence, detected_sequence + [None]*len(expected_sequence)):
            total_digits += 1
            if exp_digit == det_digit:
                correct_digits += 1
                
        time.sleep(1) # Short breath before the next round

    # --- CALCULATE FINAL FYP METRICS ---
    pass_percentage = (passes / total_sequences) * 100
    fail_percentage = (fails / total_sequences) * 100
    digit_accuracy = (correct_digits / total_digits) * 100 if total_digits > 0 else 0
    
    avg_latency = sum(latencies) / len(latencies)
    min_latency = min(latencies)
    max_latency = max(latencies)

    print("\n\n" + "="*55)
    print("📈 FINAL FYP LIVE EVALUATION REPORT")
    print("="*55)
    
    print("\n[ 1. LIVENESS SEQUENCE ACCURACY ]")
    print(f"Total Challenges : {total_sequences}")
    print(f"Total Passed     : {passes} ({pass_percentage:.2f}%)")
    print(f"Total Failed     : {fails} ({fail_percentage:.2f}%)  <-- (Baseline FRR)")
    
    print("\n[ 2. DIGIT-LEVEL ACCURACY (WER Equivalent) ]")
    print(f"Total Digits     : {total_digits}")
    print(f"Correctly Parsed : {correct_digits}")
    print(f"Digit Accuracy   : {digit_accuracy:.2f}%")
    
    print("\n[ 3. INFERENCE LATENCY (Real-Time Feasibility) ]")
    print(f"Average Speed    : {avg_latency:.2f} seconds")
    print(f"Fastest Round    : {min_latency:.2f} seconds")
    print(f"Slowest Round    : {max_latency:.2f} seconds")
    
    print("\n" + "="*55)
    print("Copy this terminal block directly into your FYP report!")

if __name__ == "__main__":
    # You can bump this up to 20 or 30 for your final documentation run!
    run_rapid_benchmark(num_rounds=10)