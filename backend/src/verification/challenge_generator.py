import secrets
import os
from pydub import AudioSegment

class ChallengeGenerator:
    def __init__(self, prompt_audio_dir="data/prompts/urdu_digits/"):
        self.prompt_audio_dir = prompt_audio_dir
        # Ensure the directory exists so the code doesn't crash on first run
        os.makedirs(self.prompt_audio_dir, exist_ok=True)
        
    def generate_numeric_challenge(self, length=3):
        """
        Generates a cryptographically secure sequence of random digits.
        Returns: list of integers (e.g., [4, 9, 1])
        """
        return [secrets.choice(range(10)) for _ in range(length)]

    def stitch_audio_prompt(self, digit_sequence, output_format="wav", target_sample_rate=8000):
        """
        Concatenates the pre-recorded .wav files using pydub.
        Dynamically adjusts the sample rate so "good audio doesn't go bad."
        """
        # Start with an empty audio buffer
        combined_audio = AudioSegment.empty()
        
        for digit in digit_sequence:
            # Look for 0.wav, 1.wav, etc. in your directory
            filepath = os.path.join(self.prompt_audio_dir, f"{digit}.wav")
            
            if not os.path.exists(filepath):
                raise FileNotFoundError(f"Missing audio file for digit: {digit}. Please record {digit}.wav")
            
            # Load the audio (pydub automatically handles format mismatches here)
            digit_audio = AudioSegment.from_wav(filepath)
            combined_audio += digit_audio
            
            # Add a tiny 250ms silence between numbers so it sounds natural, not rushed
            combined_audio += AudioSegment.silent(duration=250)

        # Enforce the target sample rate dynamically 
        # (e.g., 8000 for legacy telecom, 16000 for your web app frontend)
        combined_audio = combined_audio.set_frame_rate(target_sample_rate).set_channels(1)
        
        # Save to a temporary file to serve to the frontend/app
        output_path = f"tmp_challenge_{secrets.token_hex(4)}.{output_format}"
        combined_audio.export(output_path, format=output_format)
        
        return {
            "sequence": digit_sequence,
            "audio_file_path": output_path
        }