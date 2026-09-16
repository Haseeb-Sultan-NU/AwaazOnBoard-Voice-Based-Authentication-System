import torch
import torch.nn as nn

class UrduDigitCRNN(nn.Module):
    def __init__(self, num_classes=11):
        super(UrduDigitCRNN, self).__init__()
        
        # We have 11 classes: 0-9 (Urdu words) + 1 blank token for CTC loss
        self.num_classes = num_classes

        # 1. The "Ears" (CNN Feature Extractor)
        # Assuming input features are Mel-Spectrograms with 64 mel-bands
        self.cnn = nn.Sequential(
            nn.Conv1d(in_channels=64, out_channels=128, kernel_size=5, stride=1, padding=2),
            nn.BatchNorm1d(128),
            nn.ReLU(),
            nn.MaxPool1d(kernel_size=2, stride=2),
            
            nn.Conv1d(in_channels=128, out_channels=256, kernel_size=5, stride=1, padding=2),
            nn.BatchNorm1d(256),
            nn.ReLU(),
            nn.MaxPool1d(kernel_size=2, stride=2)
        )

        # 2. The "Memory" (Recurrent Sequence Tracker)
        # Using GRU instead of LSTM because it is faster and smaller (protecting the 2000ms SLA)
        self.gru = nn.GRU(
            input_size=256, 
            hidden_size=128, 
            num_layers=2, 
            batch_first=True, 
            bidirectional=True
        )

        # 3. The "Mouth" (Final Classifier)
        # GRU is bidirectional, so hidden_size is 128 * 2 = 256
        self.fc = nn.Linear(256, self.num_classes)

    def forward(self, x):
        # x shape expected: (batch_size, num_mel_bands, time_steps)
        
        # Pass through CNN
        x = self.cnn(x)
        
        # Reshape for GRU: (batch_size, time_steps, features)
        x = x.permute(0, 2, 1)
        
        # Pass through GRU
        x, _ = self.gru(x)
        
        # Pass through fully connected layer to get class probabilities
        x = self.fc(x)
        
        # CTC loss expects shape: (time_steps, batch_size, num_classes)
        x = x.log_softmax(2)
        x = x.permute(1, 0, 2)
        
        return x

# Quick test to ensure the math checks out
if __name__ == "__main__":
    model = UrduDigitCRNN(num_classes=11)
    # Mock Mel-spectrogram: 1 batch, 64 mel bands, 200 time steps (approx 2 seconds of audio)
    mock_input = torch.randn(1, 64, 200)
    output = model(mock_input)
    print(f"Model initialized successfully. Output shape for CTC: {output.shape}")