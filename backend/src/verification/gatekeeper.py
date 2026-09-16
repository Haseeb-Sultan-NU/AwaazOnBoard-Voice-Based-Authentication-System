import os
import torch
import torchaudio
from pyannote.audio import Pipeline

# Force torchaudio to use soundfile (Native Windows Fix)
torchaudio.set_audio_backend("soundfile")

class SecurityGatekeeper:
    def __init__(self, hf_token):
        print("Initializing Security Gatekeeper (pyannote.audio)...")
        try:
            # use_auth_token is explicitly required for pyannote.audio 3.1.1
            self.pipeline = Pipeline.from_pretrained(
                "pyannote/speaker-diarization-3.1",
                use_auth_token=hf_token
            )
            if self.pipeline is None:
                raise ValueError("Pipeline returned None. Check HF_TOKEN and model access agreements.")
        except Exception as e:
            print(f"[!] Fatal error loading Pyannote: {e}")
            self.pipeline = None

    def check_audio_security(self, audio_path):
        if not self.pipeline:
            return False, "Gatekeeper offline. Check initialization."

        if not os.path.exists(audio_path):
            return False, "Audio file not found."

        try:
            # 1. Native safe load
            waveform, sample_rate = torchaudio.load(audio_path)

            # 2. Force Mono
            if waveform.shape[0] > 1:
                waveform = waveform.mean(dim=0, keepdim=True)

            # 3. Force 16kHz Resampling
            if sample_rate != 16000:
                resampler = torchaudio.transforms.Resample(orig_freq=sample_rate, new_freq=16000)
                waveform = resampler(waveform)

            # 4. Anti-Crash Padding (Prevents the std() <= 0 error on short clips)
            min_frames = 16000 * 3 # Minimum 3 seconds
            if waveform.shape[1] < min_frames:
                padding = min_frames - waveform.shape[1]
                waveform = torch.nn.functional.pad(waveform, (0, padding))

            # 5. Execute natively via dict
            audio_in_memory = {"waveform": waveform, "sample_rate": 16000}
            diarization = self.pipeline(audio_in_memory)

            # 6. Parse Speakers
            speakers = set()
            for turn, _, speaker in diarization.itertracks(yield_label=True):
                speakers.add(speaker)

            num_speakers = len(speakers)

            if num_speakers == 0:
                return False, "REJECT: No human speech detected."
            elif num_speakers > 1:
                return False, f"REJECT: Multiple speakers ({num_speakers}) detected. Potential coercion."
            else:
                return True, "ACCEPT: Single, isolated speaker verified."

        except Exception as e:
            return False, f"Crash during processing: {e}"

if __name__ == "__main__":
    print("Security Gatekeeper module ready.")