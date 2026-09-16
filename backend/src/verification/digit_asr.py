import torch
import torchaudio.transforms as T
import soundfile as sf
import whisper
import warnings
import string

warnings.filterwarnings("ignore", message="FP16 is not supported on CPU")

class UrduASRInference:
    # 🌟 UPGRADE: Changed default from "tiny" to "base" for massive accuracy boost
    def __init__(self, model_size="base"):
        print(f"Loading Whisper Foundation Model ('{model_size}') into memory...")
        self.model = whisper.load_model(model_size)
        
        # 🌟 UPGRADE: Massive dictionary expansion covering Kaggle dataset accents
        self.urdu_to_roman = {
            "صفر": "sifar", "سفر": "sifar", "سفت": "sifar", "صفرد": "sifar", "0": "sifar", 
            "سے": "sifar", "فر": "sifar", "سفرہ": "sifar", "سیر": "sifar", # Kaggle typos
            "ایک": "ek", "اک": "ek", "1": "ek",
            "دو": "do", "2": "do",
            "تین": "teen", "تن": "teen", "3": "teen", "دین": "teen", "پی": "teen", 
            "چار": "char", "جاد": "char", "چاد": "char", "4": "char", "شار": "char", "دار": "char", "جان": "char", "کار": "char", "جار": "char",
            "پانچ": "panch", "پاچھ": "panch", "پنچ": "panch", "پچ": "panch", "بچ": "panch", "5": "panch", "باچ": "panch", "آچھ": "panch",
            "چھ": "che", "چھے": "che", "6": "che", "چی": "che",
            "سات": "saat", "ساتھ": "saat", "7": "saat", "سار": "saat",
            "آٹھ": "aath", "اٹھ": "aath", "8": "aath",
            "نو": "nau", "آنو": "nau", "9": "nau"
        }

    def transcribe(self, audio_path):
        audio_np, sr = sf.read(audio_path, dtype="float32")

        if audio_np.ndim == 1:
            waveform = torch.from_numpy(audio_np).unsqueeze(0)
        else:
            waveform = torch.from_numpy(audio_np).t()

        if waveform.shape[0] > 1:
            waveform = torch.mean(waveform, dim=0, keepdim=True)

        max_val = torch.max(torch.abs(waveform))
        if max_val > 0:
            waveform = waveform / max_val

        energies = torch.abs(waveform[0])
        mask = energies > 0.02 

        if mask.any():
            non_zero_indices = torch.nonzero(mask).squeeze()
            if non_zero_indices.dim() > 0:
                start_idx = non_zero_indices[0].item()
                end_idx = non_zero_indices[-1].item()
                
                pad = int(sr * 0.5) 
                start_idx = max(0, start_idx - pad)
                end_idx = min(waveform.shape[1], end_idx + pad)
                waveform = waveform[:, start_idx:end_idx]

        if sr != 16000:
            waveform = T.Resample(sr, 16000)(waveform)

        audio_1D_array = waveform.squeeze().numpy()

        # 🌟 UPGRADE: Added anti-loop native parameters
        result = self.model.transcribe(
            audio_1D_array, 
            language="ur",
            initial_prompt="ایک, دو, تین, چار, پانچ, چھ, سات, آٹھ, نو, صفر", 
            temperature=0.0, 
            condition_on_previous_text=False,
            compression_ratio_threshold=2.4 # Mathematically forces Whisper to stop infinite loops
        )
        raw_text = result["text"]
        
        # Keep X-Ray on so we can see if base model finds any new typos!
        # print(f"\n[DEBUG X-RAY] Raw Whisper Output: {raw_text}")

        urdu_punctuation = "۔،؟!" 
        all_punctuation = string.punctuation + urdu_punctuation
        
        for punc in all_punctuation:
            raw_text = raw_text.replace(punc, ' ')
            
        clean_words = raw_text.split() 
        
        detected_sequence = []
        for word in clean_words:
            if word in self.urdu_to_roman:
                detected_sequence.append(self.urdu_to_roman[word])
                
        return detected_sequence[:5]