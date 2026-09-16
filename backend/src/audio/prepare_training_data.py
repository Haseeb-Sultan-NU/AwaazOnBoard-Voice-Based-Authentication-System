import os
import pandas as pd
import torchaudio
from tqdm import tqdm
from simulator import TelephonySimulator

# --- CONFIGURATION ---
# Use the same exact path as before
CV_DIR = "E:/Semester 8/FYP/Repos/Telephony-Speaker-Verification/Datasets/urdu-corpus/ur"
CLIPS_DIR = os.path.join(CV_DIR, "clips")
TSV_PATH = os.path.join(CV_DIR, "validated.tsv")

TRAIN_OUT_DIR = "data/train_telephony"

MIN_CLIPS_PER_SPEAKER = 5  # Ensure we have enough data per person
EVAL_SPEAKERS_COUNT = 20   # The exact number of top speakers we used for testing

def main():
    print("🚀 Starting Training Data Preparation (Telephony Mangle)...")
    if not os.path.exists(TRAIN_OUT_DIR):
        os.makedirs(TRAIN_OUT_DIR)

    print(f"Loading metadata from {TSV_PATH}...")
    df = pd.read_csv(TSV_PATH, sep="\t")

    # Count clips per speaker
    speaker_counts = df['client_id'].value_counts()
    
    # 1. PREVENT DATA LEAKAGE: Identify the Eval Speakers to SKIP them
    # The first 20 speakers with >= 10 clips were used in prepare_evaluation_data.py
    eval_speakers = speaker_counts[speaker_counts >= 10].index.tolist()[:EVAL_SPEAKERS_COUNT]
    
    # 2. SELECT TRAINING SPEAKERS
    # Take everyone else who has at least 5 clips
    train_speakers = [spk for spk in speaker_counts.index 
                      if speaker_counts[spk] >= MIN_CLIPS_PER_SPEAKER and spk not in eval_speakers]
    
    print(f"Excluded {len(eval_speakers)} evaluation speakers to prevent data leakage.")
    print(f"Selected {len(train_speakers)} speakers for TRAINING.")
    
    sim = TelephonySimulator()
    total_clips = 0
    
    # 3. PROCESS AND SAVE
    for spk_idx, speaker_id in enumerate(tqdm(train_speakers, desc="Processing Training Speakers")):
        # Get all clips for this specific speaker
        speaker_clips = df[df['client_id'] == speaker_id]['path'].tolist()
        
        # Create a dedicated folder for this speaker (e.g., TRN_000, TRN_001)
        spk_folder = os.path.join(TRAIN_OUT_DIR, f"TRN_{spk_idx:03d}")
        os.makedirs(spk_folder, exist_ok=True)
        
        for clip in speaker_clips:
            mp3_path = os.path.join(CLIPS_DIR, clip)
            # Swap the .mp3 extension for .wav
            wav_name = clip.replace(".mp3", ".wav")
            out_path = os.path.join(spk_folder, wav_name)
            
            # Feature: Skip if already processed (lets you pause/resume the script without starting over)
            if os.path.exists(out_path):
                continue
            
            try:
                # Load clean MP3
                wav, sr = torchaudio.load(mp3_path)
                
                # Apply Telephony Degradation
                mangled_wav, out_sr = sim.process(wav, sr, snr_db=15)
                
                # Save as 16kHz WAV (Required by ECAPA-TDNN)
                torchaudio.save(out_path, mangled_wav, out_sr)
                total_clips += 1
                
            except Exception as e:
                print(f"Failed to process {clip}: {e}")

    print(f"\n✅ Training Data Prep Complete! {total_clips} files saved to '{TRAIN_OUT_DIR}'")

if __name__ == "__main__":
    main()