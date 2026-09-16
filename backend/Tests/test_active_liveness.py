import unittest
from src.verification.challenge_generator import ChallengeGenerator

class TestActiveLiveness(unittest.TestCase):
    def setUp(self):
        self.generator = ChallengeGenerator()

    def test_challenge_length(self):
        # Ensure the generator strictly outputs 3 digits
        sequence = self.generator.generate_numeric_challenge(length=3)
        self.assertEqual(len(sequence), 3)

if __name__ == '__main__':
    unittest.main()