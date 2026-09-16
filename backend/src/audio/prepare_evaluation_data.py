import os
import pandas as pd
import torch
import torchaudio
from tqdm import tqdm
import shutil

# Import the simulator (since they are in the same folder)
from simulator import TelephonySimulator

# --- CONFIGURATION ---
CV_DIR = "E:/Semester 8/FYP/Repos/Telephony-Speaker-Verification/Datasets/urdu-corpus/ur"  # Fixed stray quote here
CLIPS_DIR = os.path.join(CV_DIR, "clips")
TSV_PATH = os.path.join(CV_DIR, "validated.tsv")

OUTPUT_DIR = "data/evaluation"
CLEAN_DIR = os.path.join(OUTPUT_DIR, "clean_enrollment")
TELEPHONY_DIR = os.path.join(OUTPUT_DIR, "telephony_verification")

NUM_SPEAKERS = 20  # How many unique people to test
CLIPS_PER_SPEAKER = 10  # 5 for clean, 5 for telephony

def setup_directories():
    """Creates fresh output directories."""
    for d in [CLEAN_DIR, TELEPHONY_DIR]:
        if os.path.exists(d):
            shutil.rmtree(d)
        os.makedirs(d)

def main():
    print("🚀 Starting Data Preparation Pipeline...")
    setup_directories()
    
    # 1. Load Metadata
    print(f"Loading metadata from {TSV_PATH}...")
    df = pd.read_csv(TSV_PATH, sep="\t")
    
    # 2. Find the most prolific speakers
    speaker_counts = df['client_id'].value_counts()
    valid_speakers = speaker_counts[speaker_counts >= CLIPS_PER_SPEAKER].index.tolist()
    
    if len(valid_speakers) < NUM_SPEAKERS:
        print(f"Warning: Only found {len(valid_speakers)} speakers with {CLIPS_PER_SPEAKER}+ clips.")
        speakers_to_process = valid_speakers
    else:
        speakers_to_process = valid_speakers[:NUM_SPEAKERS]
        
    print(f"Selected {len(speakers_to_process)} speakers for the evaluation set.")
    
    # Initialize Simulator
    sim = TelephonySimulator() 
    
    # 3. Process Audio Files
    for spk_idx, speaker_id in enumerate(tqdm(speakers_to_process, desc="Processing Speakers")):
        speaker_clips = df[df['client_id'] == speaker_id]['path'].tolist()[:CLIPS_PER_SPEAKER]
        
        # Split: First 5 for Clean, Next 5 for Telephony
        clean_clips = speaker_clips[:5]
        telephony_clips = speaker_clips[5:]
        
        # Helper string for clean filenames
        spk_name = f"SPK_{spk_idx:03d}"
        
        # --- Process Clean Audio (Enrollment) ---
        for i, clip in enumerate(clean_clips):
            mp3_path = os.path.join(CLIPS_DIR, clip)
            wav_name = f"{spk_name}_clean_{i}.wav"
            out_path = os.path.join(CLEAN_DIR, wav_name)
            
            # Load MP3 and save as 16kHz WAV
            try:
                wav, sr = torchaudio.load(mp3_path)
                if sr != 16000:
                    wav = torchaudio.functional.resample(wav, sr, 16000)
                torchaudio.save(out_path, wav, 16000)
            except Exception as e:
                print(f"Failed to process {clip}: {e}")

        # --- Process Telephony Audio (Verification) ---
        for i, clip in enumerate(telephony_clips):
            mp3_path = os.path.join(CLIPS_DIR, clip)
            wav_name = f"{spk_name}_telephony_{i}.wav"
            out_path = os.path.join(TELEPHONY_DIR, wav_name)
            
            try:
                wav, sr = torchaudio.load(mp3_path)
                
                # Apply Simulator (8kHz, Bandpass, Noise)
                mangled_wav, out_sr = sim.process(wav, sr, snr_db=15)
                
                # Save the mangled audio
                torchaudio.save(out_path, mangled_wav, out_sr)
            except Exception as e:
                print(f"Failed to process {clip}: {e}")

    print(f"\n✅ Preparation Complete! Evaluation data saved to '{OUTPUT_DIR}'")

if __name__ == "__main__":
    main()