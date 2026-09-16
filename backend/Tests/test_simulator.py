import sys
import os
import torch
import soundfile as sf

# TEACH PYTHON TO FIND THE 'src' FOLDER
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from src.audio.simulator import TelephonySimulator

def main():
    # Use your specific uploaded samples
    input_file = "data/samples/Haris_Sample.wav"
    output_file = "data/samples/Haris_Sample_Rough_without.729.wav"

    if not os.path.exists(input_file):
        print(f"[!] File not found: {input_file}")
        return

    # Load using soundfile (the reliable Windows method)
    data, orig_sr = sf.read(input_file, dtype='float32')
    waveform = torch.from_numpy(data).unsqueeze(0) # Convert to 2D tensor

    # Run Simulation
    simulator = TelephonySimulator(target_sr=8000)
    print(f"Degrading {input_file} to 8kHz Telephony quality...")
    degraded_wav, new_sr = simulator.process(waveform, orig_sr, snr_db=12)

    # Save
    sf.write(output_file, degraded_wav.squeeze().numpy(), new_sr)
    print(f"[SUCCESS] Listen to the result at: {output_file}")

if __name__ == "__main__":
    main()