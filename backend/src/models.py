"""
AwaazOnboard — SQLAlchemy ORM Models
=====================================
Enterprise-grade schema for the Telephony Speaker Verification platform.

Tables:
  - User:          Identity record keyed by Pakistani CNIC.
  - Enrollment:    Biometric voiceprint template (1:1 with User).
  - AuditLog:      Full audit trail of every verification attempt.
  - EnterpriseAPI: API key management for third-party integrations.
"""

from sqlalchemy import (
    Column, String, Integer, Float, DateTime, ForeignKey, Boolean, Text
)
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from src.database import Base


# ═══════════════════════════════════════════════════════════════
# USER — Identity & Telephony Metadata
# ═══════════════════════════════════════════════════════════════

class User(Base):
    __tablename__ = "users"

    # --- Core Identity ---
    user_id = Column(String, primary_key=True, index=True)           # Set to CNIC value
    cnic = Column(String(15), unique=True, index=True, nullable=False)
    full_name = Column(String(120), nullable=True)                   # Display name for dashboard
    email = Column(String(255), nullable=True)                        # Contact email
    hashed_password = Column(String, nullable=False)

    # --- Telephony / SIM Metadata ---
    phone_number = Column(String(15), nullable=True)                 # Pakistani format: 03XX-XXXXXXX
    network_operator = Column(String(20), nullable=True)             # Jazz, Zong, Telenor, Ufone, ONIC
    imei = Column(String(20), nullable=True)                         # 15-digit IMEI

    # --- Account State ---
    is_active = Column(Boolean, default=True)
    failed_attempts = Column(Integer, default=0)
    locked_out = Column(Boolean, default=False)

    # --- Timestamps ---
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # --- Relationships ---
    enrollment = relationship("Enrollment", back_populates="user", uselist=False, cascade="all, delete-orphan")
    audit_logs = relationship("AuditLog", back_populates="user", cascade="all, delete-orphan")


# ═══════════════════════════════════════════════════════════════
# ENROLLMENT — Biometric Voiceprint Template
# ═══════════════════════════════════════════════════════════════

class Enrollment(Base):
    __tablename__ = "enrollments"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(String, ForeignKey("users.user_id", ondelete="CASCADE"), unique=True, nullable=False)

    # --- Biometric Template ---
    template_uri = Column(String, nullable=False)                    # Path to .pt multi-template dictionary
    embedding_dim = Column(Integer, default=192)                     # ECAPA-TDNN = 192, future-proofs for WavLM 768
    audio_quality_snr = Column(Float, nullable=True)                 # Signal-to-noise ratio of enrollment audio

    # --- Lifecycle ---
    status = Column(String(20), default="ACTIVE")                    # ACTIVE | REVOKED | EXPIRED

    # --- Timestamps ---
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    # --- Relationships ---
    user = relationship("User", back_populates="enrollment")


# ═══════════════════════════════════════════════════════════════
# AUDIT LOG — Full AI Pipeline Verification Trail
# ═══════════════════════════════════════════════════════════════

class AuditLog(Base):
    __tablename__ = "audit_logs"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(String, ForeignKey("users.user_id", ondelete="CASCADE"), nullable=False)
    attempt_time = Column(DateTime(timezone=True), server_default=func.now(), index=True)

    # --- Stage 0: Gatekeeper (Pyannote Diarization) ---
    coercion_detected = Column(Boolean, nullable=False, default=False)
    diarization_speakers = Column(Integer, nullable=True)            # Number of speakers Pyannote detected

    # --- Stage 1: Liveness (Whisper ASR) ---
    expected_challenge = Column(String, nullable=True)               # System prompt, e.g. "2,4,5"
    transcribed_text = Column(String, nullable=True)                 # What Whisper actually heard
    liveness_passed = Column(Boolean, nullable=False, default=False)

    # --- Stage 2: Biometric Match (ECAPA-TDNN) ---
    biometric_score = Column(Float, nullable=True)                   # Raw cosine similarity
    model_version = Column(String(60), nullable=True)                # e.g. "best_urdu_triplet_ecapa.pth"

    # --- Final Outcome ---
    status = Column(String(30), nullable=False)                      # GRANTED | DENIED_COERCION | DENIED_LIVENESS | DENIED_BIOMETRIC

    # --- MLOps & Security Metadata ---
    inference_latency_ms = Column(Integer, nullable=True)            # End-to-end pipeline duration
    client_ip = Column(String(45), nullable=True)                    # IPv4 or IPv6

    # --- Relationships ---
    user = relationship("User", back_populates="audit_logs")


# ═══════════════════════════════════════════════════════════════
# ENTERPRISE API — Third-Party Integration Keys
# ═══════════════════════════════════════════════════════════════

class EnterpriseAPI(Base):
    __tablename__ = "enterprise_apis"

    id = Column(Integer, primary_key=True, index=True)
    api_key_hash = Column(String, unique=True, index=True, nullable=False)
    label = Column(String(100), nullable=True)                       # Friendly name, e.g. "JazzCash Prod"
    webhook_url = Column(Text, nullable=True)                        # Callback URL for async results
    total_calls = Column(Integer, default=0)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())