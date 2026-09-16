import json
import os
import time
from src.verification.digit_asr import UrduASRInference

def run_metrics_evaluation(num_test_samples=200):
    print("==================================================")
    print("📊 STARTING AUTOMATED ASR METRICS EVALUATION")
    print("==================================================")
    
    manifest_path = "data/training/asr_processed/manifest.json"
    
    if not os.path.exists(manifest_path):
        print(f"Error: Could not find {manifest_path}. Did you run prepare_asr_data.py?")
        return

    with open(manifest_path, 'r') as f:
        manifest = json.load(f)

    print("Loading AI Models into Memory... (Please wait)")
    asr = UrduASRInference()
    
    # Metrics Trackers
    total_sequences = 0
    perfect_sequences = 0
    total_digits = 0
    correct_digits = 0
    total_inference_time = 0

    print(f"\nEvaluating {num_test_samples} samples from your synthetic dataset...\n")

    for i, item in enumerate(manifest[:num_test_samples]):
        audio_path = item['audio_filepath']
        expected_sequence = item['text'].split()
        
        start_time = time.time()
        detected_sequence = asr.transcribe(audio_path)
        inference_time = time.time() - start_time
        
        total_inference_time += inference_time
        total_sequences += 1
        
        # 1. Sequence-Level Match (Strict Liveness Metric)
        if expected_sequence == detected_sequence:
            perfect_sequences += 1
            status = "🟢 PASS"
        else:
            status = "🔴 FAIL"

        # 2. Digit-Level Match (Word Error Rate equivalent)
        for exp_digit, det_digit in zip(expected_sequence, detected_sequence + [None]*len(expected_sequence)):
            total_digits += 1
            if exp_digit == det_digit:
                correct_digits += 1

        print(f"Test {i+1:03d}/{num_test_samples} | {status} | Expected: {expected_sequence} | Detected: {detected_sequence}")

    # --- CALCULATE FINAL METRICS ---
    sequence_accuracy = (perfect_sequences / total_sequences) * 100
    if total_digits > 0:
        digit_accuracy = (correct_digits / total_digits) * 100
    else:
        digit_accuracy = 0.0
    avg_inference = total_inference_time / total_sequences

    print("\n==================================================")
    print("📈 FINAL FYP EVALUATION REPORT")
    print("==================================================")
    print(f"Total Sequences Tested : {total_sequences}")
    print(f"Total Digits Tested    : {total_digits}")
    print(f"Sequence Accuracy      : {sequence_accuracy:.2f}% (Strict Match)")
    print(f"Digit Accuracy         : {digit_accuracy:.2f}% (Individual Word Match)")
    print(f"Avg Inference Latency  : {avg_inference:.2f} seconds per file")
    print("==================================================")

# This is the crucial part that actually triggers the code!
if __name__ == "__main__":
    run_metrics_evaluation(num_test_samples=200)