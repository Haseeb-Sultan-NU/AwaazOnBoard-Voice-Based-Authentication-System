import requests
import json

BASE_URL = "http://localhost:8000"
USER_ID = "test_user_001"

# Define your test audio files (Make sure these exist!)
ENROLL_FILES = [
    "test_audio/enroll_1.wav",
    "test_audio/enroll_2.wav",
    "test_audio/enroll_3.wav"
]
VERIFY_FILE = "test_audio/verify_live.wav"

def test_health():
    print("\n--- 1. Testing Health ---")
    res = requests.get(f"{BASE_URL}/health")
    print(res.json())

def test_enrollment():
    print(f"\n--- 2. Testing Enrollment for {USER_ID} ---")
    
    # Open files in binary mode for multipart/form-data upload
    files = {
        "take_1": open(ENROLL_FILES[0], "rb"),
        "take_2": open(ENROLL_FILES[1], "rb"),
        "take_3": open(ENROLL_FILES[2], "rb"),
    }
    data = {"user_id": USER_ID}
    
    res = requests.post(f"{BASE_URL}/enroll", data=data, files=files)
    print(f"Status: {res.status_code}")
    print(res.json())
    
    # Close files
    for f in files.values():
        f.close()

def test_verification():
    print(f"\n--- 3. Testing Verification for {USER_ID} ---")
    
    # Let's assume the challenge we expect the user to say in 'verify_live.wav' is 2, 4, 5
    expected_challenge = "2,4,5" 
    
    files = {"audio_file": open(VERIFY_FILE, "rb")}
    data = {
        "user_id": USER_ID,
        "expected_challenge": expected_challenge
    }
    
    res = requests.post(f"{BASE_URL}/verify", data=data, files=files)
    print(f"Status: {res.status_code}")
    print(json.dumps(res.json(), indent=2))
    
    files["audio_file"].close()

if __name__ == "__main__":
    test_health()
    test_enrollment() # Run this once to create the .pt file
    test_verification() # Run this repeatedly to test liveness/biometrics