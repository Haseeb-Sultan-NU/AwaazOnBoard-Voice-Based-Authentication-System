import sys
import os

# Add the project root to the path so it can find the src folder
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from src.verification.digit_asr import UrduASRInference

print("Loading Model...")
# Ensure this path matches where your .pth file actually is saved.
# If it is inside the 'models' folder, change this to "models/urdu_digit_asr_final.pth"
asr_engine = UrduASRInference(model_path="models/urdu_digit_asr_final.pth") 

print("Processing Windows Recording...")
# Make sure you are passing the converted .wav file, NOT the .m4a!
result = asr_engine.transcribe("Recording (8).wav")

print("\n==================================")
print(f"AI PREDICTION: {result}")
print("==================================")