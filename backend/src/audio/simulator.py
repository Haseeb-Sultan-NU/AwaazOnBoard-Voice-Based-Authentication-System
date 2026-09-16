import torch
import torchaudio

class TelephonySimulator:
    def __init__(self, target_sr=8000):
        self.target_sr = target_sr

    def resample(self, waveform, orig_sr):
        if orig_sr == self.target_sr:
            return waveform
        return torchaudio.functional.resample(waveform, orig_sr, self.target_sr)

    def apply_telephony_filter(self, waveform):
        # 300Hz - 3400Hz PSTN Bandpass
        waveform = torchaudio.functional.highpass_biquad(waveform, self.target_sr, cutoff_freq=300.0)
        waveform = torchaudio.functional.lowpass_biquad(waveform, self.target_sr, cutoff_freq=3400.0)
        return waveform

    def add_white_noise(self, waveform, snr_db=15):
        signal_power = waveform.norm(p=2) ** 2 / waveform.numel()
        noise_power = signal_power / (10.0 ** (snr_db / 10.0))
        noise = torch.randn_like(waveform) * torch.sqrt(noise_power)
        return waveform + noise

    def process(self, waveform, orig_sr, snr_db=15):
        """The full production-grade pipeline without digital artifacts."""
        # Step 1: Resample to 8kHz (Standard Telephony)
        wav = self.resample(waveform, orig_sr)
        
        # Step 2: Apply PSTN Bandpass Filter
        wav = self.apply_telephony_filter(wav)
        
        # Step 3: Add Analog Line Noise
        wav = self.add_white_noise(wav, snr_db)
        
        # Final Normalization to prevent clipping
        max_val = torch.max(torch.abs(wav))
        if max_val > 1.0:
            wav = wav / max_val
            
        return wav, self.target_sr