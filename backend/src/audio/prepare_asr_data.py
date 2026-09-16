import os
import random
import torch
import torchaudio
import soundfile as sf
import json

class ASRDataGenerator:
    def __init__(self, raw_data_dir="data/training/raw_urdu_digits/", output_dir="data/training/asr_processed/"):
        self.raw_data_dir = raw_data_dir
        self.output_dir = output_dir
        os.makedirs(self.output_dir, exist_ok=True)
        
        self.label_map = {
            "0": "sifar", "1": "ek", "2": "do", "3": "teen", "4": "char", 
            "5": "panch", "6": "che", "7": "saat", "8": "aath", "9": "nau"
        }

    def _get_random_audio_for_digit(self, digit):
        folder_path = os.path.join(self.raw_data_dir, str(digit))
        files = os.listdir(folder_path)
        selected_file = random.choice(files)
        filepath = os.path.join(folder_path, selected_file)
        
        waveform_np, sample_rate = sf.read(filepath, dtype='float32')
        if waveform_np.ndim == 1:
            waveform = torch.from_numpy(waveform_np).unsqueeze(0)
        else:
            waveform = torch.from_numpy(waveform_np).t()
            
        return waveform, sample_rate

    def generate_multi_condition_sequence(self, num_samples, sequence_length=3):
        manifest = [] 

        for i in range(num_samples):
            sequence = [str(random.randint(0, 9)) for _ in range(sequence_length)]
            audio_clips = []
            transcript = []
            target_sr = 16000 
            
            for digit in sequence:
                waveform, sr = self._get_random_audio_for_digit(digit)
                if sr != target_sr:
                    resampler = torchaudio.transforms.Resample(orig_freq=sr, new_freq=target_sr)
                    waveform = resampler(waveform)
                if waveform.shape[0] > 1:
                    waveform = torch.mean(waveform, dim=0, keepdim=True)
                audio_clips.append(waveform)
                
                pause_length = int(target_sr * random.uniform(0.1, 0.4))
                audio_clips.append(torch.zeros((1, pause_length)))
                transcript.append(self.label_map[digit])

            transcript_text = " ".join(transcript)
            combined_audio = torch.cat(audio_clips, dim=1)

            # Export CLEAN
            clean_filename = os.path.abspath(os.path.join(self.output_dir, f"clean_seq_{i}.wav"))
            sf.write(clean_filename, combined_audio.squeeze(0).numpy(), target_sr)
            manifest.append({"audio_filepath": clean_filename, "text": transcript_text, "condition": "clean"})

            # Export DEGRADED
            degraded_filename = os.path.abspath(os.path.join(self.output_dir, f"degraded_seq_{i}.wav"))
            resampler_8k = torchaudio.transforms.Resample(target_sr, 8000)
            degraded_audio = resampler_8k(combined_audio)
            sf.write(degraded_filename, degraded_audio.squeeze(0).numpy(), 8000)
            manifest.append({"audio_filepath": degraded_filename, "text": transcript_text, "condition": "degraded_8khz"})
            
            if i % 50 == 0:
                print(f"Generated {i} / {num_samples} pairs...")

        # Save the Manifest
        manifest_path = os.path.join(self.output_dir, "manifest.json")
        with open(manifest_path, 'w') as f:
            json.dump(manifest, f, indent=4)
        
        print(f"Successfully generated {len(manifest)} files and manifest.json")
        return manifest

if __name__ == "__main__":
    generator = ASRDataGenerator()
    print("Generating MASSIVE Multi-Condition Dataset for Production Training...")
    # Cranked up to 10,000 samples (yields 20,000 total files)
    generator.generate_multi_condition_sequence(num_samples=10000, sequence_length=3)
    print("Generation complete! Ready for heavy training.")