import os
import json
import random
import torchaudio
from tqdm import tqdm

# --- CONFIGURATION ---
TRAIN_DIR = "data/train_telephony"
MANIFEST_DIR = "data/manifests"

TRAIN_JSON_PATH = os.path.join(MANIFEST_DIR, "train.json")
VALID_JSON_PATH = os.path.join(MANIFEST_DIR, "valid.json")

VALIDATION_SPLIT = 0.10  # 10% of data used for validation during training

def main():
    print("🚀 Generating SpeechBrain JSON Manifests...")
    os.makedirs(MANIFEST_DIR, exist_ok=True)
    
    train_dict = {}
    valid_dict = {}
    
    # Get all speaker folders (e.g., TRN_000, TRN_001)
    speakers = [d for d in os.listdir(TRAIN_DIR) if os.path.isdir(os.path.join(TRAIN_DIR, d))]
    
    total_files = 0
    corrupt_files = 0

    for spk in tqdm(speakers, desc="Scanning Speakers"):
        spk_dir = os.path.join(TRAIN_DIR, spk)
        wav_files = [f for f in os.listdir(spk_dir) if f.endswith('.wav')]
        
        # Shuffle files to ensure random distribution between train and valid sets
        random.shuffle(wav_files)
        
        split_idx = int(len(wav_files) * (1 - VALIDATION_SPLIT))
        train_files = wav_files[:split_idx]
        valid_files = wav_files[split_idx:]
        
        # Helper function to process a list of files into a dictionary
        def process_files(file_list, target_dict):
            nonlocal total_files, corrupt_files
            for wav_file in file_list:
                wav_path = os.path.join(spk_dir, wav_file)
                
                # Use torchaudio.info to get duration WITHOUT loading the file into RAM
                try:
                    info = torchaudio.info(wav_path)
                    duration = info.num_frames / info.sample_rate
                    
                    # Ignore files that are too short (e.g., less than 2 seconds) 
                    # as they don't contain enough voice biometric data
                    if duration < 2.0:
                        continue
                        
                    # Create a unique ID for the utterance (e.g., "TRN_001_common_voice_ur_12345")
                    utt_id = f"{spk}_{wav_file.replace('.wav', '')}"
                    
                    target_dict[utt_id] = {
                        "wav": wav_path,
                        "length": duration,
                        "spk_id": spk
                    }
                    total_files += 1
                except Exception:
                    corrupt_files += 1

        process_files(train_files, train_dict)
        process_files(valid_files, valid_dict)

    # Save to JSON
    print("\nSaving manifests to disk...")
    with open(TRAIN_JSON_PATH, 'w', encoding='utf-8') as f:
        json.dump(train_dict, f, indent=4)
        
    with open(VALID_JSON_PATH, 'w', encoding='utf-8') as f:
        json.dump(valid_dict, f, indent=4)

    print("\n" + "="*40)
    print("✅ MANIFEST GENERATION COMPLETE")
    print("="*40)
    print(f"Total valid files indexed: {total_files}")
    print(f"Files dropped (too short/corrupt): {corrupt_files}")
    print(f"Training utterances:   {len(train_dict)}")
    print(f"Validation utterances: {len(valid_dict)}")
    print("="*40)

if __name__ == "__main__":
    main()