import torch
import torch.nn as nn
import torch.optim as optim
import torchaudio
import soundfile as sf
import os
import json
from torch.utils.data import Dataset, DataLoader
from src.verification.crnn_model import UrduDigitCRNN

class UrduDigitDataset(Dataset):
    def __init__(self, data_dir="data/training/asr_processed/", sample_limit=None):
        manifest_path = os.path.join(data_dir, "manifest.json")
        with open(manifest_path, 'r') as f:
            self.manifest = json.load(f)
            
        if sample_limit:
            self.manifest = self.manifest[:sample_limit]
            
        self.word_to_id = {
            "sifar": 0, "ek": 1, "do": 2, "teen": 3, "char": 4, 
            "panch": 5, "che": 6, "saat": 7, "aath": 8, "nau": 9
        }
        self.mel_transform = torchaudio.transforms.MelSpectrogram(
            sample_rate=8000, n_mels=64, n_fft=400, hop_length=160
        )

    def __len__(self):
        return len(self.manifest)

    def __getitem__(self, idx):
        item = self.manifest[idx]
        waveform_np, sample_rate = sf.read(item['audio_filepath'], dtype='float32')
        waveform = torch.from_numpy(waveform_np).unsqueeze(0) if waveform_np.ndim == 1 else torch.from_numpy(waveform_np).t()

        if sample_rate != 8000:
            waveform = torchaudio.transforms.Resample(sample_rate, 8000)(waveform)
        
        mel_spec = self.mel_transform(waveform).squeeze(0)
        target = torch.tensor([self.word_to_id[w] for w in item['text'].split()], dtype=torch.long)
        return mel_spec, target

def collate_fn(batch):
    mels, targets = zip(*batch)
    mels_padded = torch.nn.utils.rnn.pad_sequence([m.transpose(0, 1) for m in mels], batch_first=True).transpose(1, 2)
    input_lengths = torch.tensor([m.shape[1] for m in mels], dtype=torch.long)
    target_lengths = torch.tensor([len(t) for t in targets], dtype=torch.long)
    targets_padded = torch.nn.utils.rnn.pad_sequence(targets, batch_first=True)
    return mels_padded, targets_padded, input_lengths, target_lengths

def start_training(epochs=20):
    device = torch.device("cpu")
    dataset = UrduDigitDataset()
    dataloader = DataLoader(dataset, batch_size=16, shuffle=True, collate_fn=collate_fn)
    
    model = UrduDigitCRNN(num_classes=11).to(device)
    criterion = nn.CTCLoss(blank=10, zero_infinity=True)
    optimizer = optim.Adam(model.parameters(), lr=0.001)
    
    os.makedirs("models", exist_ok=True)
    
    print(f"Starting Training for {epochs} epochs...")
    model.train()
    for epoch in range(epochs):
        total_loss = 0
        for mels, targets, in_lens, tar_lens in dataloader:
            optimizer.zero_grad()
            outputs = model(mels.to(device))
            loss = criterion(outputs, targets.to(device), in_lens // 4, tar_lens)
            loss.backward()
            optimizer.step()
            total_loss += loss.item()
        
        avg_loss = total_loss / len(dataloader)
        print(f"Epoch {epoch+1}/{epochs} | Average Loss: {avg_loss:.4f}")
        
        # Save checkpoint every 5 epochs
        if (epoch + 1) % 5 == 0:
            torch.save(model.state_dict(), f"models/asr_checkpoint_epoch_{epoch+1}.pth")

    torch.save(model.state_dict(), "models/urdu_digit_asr_final.pth")
    print("Training Complete. Final model saved.")

if __name__ == "__main__":
    start_training(epochs=30)