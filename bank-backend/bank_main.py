"""
FinSecure — B2B Bank Backend
============================
Standalone FastAPI app that consumes the Awaaz Identity Provider (port 8000)
for voice-based login, and exposes an Urdu voice-banking agent:

    audio ──► Awaaz ECAPA-TDNN (continuous auth) ──► Whisper ASR ──► Urdu intent/amount parser ──► SQLite ledger

The ASR stage reuses the exact Whisper checkpoint the Awaaz backend loads
(`UrduASRInference(model_size="small")` in backend/main.py). The weights are read
from the local Whisper cache and are never downloaded, so this service cannot
pull a larger model and cause VRAM OOM. Start the Awaaz backend first on a fresh
machine: it downloads small.pt into the shared cache on its first boot.

Run (Whisper and its deps already live in backend/venv):
    ..\\backend\\venv\\Scripts\\python -m uvicorn bank_main:app --host 0.0.0.0 --port 8001 --reload

Env:
    BANK_ASR_DEVICE   auto | cpu | cuda   (default: auto)
    WHISPER_CACHE_DIR override the Whisper weights directory
"""

import os
import re
import random
import secrets
import tempfile
import threading
import time
import unicodedata
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional

import requests
from fastapi import FastAPI, File, Form, UploadFile, HTTPException, Depends
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import Column, String, Float, Integer, DateTime, ForeignKey, Text, create_engine
from sqlalchemy.orm import sessionmaker, declarative_base, Session

# ═══════════════════════════════════════════════════════════════
# CONFIG
# ═══════════════════════════════════════════════════════════════

AWAAZ_VERIFY_URL = "http://localhost:8000/authenticate/verify"
# Step-up auth for spoken commands: Gatekeeper + ECAPA-TDNN, no digit challenge.
AWAAZ_CONTINUOUS_URL = "http://localhost:8000/authenticate/continuous"
COMMAND_SESSION_ID = "tx_command"
AWAAZ_TIMEOUT_SECONDS = 60
BIOMETRIC_BLOCK_MSG = "Transaction blocked: Biometric voice signature did not match the account owner."
ECAPA_EER_THRESHOLD = 0.2393  # mirrors backend/main.py; used only when Awaaz omits "threshold"

# Step-up voice confirmation for high-value transfers
HIGH_VALUE_THRESHOLD_PKR = 10_000.0
CONFIRMATION_TTL_SECONDS = 120
CONFIRMATION_MAX_ATTEMPTS = 3
DATABASE_URL = "sqlite:///./bank_data.db"

# Must match backend/main.py -> UrduASRInference(model_size="small").
# Same checkpoint file (~/.cache/whisper/small.pt), but each process holds its own copy in RAM.
WHISPER_MODEL_SIZE = "small"
WHISPER_CACHE_DIR = os.getenv(
    "WHISPER_CACHE_DIR",
    os.path.join(os.getenv("XDG_CACHE_HOME", os.path.join(os.path.expanduser("~"), ".cache")), "whisper"),
)
ASR_DEVICE_PREF = os.getenv("BANK_ASR_DEVICE", "auto").lower()

MAX_AUDIO_BYTES = 10 * 1024 * 1024
MIN_AUDIO_SECONDS = 0.4
MAX_AUDIO_SECONDS = 30.0

MIN_TRANSFER_PKR = 1.0
VOICE_TRANSFER_LIMIT_PKR = 500_000.0
DEFAULT_RECIPIENT = "Raast Transfer"

# ═══════════════════════════════════════════════════════════════
# DATABASE
# ═══════════════════════════════════════════════════════════════

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


class Account(Base):
    __tablename__ = "accounts"

    cnic = Column(String(15), primary_key=True, index=True)
    full_name = Column(String(120), nullable=False)
    balance = Column(Float, nullable=False, default=0.0)


class Transaction(Base):
    __tablename__ = "transactions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    reference = Column(String(20), unique=True, nullable=False, index=True)
    cnic = Column(String(15), ForeignKey("accounts.cnic"), nullable=False, index=True)
    direction = Column(String(6), nullable=False)          # DEBIT | CREDIT
    category = Column(String(20), nullable=False)          # matches frontend Category
    counterparty = Column(String(120), nullable=False)
    amount = Column(Float, nullable=False)                 # always positive
    balance_after = Column(Float, nullable=False)
    channel = Column(String(12), nullable=False, default="VOICE")
    transcript = Column(Text, nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.now)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


SEED_ACCOUNTS = [
    {"cnic": "1111111111111", "full_name": "Haseeb Sultan", "balance": 50000.0},
    {"cnic": "3333333333333", "full_name": "Ayesha Siddiqui", "balance": 50000.0},
]


def seed_database() -> None:
    """Create tables and ensure seed accounts exist. Never resets an existing balance."""
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        for seed in SEED_ACCOUNTS:
            acc = db.query(Account).filter(Account.cnic == seed["cnic"]).first()
            if not acc:
                db.add(Account(**seed))
                print(f"🌱 Seeded account: {seed['cnic']} ({seed['full_name']}, PKR {seed['balance']:,.0f})")
            elif acc.full_name != seed["full_name"]:
                acc.full_name = seed["full_name"]
                print(f"🌱 Renamed account holder: {seed['cnic']} -> {seed['full_name']}")
        db.commit()
    finally:
        db.close()


# ═══════════════════════════════════════════════════════════════
# APP
# ═══════════════════════════════════════════════════════════════

app = FastAPI(title="FinSecure Bank API", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3001", "http://127.0.0.1:3001"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def on_startup():
    seed_database()
    # Warm the ASR model so the first voice command isn't slow. Failure is
    # non-fatal: login keeps working and /bank/command reports a 503.
    try:
        transcriber.load()
    except Exception as e:
        print(f"⚠️  Urdu ASR not loaded at startup: {e}")


# ═══════════════════════════════════════════════════════════════
# HELPERS
# ═══════════════════════════════════════════════════════════════

def normalize_cnic(cnic: str) -> str:
    """Strip dashes/spaces so '33333-3333333-3' == '3333333333333'."""
    return re.sub(r"\D", "", cnic or "")


def account_to_dict(acc: Account) -> dict:
    return {"cnic": acc.cnic, "full_name": acc.full_name, "name": acc.full_name, "balance": acc.balance}


def date_label(d: datetime) -> str:
    return f"{d.day} {d.strftime('%b %Y')}"


def awaaz_response_is_pass(resp: requests.Response) -> bool:
    """
    Interpret the Awaaz verify response defensively, since the exact
    success payload shape may vary. Treats the call as a PASS if the HTTP
    status is 2xx AND the JSON body indicates success in any common form.
    """
    if not resp.ok:
        return False
    try:
        body = resp.json()
    except ValueError:
        return False

    if not isinstance(body, dict):
        return False

    # Explicit failure flags win
    if body.get("success") is False or body.get("verified") is False:
        return False
    if body.get("authenticated") is False:
        return False

    status = str(body.get("status", "")).upper()
    if status:
        return status in {"PASS", "GRANTED", "SUCCESS", "OK"}

    return bool(
        body.get("success") is True
        or body.get("verified") is True
        or body.get("authenticated") is True
    )


# ═══════════════════════════════════════════════════════════════
# ASR — Whisper (same checkpoint as the Awaaz backend)
# ═══════════════════════════════════════════════════════════════

# Financial vocabulary hint so Whisper spells amounts/verbs correctly.
# Prompt regurgitation on silence is contained by: the biometric Gatekeeper
# (rejects non-speech before ASR), no_speech_prob, and _is_prompt_echo().
ASR_PROMPT = "پانچ سو ہزار لاکھ روپے علی کو بھیجو ٹرانسفر بیلنس"
# A spoken command is < 30 tokens; capping decode length stops a repetition loop
# from burning ~20 s of CPU before the quality check can reject it.
CONFIRM_PROMPT = "ہاں جی کنفرم منظور confirm yes"
ASR_MAX_TOKENS = 48  # longest realistic compound command measured at 41 tokens


class UrduSpeechTranscriber:
    """Lazy, thread-safe wrapper around a locally cached Whisper checkpoint."""

    def __init__(self, model_size: str, cache_dir: str, device_pref: str):
        self.model_size = model_size
        self.cache_dir = cache_dir
        self.device_pref = device_pref
        self.device: Optional[str] = None
        self._model = None
        self._load_lock = threading.Lock()
        self._infer_lock = threading.Lock()  # Whisper models are not thread-safe

    @property
    def weights_path(self) -> str:
        return os.path.join(self.cache_dir, f"{self.model_size}.pt")

    def load(self):
        if self._model is not None:
            return self._model
        with self._load_lock:
            if self._model is not None:
                return self._model

            if not os.path.isfile(self.weights_path):
                # Refuse to let whisper.load_model() download anything.
                raise RuntimeError(
                    f"Whisper '{self.model_size}' weights not found at {self.weights_path}. "
                    "Start the Awaaz backend once to cache them; this service never downloads models."
                )

            import torch
            import whisper

            want_cuda = self.device_pref == "cuda" or (self.device_pref == "auto" and torch.cuda.is_available())
            device = "cuda" if want_cuda else "cpu"
            try:
                model = whisper.load_model(self.model_size, device=device, download_root=self.cache_dir)
            except RuntimeError as e:
                if device != "cuda" or "out of memory" not in str(e).lower():
                    raise
                print("⚠️  CUDA OOM loading Whisper for the bank agent; falling back to CPU.")
                torch.cuda.empty_cache()
                device = "cpu"
                model = whisper.load_model(self.model_size, device=device, download_root=self.cache_dir)

            self._model, self.device = model, device
            print(f"🎙️  Bank ASR ready: Whisper '{self.model_size}' on {device}")
            return model

    @staticmethod
    def _load_audio_16k(path: str):
        """Decode to mono float32 @16 kHz. WAV via soundfile, anything else via ffmpeg."""
        import numpy as np

        try:
            import soundfile as sf
            audio, sr = sf.read(path, dtype="float32", always_2d=True)
            audio = audio.mean(axis=1)
        except Exception:
            import whisper
            return whisper.load_audio(path)  # ffmpeg → 16 kHz mono float32

        if sr != 16000:
            try:
                import torch
                import torchaudio.functional as AF
                audio = AF.resample(torch.from_numpy(np.ascontiguousarray(audio)), sr, 16000).numpy()
            except ImportError:
                n = int(round(len(audio) * 16000 / sr))
                audio = np.interp(np.linspace(0, len(audio) - 1, n), np.arange(len(audio)), audio)
        return audio.astype(np.float32)

    def transcribe(self, path: str, prompt: str = ASR_PROMPT) -> str:
        """Return the raw Urdu transcript, or "" when no speech is present."""
        import numpy as np

        model = self.load()
        audio = self._load_audio_16k(path)

        duration = len(audio) / 16000
        if duration < MIN_AUDIO_SECONDS:
            raise ValueError("Recording is too short. Hold the mic and speak your full command.")
        if duration > MAX_AUDIO_SECONDS:
            raise ValueError(f"Recording is too long ({duration:.0f}s). Keep commands under {MAX_AUDIO_SECONDS:.0f} seconds.")

        peak = float(np.max(np.abs(audio))) if audio.size else 0.0
        # Check for voice on the raw signal: peak-normalising first would turn a
        # quiet room into full-scale noise, which the primed decoder happily
        # "hears" as prompt words (e.g. "سو ہزار لاکھ روپے").
        if peak < 1e-3 or not self._has_voice_activity(audio):
            return ""
        audio = audio / peak * 0.95

        # Commands are capped at MAX_AUDIO_SECONDS (= one 30 s Whisper window), so the
        # audio is encoded once and both decode passes below reuse the same features.
        import whisper

        with self._infer_lock:
            mel = whisper.log_mel_spectrogram(
                whisper.pad_or_trim(audio), n_mels=model.dims.n_mels, device=model.device
            )
            if self.device == "cuda":
                mel = mel.half()
            features = model.embed_audio(mel.unsqueeze(0))[0]

            # Pass 1 — vocabulary-primed. Fixes Urdu spellings (بانچ → پانچ), but Whisper
            # 'small' sometimes copies the keyword prompt into a repetition loop
            # ("ٹرانسفر بیلنسفر بیلنسفر …"), which would mis-route the command.
            res = self._decode(model, features, prompt)
            problem = self._quality_problem(res, prompt)
            if problem is None:
                return res.text.strip()

            # Pass 2 — unbiased decode, only when pass 1 is unusable.
            print(f"[ASR] primed pass rejected ({problem}): {res.text.strip()[:80]!r} — retrying without prompt")
            res = self._decode(model, features, None)
            problem = self._quality_problem(res, prompt)

        if problem is None:
            return res.text.strip()
        if problem == "no speech":
            return ""
        print(f"[ASR] unprimed pass rejected ({problem}): {res.text.strip()[:80]!r}")
        raise ValueError("I couldn't make out your command clearly. Please speak a little slower and try again.")

    @staticmethod
    def _has_voice_activity(audio, min_active_s: float = 0.25) -> bool:
        """Energy VAD: enough 10 ms frames clearly above the recording's own noise floor."""
        import numpy as np

        hop = 160  # 10 ms @ 16 kHz
        n = len(audio) // hop
        if n == 0:
            return False
        rms = np.sqrt(np.mean(audio[: n * hop].reshape(n, hop) ** 2, axis=1))
        floor = float(np.percentile(rms, 20)) + 1e-6
        # +12 dB over the floor, or loud in absolute terms (covers pause-free speech).
        active = (rms > floor * 4) | (rms > 0.02)
        return int(active.sum()) * 0.01 >= min_active_s

    def _decode(self, model, features, prompt: Optional[str]):
        import whisper

        options = whisper.DecodingOptions(
            task="transcribe",
            language="ur",
            prompt=prompt,
            temperature=0.0,
            sample_len=ASR_MAX_TOKENS,  # a loop can't run to Whisper's 224-token default
            without_timestamps=True,
            fp16=(self.device == "cuda"),
        )
        return whisper.decode(model, features, options)

    @staticmethod
    def _quality_problem(res, prompt: str = "") -> Optional[str]:
        """Return why a decode is unusable, or None if it looks like a real utterance."""
        text = (res.text or "").strip()
        # Whisper's own silence rule: confident "no speech" AND a low-confidence decode.
        if res.no_speech_prob > 0.6 and res.avg_logprob < -1.0:
            return "no speech"
        if not text:
            return "empty"
        if len(res.tokens) >= ASR_MAX_TOKENS:
            return "hit length cap"
        if res.compression_ratio > 2.4:
            return "repetition loop"
        words = text.split()
        if len(words) >= 6 and Counter(words).most_common(1)[0][1] >= max(4, len(words) // 2):
            return "repetition loop"
        if prompt and _is_prompt_echo(text, prompt):
            return "prompt echo"
        return None


transcriber = UrduSpeechTranscriber(WHISPER_MODEL_SIZE, WHISPER_CACHE_DIR, ASR_DEVICE_PREF)


# ═══════════════════════════════════════════════════════════════
# NLU — Urdu / mixed Urdu-English intent & amount parser
# ═══════════════════════════════════════════════════════════════

_DIGIT_MAP = str.maketrans("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹", "01234567890123456789")
_CHAR_MAP = str.maketrans({
    "ي": "ی", "ى": "ی", "ك": "ک", "ه": "ہ", "ۀ": "ہ", "ۂ": "ہ", "ة": "ہ",
    "ـ": None, "‌": " ", "‍": None, "‏": None, "‎": None,
})
_DIACRITICS = re.compile(r"[ً-ٰٟۖ-ۭ]")

# Urdu has a distinct word for every number 1–99.
_URDU_1_TO_99 = (
    "ایک دو تین چار پانچ چھ سات آٹھ نو دس "
    "گیارہ بارہ تیرہ چودہ پندرہ سولہ سترہ اٹھارہ انیس بیس "
    "اکیس بائیس تئیس چوبیس پچیس چھبیس ستائیس اٹھائیس انتیس تیس "
    "اکتیس بتیس تینتیس چونتیس پینتیس چھتیس سینتیس اڑتیس انتالیس چالیس "
    "اکتالیس بیالیس تینتالیس چوالیس پینتالیس چھیالیس سینتالیس اڑتالیس انچاس پچاس "
    "اکاون باون ترپن چون پچپن چھپن ستاون اٹھاون انسٹھ ساٹھ "
    "اکسٹھ باسٹھ ترسٹھ چونسٹھ پینسٹھ چھیاسٹھ سڑسٹھ اڑسٹھ انہتر ستر "
    "اکہتر بہتر تہتر چوہتر پچہتر چھہتر ستتر اٹھہتر اناسی اسی "
    "اکاسی بیاسی تراسی چوراسی پچاسی چھیاسی ستاسی اٹھاسی نواسی نوے "
    "اکانوے بانوے ترانوے چورانوے پچانوے چھیانوے ستانوے اٹھانوے ننانوے"
).split()

UNIT_WORDS: dict[str, float] = {w: float(i) for i, w in enumerate(_URDU_1_TO_99, start=1)}
UNIT_WORDS.update({
    # Urdu spelling variants Whisper commonly emits
    "صفر": 0, "اک": 1, "چھے": 6, "چھہ": 6, "اٹھ": 8, "تیئس": 23, "بایئس": 22,
    "ڈیڑھ": 1.5, "ڈیڈھ": 1.5, "ڈھائی": 2.5, "اڑھائی": 2.5,
    # English
    "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7,
    "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13,
    "fourteen": 14, "fifteen": 15, "sixteen": 16, "seventeen": 17, "eighteen": 18,
    "nineteen": 19, "twenty": 20, "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60,
    "seventy": 70, "eighty": 80, "ninety": 90,
    # Roman Urdu (unambiguous forms only)
    "ek": 1, "teen": 3, "char": 4, "chaar": 4, "panch": 5, "paanch": 5, "saat": 7,
    "aath": 8, "nau": 9, "das": 10, "bees": 20, "pachas": 50, "pachaas": 50,
})

MULTIPLIERS: dict[str, float] = {
    "سو": 100, "سینکڑہ": 100, "hundred": 100, "sau": 100,
    "ہزار": 1_000, "ھزار": 1_000, "thousand": 1_000, "hazar": 1_000, "hazaar": 1_000, "k": 1_000,
    "لاکھ": 100_000, "لکھ": 100_000, "lakh": 100_000, "lakhs": 100_000, "lac": 100_000, "lacs": 100_000,
    "million": 1_000_000,
    "کروڑ": 10_000_000, "کروڈ": 10_000_000, "crore": 10_000_000, "crores": 10_000_000,
}

# Applied to the next number: ساڑھے تین ہزار = 3,500; سوا سو = 125; پونے دو سو = 175
FRACTION_MODIFIERS: dict[str, float] = {"ساڑھے": 0.5, "ساڑے": 0.5, "سوا": 0.25, "پونے": -0.25}

CONNECTORS = {"اور", "and"}
CURRENCY_WORDS = {
    "روپے", "روپیہ", "روپئے", "روپیے", "روپیا", "روپوں", "روپی",
    "rs", "pkr", "rupees", "rupee", "rupay", "rupaye",
}

TRANSFER_CUES = [
    # Urdu script
    "بھیج", "بھجوا", "بھیجوا", "بھجو", "ٹرانسفر", "ٹرانسفار", "منتقل", "ادا کر", "ادائیگی", "ارسال",
    "دے دو", "دیدو", "دے دیں", "دے دے", "جمع کر", "پے کر", "سینڈ", "پیمنٹ کر",
    "ٹرانسفر کردو", "ٹرانسفر کر دو", "بھیج دو", "بھجوا دو",
    # English / Roman Urdu
    "send", "transfer", "pay", "bhej", "bhejo", "bhej do", "bhejdo", "bhijwa", "bhijwado",
    "bhejwa", "bhejwado", "de do", "dedo", "transfer kardo", "transfer kar do",
    "pay kardo", "ada kardo", "muntaqil",
]
# Strong cues name the balance itself; they win over a transfer verb that has no amount.
BALANCE_CUES = [
    # Urdu script — Whisper spells the loanword many ways; vowel-insensitive
    # matching in _has_cue also folds بلینس / بیلانس / بلنس onto بیلنس.
    "بیلنس", "بیلینس", "بیلنز", "بیلنسں", "بلینس", "بیلانس", "بقایا", "بقیہ", "باقی",
    "کتنے پیسے", "کتنی رقم", "کتنا پیسہ", "رقم کتنی", "پیسے کتنے", "کتنے روپے", "کتنا بیلنس",
    # English / Roman Urdu
    "balance", "how much", "baqi", "baqaya", "bakaya",
    "kitne paise", "kitna paisa", "kitni raqam", "kitne pese", "paise kitne",
    "balance check karna hai", "balance check karna ha", "balance batao", "balance dikhao",
]
# Weak cues are conversational verbs ("check", "tell me", "show me"). They select a
# balance check only when nothing stronger is present, so "پیسے بھیجو، بتاؤ" still
# asks for an amount instead of silently doing something else.
BALANCE_VERB_CUES = [
    "چیک", "چک", "دکھاؤ", "دکھاو", "دکھا", "بتاؤ", "بتاو", "بتا", "معلوم",
    "check", "chek", "dikhao", "dikha", "batao", "bata", "maloom", "malum", "show",
]
NEGATION_CUES = {"مت", "نہ", "نہیں", "منسوخ", "کینسل", "cancel", "dont", "don't", "mat", "nahi", "stop"}

# "دو" doubles as the imperative "give"; after these words it is a verb, not 2.
_VERB_BEFORE_DO = {"دے", "کر", "بھیج", "لے", "ٹرانسفر", "ادا", "منتقل"}
_RECIPIENT_STOP = {
    "مجھے", "میرے", "میری", "میرا", "اپنے", "اپنی", "اپنا", "براہ", "کرم", "برائے", "مہربانی",
    "پلیز", "please", "اکاؤنٹ", "اکاونٹ", "کھاتے", "کھاتہ", "والے", "کے", "کی", "کا", "میں",
    "سے", "یہ", "وہ", "the", "my", "account",
}
_ACCOUNT_WORDS = {"اکاؤنٹ", "اکاونٹ", "کھاتے", "کھاتہ", "account"}
_RECIPIENT_STOP |= {"مجھ", "تجھ", "ان", "اس", "انہ", "اسے", "ہم", "تم", "آپ", "پے", "رو"}

# ── Fuzzy layer for noisy ASR output ──────────────────────────────
# Whisper-base often drops do-chashmi (بھیجو → بیجو), swaps homophones
# (علی → الی, روپے → رو پے) and glues/garbles words (سو روپے → سوڈو پے).
# A phonetic "skeleton" collapses those confusions; every fuzzy rule below is
# gated on numeric context so ordinary words are never read as numbers.
_SKELETON_MAP = str.maketrans({
    "ھ": None, "ء": None, "ح": "ہ", "ۃ": "ہ", "ع": "ا", "آ": "ا", "أ": "ا", "إ": "ا",
    "ئ": "ی", "ے": "ی", "ؤ": "و", "ڈ": "د", "ٹ": "ت", "ڑ": "ر", "ث": "س", "ص": "س",
    "ذ": "ز", "ض": "ز", "ظ": "ز", "ط": "ت", "ں": "ن", "ق": "ک",
})


def skeleton(s: str) -> str:
    return s.translate(_SKELETON_MAP)


def _unique_skeletons(words: dict) -> dict:
    seen: dict = {}
    for w, v in words.items():
        if not w.isascii():
            seen.setdefault(skeleton(w), set()).add(v)
    return {k: next(iter(v)) for k, v in seen.items() if len(v) == 1 and len(k) >= 2}


_FUZZY_UNITS = _unique_skeletons(UNIT_WORDS)
# Roman Urdu numerals that are also English/Urdu words ("do" = 2 / "do"); numeric only
# when directly followed by a multiplier or currency: "do hazar" = 2,000.
_CONTEXT_UNITS = {"do": 2, "dou": 2, "chay": 6, "che": 6, "chhe": 6, "sat": 7, "nao": 9, "no": 9}
_FUZZY_MULT_PREFIXES = [("ہزا", 1_000), ("لاک", 100_000), ("کرو", 10_000_000)]

# Common names Whisper misspells (ع→ا, ث→س); applied only to the recipient slot.
_NAME_FIXES = {"الی": "علی", "عالی": "علی", "اسمان": "عثمان", "اثمان": "عثمان", "امر": "عمر"}


@dataclass
class NumberSpan:
    value: float
    start: int
    end: int  # exclusive
    has_multiplier: bool


@dataclass
class ParsedCommand:
    intent: str                     # TRANSFER | CHECK_BALANCE | NEGATED | NEEDS_AMOUNT | UNKNOWN
    normalized_text: str
    amount: Optional[float] = None
    recipient: Optional[str] = None
    confidence: float = 0.0
    signals: list = field(default_factory=list)


def normalize_urdu(text: str) -> str:
    s = (text or "").translate(_DIGIT_MAP).translate(_CHAR_MAP)
    s = _DIACRITICS.sub("", s).lower()
    s = re.sub(r"(?<=\d)[,٬](?=\d{3})", "", s)                      # 5,000 → 5000
    s = re.sub(r"(?<=\d)٫(?=\d)", ".", s)                            # Arabic decimal sep
    s = re.sub(r"\b(rs|pkr)\.?(?=\d)", r"\1 ", s)                    # rs500 → rs 500
    s = re.sub(r"(\d)([^\d\s.])", r"\1 \2", s)                       # 500روپے → 500 روپے
    s = re.sub(r"([^\d\s.])(\d)", r"\1 \2", s)
    s = s.replace("don't", "dont").replace("do not", "dont")
    # Drop every punctuation/symbol code point (، ۔ ؟ ؛ ٪ « » ! ? , etc.), keeping decimal points.
    s = "".join(" " if c != "." and unicodedata.category(c)[0] in "PS" else c for c in s)
    s = re.sub(r"(?<!\d)\.|\.(?!\d)", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def _split_glued(tok: str) -> list[str]:
    """پانچسو → [پانچ, سو] when Whisper drops the space before a multiplier."""
    if tok in UNIT_WORDS or tok in MULTIPLIERS:
        return [tok]
    for mult in sorted(MULTIPLIERS, key=len, reverse=True):
        if len(tok) > len(mult) and tok.endswith(mult) and tok[: -len(mult)] in UNIT_WORDS:
            return [tok[: -len(mult)], mult]
    # الیکو → [الی, کو]: recipient marker glued onto the name
    if not tok.isascii() and tok.endswith("کو") and len(tok) >= 4:
        return [tok[:-2], "کو"]
    return [tok]


def tokenize(normalized: str) -> list[str]:
    return [p for t in normalized.split() for p in _split_glued(t)]


def _unit_value(tok: str) -> Optional[float]:
    if re.fullmatch(r"\d+(\.\d+)?", tok):
        return float(tok)
    return UNIT_WORDS.get(tok)


def _is_numeric(tok: str) -> bool:
    return _unit_value(tok) is not None or tok in MULTIPLIERS or tok in FRACTION_MODIFIERS


def _is_currency(tok: str) -> bool:
    return tok in CURRENCY_WORDS or skeleton(tok).startswith("روپ") or tok.startswith("rup")


def _fuzzy_multiplier(tok: str) -> Optional[float]:
    """سوڈو / سؤ / ہزاروں / لاکھوں → multiplier. Caller guarantees a number precedes it."""
    if tok.isascii() or tok in UNIT_WORDS or tok in FRACTION_MODIFIERS:
        return None
    sk = skeleton(tok)
    if sk.startswith("سو") and len(sk) <= 4:
        return 100.0
    for prefix, value in _FUZZY_MULT_PREFIXES:
        if sk.startswith(prefix):
            return float(value)
    return None


def _multiplier_like(tok: str) -> bool:
    return tok in MULTIPLIERS or _fuzzy_multiplier(tok) is not None


def _classify(tokens: list[str], j: int, last: Optional[str]) -> Optional[tuple[str, float]]:
    """Exact lexicon first, then context-gated fuzzy matches."""
    tok = tokens[j]
    nxt = tokens[j + 1] if j + 1 < len(tokens) else ""
    if tok in FRACTION_MODIFIERS:
        return "mod", FRACTION_MODIFIERS[tok]
    if (v := _unit_value(tok)) is not None:
        return "unit", v
    if tok in MULTIPLIERS:
        return "mult", MULTIPLIERS[tok]
    if tok in CONNECTORS:
        return "conn", 0.0
    # Fuzzy multiplier: only directly after a number ("پانچ سوڈو" → 500)
    if last == "unit" and (m := _fuzzy_multiplier(tok)) is not None:
        return "mult", m
    # Fuzzy / ambiguous units: only directly before a multiplier or currency word
    # ("آٹ سو" → 800, "do hazar" → 2,000)
    if last != "unit" and (_multiplier_like(nxt) or _is_currency(nxt)):
        v = _CONTEXT_UNITS.get(tok) if tok.isascii() else _FUZZY_UNITS.get(skeleton(tok))
        if v is not None:
            return "unit", float(v)
    return None


def extract_number_spans(tokens: list[str]) -> list[NumberSpan]:
    """Parse every maximal number phrase using Indian place values (سو/ہزار/لاکھ/کروڑ)."""
    spans: list[NumberSpan] = []
    i, n = 0, len(tokens)
    while i < n:
        first = _classify(tokens, i, None)
        if first is None or first[0] == "conn" or tokens[i] == "k":
            i += 1
            continue
        start, total, current, mod, last, has_mult = i, 0.0, 0.0, 0.0, None, False
        j = i
        while j < n:
            c = _classify(tokens, j, last)
            if c is None:
                break
            kind, v = c
            if kind == "mod":
                if last == "unit":
                    break
                mod, last = v, "mod"
            elif kind == "unit":
                if last == "unit":          # "دو تین" → two separate numbers
                    break
                current += v + mod
                mod, last = 0.0, "unit"
            elif kind == "mult":
                base = current if current else 1.0 + mod
                mod, has_mult = 0.0, True
                if v == 100:
                    current = base * 100
                else:
                    total += base * v
                    current = 0.0
                last = "mult"
            elif kind == "conn" and last == "mult" and j + 1 < n and _classify(tokens, j + 1, "conn") is not None:
                last = "conn"
            else:
                break
            j += 1
        if last == "conn":
            j -= 1
        value = total + current
        if j > start and value > 0:
            spans.append(NumberSpan(value, start, j, has_mult))
        i = max(j, start + 1)
    return spans


def _drop_verb_do(tokens: list[str], spans: list[NumberSpan]) -> list[NumberSpan]:
    """Resolve the 'دو' ambiguity: 2 vs the imperative 'give'."""
    out = []
    for sp in spans:
        if tokens[sp.end - 1] != "دو":
            out.append(sp)
            continue
        followed_by_currency = sp.end < len(tokens) and _is_currency(tokens[sp.end])
        single = sp.end - sp.start == 1
        prev = tokens[sp.start - 1] if sp.start > 0 else ""
        if single and prev in _VERB_BEFORE_DO:
            continue                                       # "دے دو" / "کر دو"
        if not single and not followed_by_currency and _multiplier_like(tokens[sp.end - 2]):
            out.append(NumberSpan(sp.value - 2, sp.start, sp.end - 1, sp.has_multiplier))  # "پانچ سو دو" → 500, give
            continue
        out.append(sp)
    return out


def _currency_adjacent(tokens: list[str], sp: NumberSpan) -> bool:
    after = tokens[sp.end: sp.end + 2]
    before = tokens[sp.start - 1] if sp.start > 0 else ""
    if after and (_is_currency(after[0]) or after[0] == "پے" or after == ["رو", "پے"]):
        return True
    return _is_currency(before)


def pick_amount(tokens: list[str], spans: list[NumberSpan]) -> tuple[Optional[NumberSpan], float]:
    if not spans:
        return None, 0.0
    scored = [((3 if _currency_adjacent(tokens, s) else 0) + (1 if s.has_multiplier else 0), s.value, s) for s in spans]
    score, _, best = max(scored, key=lambda t: (t[0], t[1]))
    confidence = 0.95 if score >= 3 else 0.8 if score >= 1 else 0.6
    return best, confidence


def extract_recipient(tokens: list[str], skip: set[int]) -> Optional[str]:
    def ok(idx: int) -> bool:
        t = tokens[idx]
        return (
            idx not in skip and not _is_numeric(t) and not _is_currency(t)
            and t not in _RECIPIENT_STOP and not _has_cue(t, TRANSFER_CUES + BALANCE_CUES + BALANCE_VERB_CUES)
        )

    for k, tok in enumerate(tokens):
        marker = tok in ("کو", "ko") or (tok == "کے" and k + 1 < len(tokens) and tokens[k + 1] in _ACCOUNT_WORDS)
        if marker:
            name, p = [], k - 1
            while p >= 0 and len(name) < 3 and ok(p):
                name.insert(0, tokens[p])
                p -= 1
            if name:
                joined = " ".join(_NAME_FIXES.get(w, w) for w in name)
                return (joined.title() if joined.isascii() else joined)[:40]
        if tok == "to":
            name, p = [], k + 1
            while p < len(tokens) and len(name) < 2 and ok(p) and re.fullmatch(r"[a-z]+", tokens[p]):
                name.append(tokens[p])
                p += 1
            if name:
                return " ".join(name).title()[:40]
    return None


_MATRES = re.compile("[اوی]")


def _consonants(s: str) -> str:
    """Vowel-letter-free skeleton: بیلنس / بلینس / بیلانس / بلنس → بلنس."""
    return _MATRES.sub("", skeleton(s))


def _cue_matches(cue: str, padded: str, sk_padded: str, tokens: list[str]) -> bool:
    if cue.isascii():
        # Word-start match: "check" also hits "checking"; "de do" never hits "kade do".
        return f" {cue}" in padded
    if " " in cue:
        return cue in padded or skeleton(cue) in sk_padded
    if len(cue) <= 2:
        # Very short stems (چک) only as whole words, so چکر / چکن don't match.
        return any(t == cue or skeleton(t) == skeleton(cue) for t in tokens)
    sk, cons = skeleton(cue), _consonants(cue)
    for t in tokens:
        # Prefix match covers inflections (بھیج → بھیجو / بھیجیں); skeleton covers
        # dropped ھ (بیجو); consonants cover vowel spelling drift in loanwords.
        if t.startswith(cue) or skeleton(t).startswith(sk):
            return True
        # ≥4 consonants keeps this to distinctive loanwords (بلنس, ترنسفر, منتکل);
        # shorter skeletons collide with names, e.g. ارسال vs رسول.
        if len(cons) >= 4 and _consonants(t).startswith(cons):
            return True
    return False


def _has_cue(normalized: str, cues: list[str]) -> list[str]:
    padded = f" {normalized} "
    sk_padded = skeleton(padded)
    tokens = normalized.split()
    return [c for c in cues if _cue_matches(c, padded, sk_padded, tokens)]


def parse_command(transcript: str) -> ParsedCommand:
    norm = normalize_urdu(transcript)
    tokens = tokenize(norm)
    spans = _drop_verb_do(tokens, extract_number_spans(tokens))
    best, amount_conf = pick_amount(tokens, spans)

    transfer_hits = _has_cue(norm, TRANSFER_CUES)
    strong_balance = _has_cue(norm, BALANCE_CUES)
    verb_balance = _has_cue(norm, BALANCE_VERB_CUES)
    balance_hits = strong_balance + verb_balance
    negated = any(t in NEGATION_CUES for t in tokens)
    recipient_marked = any(t in ("کو", "ko", "to") for t in tokens)
    currency_tagged = best is not None and _currency_adjacent(tokens, best)

    signals = (
        [f"transfer:{h}" for h in transfer_hits]
        + [f"balance:{h}" for h in strong_balance]
        + [f"balance_verb:{h}" for h in verb_balance]
    )
    if best:
        signals.append(f"amount:{best.value:g}")
    if negated:
        signals.append("negation")

    parsed = ParsedCommand(intent="UNKNOWN", normalized_text=norm, signals=signals)
    # Money only moves on an explicit transfer verb, or an amount+currency/recipient
    # with no balance wording at all. Any ambiguity falls to the read-only balance check.
    wants_transfer = bool(transfer_hits) or (best is not None and (currency_tagged or recipient_marked) and not balance_hits)

    if wants_transfer and negated:
        if strong_balance:                      # "بیلنس بتاؤ، پیسے مت بھیجو"
            parsed.intent, parsed.confidence = "CHECK_BALANCE", 0.8
        else:
            parsed.intent = "NEGATED"
    elif wants_transfer and best is not None:
        skip = set(range(best.start, best.end))
        parsed.intent = "TRANSFER"
        parsed.amount = round(best.value, 2)
        parsed.recipient = extract_recipient(tokens, skip)
        parsed.confidence = round(amount_conf * (1.0 if transfer_hits else 0.75), 2)
    elif transfer_hits and not strong_balance:
        parsed.intent = "NEEDS_AMOUNT"
        parsed.confidence = 0.5
    elif balance_hits:
        parsed.intent = "CHECK_BALANCE"
        parsed.confidence = 0.9 if strong_balance else 0.7
    return parsed


def _is_prompt_echo(transcript: str, prompt: str = ASR_PROMPT) -> bool:
    """Whisper sometimes regurgitates the initial prompt on near-silence.

    A real command reuses at most ~half the prompt's words ("پانچ سو روپے علی کو
    بھیجو" = 6/10); a regurgitation reproduces most of it, including words that
    never co-occur in one command (ہزار + لاکھ, ٹرانسفر + بیلنس).
    """
    seq = tokenize(normalize_urdu(transcript))
    prompt_seq = tokenize(normalize_urdu(prompt))
    tokens, prompt_tokens = set(seq), set(prompt_seq)
    if len(tokens & prompt_tokens) >= 0.7 * len(prompt_tokens):
        return True
    # Partial echo: the whole transcript is one unbroken slice of the prompt
    # ("سو ہزار لاکھ روپے", "ٹرانسفر بیلنس"). Real commands break the prompt's
    # order ("پانچ سو روپے …" skips ہزار لاکھ), so they are not matched.
    if len(seq) >= 2:
        k = len(seq)
        return any(prompt_seq[i: i + k] == seq for i in range(len(prompt_seq) - k + 1))
    return False


# ═══════════════════════════════════════════════════════════════
# LEDGER
# ═══════════════════════════════════════════════════════════════

def _new_reference(db: Session) -> str:
    while True:
        ref = f"FS{datetime.now():%y%m%d}{random.randint(100000, 999999)}"
        if not db.query(Transaction.id).filter(Transaction.reference == ref).first():
            return ref


def validate_transfer(account: Account, amount: float) -> None:
    """Reject transfers that could never succeed, before any confirmation is requested."""
    if amount < MIN_TRANSFER_PKR:
        raise HTTPException(status_code=422, detail=f"Transfer amount must be at least PKR {MIN_TRANSFER_PKR:,.0f}.")
    if amount > VOICE_TRANSFER_LIMIT_PKR:
        raise HTTPException(
            status_code=400,
            detail=f"PKR {amount:,.0f} exceeds the voice-banking limit of PKR {VOICE_TRANSFER_LIMIT_PKR:,.0f} per transaction.",
        )
    if account.balance < amount:
        raise HTTPException(
            status_code=400,
            detail=f"Insufficient funds: tried to send PKR {amount:,.0f}, available balance is PKR {account.balance:,.0f}.",
        )


def execute_transfer(db: Session, account: Account, amount: float, recipient: str, transcript: str) -> Transaction:
    """Atomically debit the account and append a ledger row."""
    if amount < MIN_TRANSFER_PKR:
        raise HTTPException(status_code=422, detail=f"Transfer amount must be at least PKR {MIN_TRANSFER_PKR:,.0f}.")
    if amount > VOICE_TRANSFER_LIMIT_PKR:
        raise HTTPException(
            status_code=400,
            detail=f"PKR {amount:,.0f} exceeds the voice-banking limit of PKR {VOICE_TRANSFER_LIMIT_PKR:,.0f} per transaction.",
        )

    # Conditional UPDATE is atomic in SQLite: no double-spend between check and debit.
    updated = (
        db.query(Account)
        .filter(Account.cnic == account.cnic, Account.balance >= amount)
        .update({Account.balance: Account.balance - amount}, synchronize_session=False)
    )
    if not updated:
        db.rollback()
        db.refresh(account)
        raise HTTPException(
            status_code=400,
            detail=f"Insufficient funds: tried to send PKR {amount:,.0f}, available balance is PKR {account.balance:,.0f}.",
        )

    db.flush()
    db.refresh(account)
    txn = Transaction(
        reference=_new_reference(db),
        cnic=account.cnic,
        direction="DEBIT",
        category="transfer",
        counterparty=recipient,
        amount=amount,
        balance_after=account.balance,
        channel="VOICE",
        transcript=transcript,
    )
    db.add(txn)
    try:
        db.commit()
    except Exception:
        db.rollback()
        raise
    db.refresh(txn)
    db.refresh(account)
    return txn


def _fmt(n: float) -> str:
    return f"{n:,.2f}".rstrip("0").rstrip(".")


# ═══════════════════════════════════════════════════════════════
# FORENSICS — structured "why it failed" for biometric rejections
# ═══════════════════════════════════════════════════════════════

def _raw_cosine_from_ux(ux: Optional[float]) -> Optional[float]:
    """Fallback for an older Awaaz build without "raw_similarity": invert its UX calibration."""
    if ux is None:
        return None
    t = ECAPA_EER_THRESHOLD
    raw = t + (ux - 0.80) / 0.20 * (1.0 - t) if ux >= 0.80 else ux / 0.79 * (t + 1.0) - 1.0
    return round(max(-1.0, min(1.0, raw)), 4)


def build_forensics(awaaz_body, channel: str) -> dict:
    """Normalise an Awaaz rejection into the diagnostic payload the bank UI renders.

    channel: "login" (challenge-response, has active liveness) or "command"
    (per-transaction re-auth on free speech: Gatekeeper + ECAPA only).
    Check states: pass | fail | skipped | not_evaluated | unknown.
    """
    body = awaaz_body if isinstance(awaaz_body, dict) else {}
    message = str(body.get("message") or body.get("detail") or (awaaz_body if isinstance(awaaz_body, str) else ""))
    m = message.lower()
    threshold = float(body.get("threshold") or ECAPA_EER_THRESHOLD)

    gk_score = body.get("gatekeeper_score")
    gatekeeper_passed: Optional[bool] = None if gk_score is None else float(gk_score) >= 1.0
    multi = re.search(r"multiple speakers\s*\((\d+)\)", m)
    multiple_speakers = bool(multi) or "multiple speakers" in m
    # Match the Gatekeeper's own verdict only: a short-circuit message also lists the
    # *skipped* stages ("Liveness FAIL: Skipped — no human speech detected.").
    no_speech = gatekeeper_passed is False and "reject: no human speech" in m
    replay = "replay" in m

    raw = body.get("raw_similarity")
    if raw is None and gatekeeper_passed and body.get("similarity_score") is not None:
        raw = _raw_cosine_from_ux(float(body["similarity_score"]))
    raw = None if raw is None else round(float(raw), 4)

    if channel == "login" and gatekeeper_passed is not False:
        if "liveness_passed" in body:
            challenge_passed: Optional[bool] = bool(body["liveness_passed"])
        elif gatekeeper_passed:
            challenge_passed = "liveness fail" not in m
        else:
            challenge_passed = None
    else:
        challenge_passed = None  # no challenge on per-command re-auth

    flags: list[str] = []
    if multiple_speakers:
        flags.append("Multiple speakers")
    if no_speech:
        flags.append("No speech detected")
    if replay:
        flags.append("Replay")
    if channel == "login" and challenge_passed is False:
        flags.append("Challenge mismatch")
    if raw is not None and raw < threshold:
        flags.append("Low acoustic similarity")
    if "expired session" in m:
        flags.append("Challenge expired")
    if "template not found" in m:
        flags.append("No enrolled voiceprint")

    def state(ok: Optional[bool]) -> str:
        return "unknown" if ok is None else "pass" if ok else "fail"

    checks = {
        "speech_present": "fail" if no_speech else state(None if gatekeeper_passed is None else True),
        "single_speaker": "fail" if multiple_speakers else ("not_evaluated" if no_speech else state(gatekeeper_passed)),
        "replay_defence": (
            "fail" if replay
            else "not_evaluated" if channel == "command"
            else "skipped" if gatekeeper_passed is False
            else state(challenge_passed)
        ),
        "voiceprint": "skipped" if raw is None else ("pass" if raw >= threshold else "fail"),
    }

    # Spec field: live, single human speaker AND (for login) the random challenge passed.
    liveness_passed = bool(gatekeeper_passed) and (challenge_passed is not False)

    if multiple_speakers:
        n = multi.group(1) if multi else "2+"
        primary, explanation = "Multiple speakers", (
            f"The Gatekeeper's speaker-diarization model (pyannote) found {n} distinct voices in the recording. "
            "Authentication requires a single, isolated speaker, so a second voice (a coercer, a bystander or a TV) "
            "stops the attempt before the voiceprint is ever compared."
        )
    elif no_speech:
        primary, explanation = "No speech detected", (
            "The Gatekeeper found no human speech in the recording, so neither the challenge nor the voiceprint "
            "could be evaluated. Hold the microphone closer and speak clearly."
        )
    elif replay:
        primary, explanation = "Replay", (
            "The recording carried characteristics of an electronic replay rather than a live voice, "
            "so it was rejected regardless of how closely it matched."
        )
    elif channel == "login" and challenge_passed is False:
        primary, explanation = "Challenge mismatch", (
            "The spoken digits did not match the one-time random challenge. The digits are generated fresh for every "
            "attempt, so this check is the system's defence against pre-recorded or replayed audio."
        )
    elif raw is not None and raw < threshold:
        primary, explanation = "Low acoustic similarity", (
            f"The ECAPA-TDNN voiceprint of this recording scored {raw:.4f} cosine similarity against the enrolled "
            f"template, {threshold - raw:.4f} below the {threshold:.4f} decision threshold (the equal-error-rate "
            "operating point). The vocal signature does not match the account owner closely enough."
        )
    elif "expired session" in m:
        primary, explanation = "Challenge expired", (
            "The one-time challenge for this attempt had already been used or expired. Request a new challenge."
        )
    elif "template not found" in m:
        primary, explanation = "No enrolled voiceprint", (
            "There is no enrolled voiceprint for this CNIC, so there is nothing to compare the recording against."
        )
    else:
        primary, explanation = "Verification failed", message or "The identity provider rejected this attempt."

    return {
        "channel": channel,
        "similarity_score": raw,
        "threshold": threshold,
        "margin": None if raw is None else round(raw - threshold, 4),
        "liveness_passed": liveness_passed,
        "flags": flags,
        "checks": checks,
        "primary_factor": primary,
        "explanation": explanation,
        "awaaz_message": message,
    }


def biometric_rejection(status_code: int, detail: str, awaaz_body, channel: str, **extra) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={"detail": detail, "forensics": build_forensics(awaaz_body, channel), "awaaz": awaaz_body, **extra},
    )


# ═══════════════════════════════════════════════════════════════
# STEP-UP CONFIRMATION — pending high-value transfers
# ═══════════════════════════════════════════════════════════════

@dataclass
class PendingTransfer:
    token: str
    cnic: str
    amount: float
    recipient: str
    named_recipient: bool
    transcript: str
    expires_at: float
    attempts: int = 0


_pending: dict[str, PendingTransfer] = {}
_pending_lock = threading.Lock()


def _purge_expired_locked(now: float) -> None:
    for tok in [t for t, p in _pending.items() if p.expires_at <= now]:
        del _pending[tok]


def create_pending(cnic: str, amount: float, recipient: str, named: bool, transcript: str) -> PendingTransfer:
    """One pending transfer per account: a new high-value command supersedes the old one."""
    pt = PendingTransfer(
        token=secrets.token_urlsafe(24),
        cnic=cnic,
        amount=amount,
        recipient=recipient,
        named_recipient=named,
        transcript=transcript,
        expires_at=time.time() + CONFIRMATION_TTL_SECONDS,
    )
    with _pending_lock:
        _purge_expired_locked(time.time())
        for tok in [t for t, p in _pending.items() if p.cnic == cnic]:
            del _pending[tok]
        _pending[pt.token] = pt
    return pt


def get_pending(token: str, cnic: str) -> Optional[PendingTransfer]:
    with _pending_lock:
        _purge_expired_locked(time.time())
        pt = _pending.get(token)
        return pt if pt and pt.cnic == cnic else None  # bound to the account that created it


def discard_pending(token: str) -> Optional[PendingTransfer]:
    with _pending_lock:
        return _pending.pop(token, None)


CONFIRM_CUES = [
    "confirm", "confirmed", "yes", "ok", "okay", "proceed", "approve", "haan", "han", "kar do", "kardo",
    "ہاں", "ہان", "جی ہاں", "منظور", "کنفرم", "کر دو", "کردو", "ٹھیک ہے", "اوکے", "جی",
]
CANCEL_TOKENS = NEGATION_CUES | {"no", "nope", "nahin", "رہنے", "واپس"}


def confirmation_decision(transcript: str) -> str:
    """confirm | cancel | unclear. A negation always wins over a confirmation word,
    so "نہیں، کنفرم مت کرو" or "don't confirm" can never authorise a transfer."""
    norm = normalize_urdu(transcript)
    if any(t in CANCEL_TOKENS for t in tokenize(norm)):
        return "cancel"
    return "confirm" if _has_cue(norm, CONFIRM_CUES) else "unclear"


# ═══════════════════════════════════════════════════════════════
# ROUTES
# ═══════════════════════════════════════════════════════════════

@app.get("/")
def health():
    return {
        "service": "FinSecure Bank API",
        "status": "ok",
        "asr": {"model": WHISPER_MODEL_SIZE, "loaded": transcriber._model is not None, "device": transcriber.device},
    }


@app.post("/bank/login")
async def bank_login(
    cnic: str = Form(...),
    session_id: str = Form(...),
    audio: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    """Proxy voice login to Awaaz Identity Provider, then return account data."""
    audio_bytes = await audio.read()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="Empty audio file.")

    # backend/main.py /authenticate/verify expects: session_id, user_id (Form),
    # voice (File), sandbox (Form, optional bool).
    files = {
        "voice": (
            audio.filename or "audio.webm",
            audio_bytes,
            audio.content_type or "audio/webm",
        )
    }
    data = {"user_id": cnic, "session_id": session_id, "sandbox": "false"}

    try:
        awaaz_resp = requests.post(
            AWAAZ_VERIFY_URL,
            data=data,
            files=files,
            timeout=AWAAZ_TIMEOUT_SECONDS,
        )
    except requests.exceptions.ConnectionError:
        raise HTTPException(
            status_code=502,
            detail="Awaaz Identity Provider is unreachable on port 8000.",
        )
    except requests.exceptions.Timeout:
        raise HTTPException(
            status_code=504,
            detail="Awaaz Identity Provider timed out.",
        )

    if not awaaz_response_is_pass(awaaz_resp):
        try:
            awaaz_body = awaaz_resp.json()
        except ValueError:
            awaaz_body = awaaz_resp.text
        forensics = build_forensics(awaaz_body, "login")
        return JSONResponse(
            status_code=401,
            content={
                "detail": f"Voice authentication failed: {forensics['primary_factor']}.",
                "forensics": forensics,
                "awaaz": awaaz_body,
            },
        )

    cnic_clean = normalize_cnic(cnic.replace("-", ""))
    account = db.query(Account).filter(Account.cnic == cnic_clean).first()
    if not account:
        raise HTTPException(
            status_code=401,
            detail="Voice verified, but no bank account is linked to this CNIC.",
        )

    return {
        "status": "AUTHENTICATED",
        "session_id": session_id,
        "account": account_to_dict(account),
    }


def _transfer_response(base: dict, txn: Transaction, account: Account, named_recipient: bool) -> dict:
    to_part = f" to {txn.counterparty}" if named_recipient else " via Raast"
    return {
        **base,
        "message": f"Sent PKR {_fmt(txn.amount)}{to_part}. Ref {txn.reference}. New balance: PKR {_fmt(account.balance)}.",
        "message_ur": f"{_fmt(txn.amount)} روپے{' ' + txn.counterparty + ' کو' if named_recipient else ''} منتقل کر دیے گئے۔ نیا بیلنس {_fmt(account.balance)} روپے ہے۔",
        "new_balance": account.balance,
        "transaction": {
            "id": txn.id,
            "reference": txn.reference,
            "type": "TRANSFER",
            "direction": txn.direction,
            "category": txn.category,
            "amount": txn.amount,
            "recipient": txn.counterparty,
            "date": date_label(txn.created_at),
            "balance_after": txn.balance_after,
        },
        "account": account_to_dict(account),
    }


@app.post("/bank/command")
async def bank_command(
    cnic: str = Form(...),
    audio: UploadFile = File(...),
    confirmation_token: Optional[str] = Form(None),
    token: Optional[str] = Form(None),  # alias accepted for the confirmation step
    db: Session = Depends(get_db),
):
    """Urdu voice-banking agent:
    continuous biometric auth → transcribe → parse intent/amount → execute against the ledger.

    High-value transfers (≥ HIGH_VALUE_THRESHOLD_PKR) are not executed on the first
    utterance: the endpoint answers CONFIRMATION_REQUIRED with a one-time token, and
    the transfer commits only when a second, biometrically verified recording that
    carries the token says a confirmation phrase.
    """
    confirm_token = confirmation_token or token
    audio_bytes = await audio.read()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="Empty audio file.")
    if len(audio_bytes) > MAX_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="Audio file is too large.")

    cnic_clean = normalize_cnic(cnic)
    account = db.query(Account).filter(Account.cnic == cnic_clean).first()
    if not account:
        raise HTTPException(status_code=404, detail="Account not found.")

    pending: Optional[PendingTransfer] = None
    if confirm_token:
        pending = get_pending(confirm_token, cnic_clean)
        if not pending:
            return JSONResponse(
                status_code=410,
                content={"detail": "This confirmation has expired. Please repeat your transfer command.", "pending_cleared": True},
            )

    # ── 0. Continuous biometric authentication (fail closed) ──
    # The same utterance that carries the command must match the account owner's
    # ECAPA-TDNN voiceprint, otherwise nothing is transcribed or executed.
    try:
        bio_resp = await run_in_threadpool(
            requests.post,
            AWAAZ_CONTINUOUS_URL,
            data={"user_id": cnic_clean, "session_id": COMMAND_SESSION_ID},
            files={"voice": (audio.filename or "voice.wav", audio_bytes, audio.content_type or "audio/wav")},
            timeout=AWAAZ_TIMEOUT_SECONDS,
        )
    except requests.exceptions.ConnectionError:
        raise HTTPException(status_code=503, detail="Transaction blocked: Awaaz biometric service is unreachable on port 8000.")
    except requests.exceptions.Timeout:
        raise HTTPException(status_code=504, detail="Transaction blocked: Awaaz biometric service timed out.")

    if bio_resp.status_code != 200 or not awaaz_response_is_pass(bio_resp):
        try:
            reason = bio_resp.json()
        except ValueError:
            reason = bio_resp.text[:200]
        print(f"[BIOMETRIC BLOCK] cnic={cnic_clean} http={bio_resp.status_code} awaaz={reason}")
        if pending:
            discard_pending(pending.token)  # an impostor gets no second try at someone else's transfer
        return biometric_rejection(401, BIOMETRIC_BLOCK_MSG, reason, "command", pending_cleared=bool(pending))

    bio = bio_resp.json()
    biometric = {
        "verified": True,
        "engine": "ECAPA-TDNN",
        "mode": bio.get("mode", "continuous"),
        "similarity_score": bio.get("similarity_score"),
    }

    # ── 1. Transcribe ──
    suffix = os.path.splitext(audio.filename or "")[1] or (".wav" if "wav" in (audio.content_type or "") else ".webm")
    fd, tmp_path = tempfile.mkstemp(prefix="fs_cmd_", suffix=suffix)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(audio_bytes)
        transcript = await run_in_threadpool(transcriber.transcribe, tmp_path, CONFIRM_PROMPT if pending else ASR_PROMPT)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=f"Voice assistant unavailable: {e}")
    except Exception as e:
        print(f"[ASR ERROR] {type(e).__name__}: {e}")
        raise HTTPException(status_code=422, detail="Couldn't decode that recording. Please try again.")
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass

    if not transcript:
        print("[ASR] no speech in recording")
        raise HTTPException(status_code=422, detail="No speech detected. Please speak your command clearly and try again.")

    # ── 1b. Step-up confirmation of a pending high-value transfer ──
    if pending:
        decision = confirmation_decision(transcript)
        print(f"[STEP-UP] heard={transcript!r} decision={decision} amount={pending.amount} recipient={pending.recipient}")
        to_part = f" to {pending.recipient}" if pending.named_recipient else " via Raast"
        if decision == "cancel":
            discard_pending(pending.token)
            return {
                "status": "CANCELLED",
                "intent": "TRANSFER",
                "biometric": biometric,
                "transcript": transcript,
                "message": f"Transfer of PKR {_fmt(pending.amount)}{to_part} cancelled. No money was moved.",
                "pending_cleared": True,
            }
        if decision == "unclear":
            with _pending_lock:
                pending.attempts += 1
                exhausted = pending.attempts >= CONFIRMATION_MAX_ATTEMPTS
            if exhausted:
                discard_pending(pending.token)
                return JSONResponse(status_code=422, content={
                    "detail": f"No clear confirmation after {CONFIRMATION_MAX_ATTEMPTS} attempts. The transfer was cancelled for your security. Heard: “{transcript}”",
                    "pending_cleared": True,
                })
            left = CONFIRMATION_MAX_ATTEMPTS - pending.attempts
            return JSONResponse(status_code=422, content={
                "detail": f"I didn't hear a confirmation. Say “ہاں کنفرم کرو” or “Confirm transaction” ({left} attempt{'s' if left != 1 else ''} left). Heard: “{transcript}”",
                "pending_cleared": False,
            })

        # Confirmed: one-time token is consumed before the debit.
        if not discard_pending(pending.token):
            return JSONResponse(status_code=410, content={"detail": "This confirmation was already used.", "pending_cleared": True})
        txn = execute_transfer(db, account, pending.amount, pending.recipient, f"{pending.transcript} | confirmed: {transcript}")
        base = {
            "status": "SUCCESS",
            "intent": "TRANSFER",
            "step_up": True,
            "confirmed": True,
            "biometric": biometric,
            "transcript": transcript,
        }
        return _transfer_response(base, txn, account, pending.named_recipient)

    # ── 2. Understand ──
    cmd = parse_command(transcript)
    print(f"[AGENT] heard={transcript!r} intent={cmd.intent} amount={cmd.amount} recipient={cmd.recipient} signals={cmd.signals}")

    if cmd.intent == "NEGATED":
        raise HTTPException(status_code=422, detail=f"Transfer cancelled: your command contained a negation. No money was moved. Heard: “{transcript}”")
    if cmd.intent == "NEEDS_AMOUNT":
        raise HTTPException(status_code=422, detail=f"I understood a transfer but couldn't catch the amount. Try: “پانچ سو روپے علی کو بھیجو”. Heard: “{transcript}”")
    if cmd.intent == "UNKNOWN":
        raise HTTPException(
            status_code=422,
            detail=(
                "I couldn't tell whether you wanted a balance check or a transfer. "
                f"Try “میرا بیلنس بتاؤ” or “پانچ سو روپے علی کو بھیجو”. Heard: “{transcript}”"
            ),
        )

    base = {
        "status": "SUCCESS",
        "intent": cmd.intent,
        "biometric": biometric,
        "transcript": transcript,
        "parsed": {
            "normalized_text": cmd.normalized_text,
            "amount": cmd.amount,
            "recipient": cmd.recipient,
            "confidence": cmd.confidence,
            "signals": cmd.signals,
        },
    }

    # ── 3. Act ──
    if cmd.intent == "CHECK_BALANCE":
        db.refresh(account)
        return {
            **base,
            "message": f"Your available balance is PKR {_fmt(account.balance)}.",
            "message_ur": f"آپ کا موجودہ بیلنس {_fmt(account.balance)} روپے ہے۔",
            "new_balance": account.balance,
            "account": account_to_dict(account),
        }

    recipient = cmd.recipient or DEFAULT_RECIPIENT

    # High-value: validate now (so we never ask to confirm an impossible transfer),
    # then park it behind a one-time voice confirmation instead of debiting.
    if cmd.amount >= HIGH_VALUE_THRESHOLD_PKR:
        db.refresh(account)
        validate_transfer(account, cmd.amount)
        pt = create_pending(cnic_clean, cmd.amount, recipient, bool(cmd.recipient), transcript)
        to_part = f" to {recipient}" if cmd.recipient else " via Raast"
        return {
            **base,
            "status": "CONFIRMATION_REQUIRED",
            "pending_tx": {"recipient": recipient, "amount": cmd.amount, "named_recipient": bool(cmd.recipient)},
            "token": pt.token,
            "expires_in": CONFIRMATION_TTL_SECONDS,
            "prompt": (
                f"High-value transfer of PKR {_fmt(cmd.amount)}{to_part} requires voice authorization. "
                "Please say 'ہاں کنفرم کرو' or 'Confirm transaction'."
            ),
        }

    txn = execute_transfer(db, account, cmd.amount, recipient, transcript)
    return _transfer_response(base, txn, account, bool(cmd.recipient))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("bank_main:app", host="0.0.0.0", port=8001, reload=True)
