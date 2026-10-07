"""
FinSecure — Mock B2B Bank Backend
=================================
Standalone FastAPI app that consumes the Awaaz Identity Provider (port 8000)
for voice-based login, and exposes a mock Urdu voice command endpoint.

Run:
    pip install fastapi uvicorn sqlalchemy requests python-multipart
    uvicorn bank_main:app --host 0.0.0.0 --port 8001 --reload
"""

import re
import random
from typing import Optional

import requests
from fastapi import FastAPI, File, Form, UploadFile, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import Column, String, Float, create_engine
from sqlalchemy.orm import sessionmaker, declarative_base, Session

# ═══════════════════════════════════════════════════════════════
# CONFIG
# ═══════════════════════════════════════════════════════════════

AWAAZ_VERIFY_URL = "http://localhost:8000/authenticate/verify"
AWAAZ_TIMEOUT_SECONDS = 60
DATABASE_URL = "sqlite:///./bank_data.db"

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


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def seed_database() -> None:
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        if not db.query(Account).filter(Account.cnic == "3333333333333").first():
            db.add(Account(cnic="3333333333333", full_name="Test User", balance=50000.0))
            db.commit()
            print("🌱 Seeded dummy account: 3333333333333 (Test User, PKR 50,000)")
    finally:
        db.close()


# ═══════════════════════════════════════════════════════════════
# APP
# ═══════════════════════════════════════════════════════════════

app = FastAPI(title="FinSecure Bank API", version="1.0.0")

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


# ═══════════════════════════════════════════════════════════════
# HELPERS
# ═══════════════════════════════════════════════════════════════

def normalize_cnic(cnic: str) -> str:
    """Strip dashes/spaces so '33333-3333333-3' == '3333333333333'."""
    return re.sub(r"\D", "", cnic or "")


def account_to_dict(acc: Account) -> dict:
    return {"cnic": acc.cnic, "full_name": acc.full_name, "balance": acc.balance}


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


# ── Urdu intent parsing (stub) ───────────────────────────────────

BALANCE_KEYWORDS = ["balance", "بیلنس", "بیلینس", "کتنے پیسے", "کتنی رقم", "باقی"]
TRANSFER_KEYWORDS = ["transfer", "ٹرانسفر", "بھیج", "بھیجو", "منتقل", "ادا"]


def transcribe_stub(_audio_bytes: bytes) -> str:
    """
    Lightweight transcription stub. Replace with a real ASR call
    (e.g. Whisper) later. For the demo we pretend the user asked to
    transfer funds in Urdu.
    """
    return "پانچ سو روپے ٹرانسفر کرو"  # "Transfer five hundred rupees"


def parse_intent(text: str) -> str:
    lowered = text.lower()
    if any(k in lowered for k in TRANSFER_KEYWORDS):
        return "TRANSFER"
    if any(k in lowered for k in BALANCE_KEYWORDS):
        return "CHECK_BALANCE"
    return "TRANSFER"  # demo default: any audio -> dummy transaction


# ═══════════════════════════════════════════════════════════════
# ROUTES
# ═══════════════════════════════════════════════════════════════

@app.get("/")
def health():
    return {"service": "FinSecure Bank API", "status": "ok"}


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
            detail = awaaz_resp.json()
        except ValueError:
            detail = awaaz_resp.text
        raise HTTPException(
            status_code=401,
            detail={"message": "Voice authentication failed.", "awaaz": detail},
        )

    account = db.query(Account).filter(Account.cnic == normalize_cnic(cnic)).first()
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


@app.post("/bank/command")
async def bank_command(
    cnic: str = Form(...),
    audio: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    """Mock Urdu voice command: any audio triggers a dummy transaction."""
    audio_bytes = await audio.read()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="Empty audio file.")

    account = db.query(Account).filter(Account.cnic == normalize_cnic(cnic)).first()
    if not account:
        raise HTTPException(status_code=404, detail="Account not found.")

    transcript = transcribe_stub(audio_bytes)
    intent = parse_intent(transcript)

    if intent == "CHECK_BALANCE":
        return {
            "status": "SUCCESS",
            "intent": intent,
            "transcript": transcript,
            "message": f"آپ کا موجودہ بیلنس {account.balance:,.0f} روپے ہے۔",
            "account": account_to_dict(account),
        }

    # TRANSFER (dummy): deduct a fixed demo amount
    amount = 500.0
    if account.balance < amount:
        raise HTTPException(status_code=400, detail="Insufficient funds.")

    account.balance -= amount
    db.commit()
    db.refresh(account)

    return {
        "status": "SUCCESS",
        "intent": intent,
        "transcript": transcript,
        "transaction": {
            "type": "TRANSFER",
            "amount": amount,
            "recipient": "Demo Beneficiary",
            "reference": f"FS-{random.randint(100000, 999999)}",
        },
        "message": f"{amount:,.0f} روپے کامیابی سے منتقل کر دیے گئے۔",
        "account": account_to_dict(account),
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("bank_main:app", host="0.0.0.0", port=8001, reload=True)