import difflib

class LivenessValidator:
    def __init__(self, pass_threshold=0.80):
        """
        pass_threshold: 0.80 means the spoken words must match the challenge 
        with at least 80% accuracy to pass the liveness check.
        """
        self.pass_threshold = pass_threshold
        
        # Map the generator's integers to the ASR's words to compare apples to apples
        self.digit_to_word = {
            0: "sifar", 1: "ek", 2: "do", 3: "teen", 4: "char", 
            5: "panch", 6: "che", 7: "saat", 8: "aath", 9: "nau"
        }

    def evaluate_challenge(self, original_challenge, asr_transcription):
        """
        Compares the integer array from ChallengeGenerator to the word array from DigitASR.
        
        original_challenge: e.g., [4, 9, 1]
        asr_transcription: e.g., ['char', 'nau', 'ek']
        """
        # Convert [4, 9, 1] -> ['char', 'nau', 'ek']
        expected_words = [self.digit_to_word[digit] for digit in original_challenge]
        
        # Calculate the sequence match ratio (Fuzzy String Matching)
        matcher = difflib.SequenceMatcher(None, expected_words, asr_transcription)
        confidence_score = matcher.ratio()
        
        # Determine pass or fail
        passed = confidence_score >= self.pass_threshold
        
        return {
            "liveness_passed": passed,
            "confidence_score": round(confidence_score * 100, 2),
            "expected_sequence": expected_words,
            "detected_sequence": asr_transcription,
            "status_message": "Liveness Verified." if passed else "Liveness Failed: Audio did not match the requested prompt."
        }

# --- Quick Integration Test ---
if __name__ == "__main__":
    validator = LivenessValidator(pass_threshold=0.80)
    
    # Simulating the exact outputs from your other files:
    system_challenge = [3, 3, 1]           # From challenge_generator.py
    user_audio_result = ['teen', 'teen', 'ek'] # From digit_asr.py
    
    result = validator.evaluate_challenge(system_challenge, user_audio_result)
    
    print("\n--- Perfect Match Test ---")
    for key, value in result.items():
        print(f"{key}: {value}")
        
    print("\n--- Failed / Spoofed Test ---")
    # What if a hacker plays a pre-recorded phrase of "do char"?
    hacker_audio = ['do', 'char'] 
    failed_result = validator.evaluate_challenge(system_challenge, hacker_audio)
    for key, value in failed_result.items():
        print(f"{key}: {value}")