from sqlalchemy import Column, String, Integer, Float, DateTime, ForeignKey, Boolean
from sqlalchemy.sql import func
from src.database import Base

class User(Base):
    __tablename__ = "users"

    user_id = Column(String, primary_key=True, index=True)
    cnic = Column(String, unique=True, index=True, nullable=False)
    hashed_password = Column(String, nullable=False)                # <--- ADDED
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    is_active = Column(Boolean, default=True)
    failed_attempts = Column(Integer, default=0)
    locked_out = Column(Boolean, default=False)

class Enrollment(Base):
    __tablename__ = "enrollments"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(String, ForeignKey("users.user_id", ondelete="CASCADE"), unique=True)
    template_uri = Column(String, nullable=False) # S3 Path or local path to .pt file
    created_at = Column(DateTime(timezone=True), server_default=func.now())

class AuditLog(Base):
    __tablename__ = "audit_logs"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(String, ForeignKey("users.user_id", ondelete="CASCADE"))
    attempt_time = Column(DateTime(timezone=True), server_default=func.now())
    
    # --- AI Pipeline Audit Trail ---
    coercion_detected = Column(Boolean, nullable=False, default=False) # Gatekeeper (Pyannote) result
    expected_challenge = Column(String, nullable=True)                 # What the system asked (e.g., "2,4,5")
    transcribed_text = Column(String, nullable=True)                   # What Whisper actually heard
    liveness_passed = Column(Boolean, nullable=False)                  # Whisper validation result
    biometric_score = Column(Float, nullable=True)                     # ECAPA-TDNN score
    
    # --- Final Outcome ---
    status = Column(String, nullable=False) # e.g., "GRANTED", "DENIED_COERCION", "DENIED_LIVENESS", "DENIED_BIOMETRIC"