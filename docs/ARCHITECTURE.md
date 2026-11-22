# Architecture — Awaaz × FinSecure

Snapshot: 2026-11-16, branch `feature/finsecure-bank-integration`. Line numbers are approximate.
Keep this file in sync with the code: update it whenever a module, endpoint or flow changes.

---

## 1. System overview

```
                         ┌──────────────────────────── Browser ────────────────────────────┐
                         │                                                                 │
  Admin console (Next.js :3000)                                  FinSecure portal (Next.js :3001)
  fetch("/api/...") ─► Next rewrite ─┐                           │ fetch(:8000/authenticate/challenge)
                                     │                           │ fetch(:8001/bank/login | /bank/command)
                                     ▼                           ▼
                     ┌──────────────────────────────┐   ┌───────────────────────────────┐
                     │ Awaaz API  (FastAPI :8000)   │◄──│ FinSecure API (FastAPI :8001) │
                     │ backend/main.py              │   │ bank-backend/bank_main.py     │
                     │  Gatekeeper (pyannote)       │   │  Whisper small (own copy)     │
                     │  Whisper small ASR           │   │  Urdu NLU + ledger            │
                     │  ECAPA-TDNN (fine-tuned)     │   └──────────────┬────────────────┘
                     └───────┬──────────────┬───────┘                  │
                             ▼              ▼                          ▼
              PostgreSQL "awaazonboard"   disk: data/enrollments/   SQLite bank_data.db
              (fallback: in-memory SQLite)      {cnic}_baseline.pt   (accounts, transactions)
```

Docker Compose services: `postgres`, `awaaz-backend` (8000), `bank-backend` (8001), `awaaz-ui` (3000),
`bank-frontend` (3001). Volumes: `postgres_data`, `awaaz_enrollments` (voiceprints), `bank_data` (ledger).

---

## 2. `backend/` — Awaaz identity provider

### 2.1 `main.py` (single-file FastAPI app)
**Module state** (in-memory, lost on restart): `models` (loaded ML objects), `audio_cache` (digit
AudioSegments + silence), `active_sessions` (challenge session_id → digit list), `active_auth_sessions`
(login token → {user_id, cnic, full_name}).

**Startup `lifespan`** (L86–193):
1. `Base.metadata.create_all`.
2. On Postgres only: `ALTER TABLE auth_logs ADD COLUMN IF NOT EXISTS ...`.
3. If `users` is empty, seed the admin + demo users.
4. Re-hash any plain-text passwords.
5. Load models: `SecurityGatekeeper(HF_TOKEN)`, `UrduASRInference("small")`, `LivenessValidator(0.80)`,
   `EcapaVerifier(models/best_urdu_triplet_ecapa.pth)`, `ChallengeGenerator(data/audio_digits)`,
   `EnrollmentManager(...)` (which loads a **second** ECAPA copy).
6. Cache the digit WAVs.

CORS: `allow_origins=["*"]` with credentials.

**Helpers**

| Function | Purpose |
|---|---|
| `custom_audio_load` | soundfile replacement for `torchaudio.load` (Windows) |
| `cosine_sim`, `cleanup_temp_file` | math / temp-file deletion |
| `verify_password`, `get_password_hash` | bcrypt via passlib |
| `validate_cnic` | strip spaces/dashes, require 13 digits (422 otherwise) |
| `validate_password` | min 8 chars |
| `_log_auth_attempt` | insert one `AuthLog` row (own commit, swallows errors) |
| `_normalize_cnic`, `_is_super_admin` | `SUPER_ADMIN_CNIC = "0000000000000"` |
| `_scoped_customer_enrollments(db, cnic)` | RBAC query: CustomerEnrollment ⋈ Customer filtered by owner; fail-closed |
| `_scoped_auth_logs(db, cnic)` | RBAC query: AuthLog ⋈ Customer on `replace(cnic,'-','')`; fail-closed |
| `_raw_cosine_from_confidence` | invert UX score → raw cosine |
| `_classify_auth_log` | (verdict, blocked_stage) from status + failure_reason text |
| `_auth_channel` | "command" if session_id contains `:`, else "login" |

**Pydantic schemas**: `UserSignup`, `UserLogin`, `ProfileUpdate`, `PasswordChange`, `EnterpriseVerifyRequest`.

**Endpoints** (Auth column: 🔒 = `Depends(get_current_user)`; ⚠ = identity taken from client input)

| Method & path | Auth | What it does |
|---|---|---|
| GET `/health` | – | `{status, models_loaded}` |
| GET `/profile?user_id=` | ⚠ | staff profile + enrollment info |
| PUT `/profile` | ⚠ | update name/phone/email/operator by `payload.user_id` |
| PUT `/profile/password` | ⚠ | change password (needs current password) |
| DELETE `/profile` | 🔒 | delete agent + owned customers + their logs + voiceprint rows (`.pt` files not removed) |
| GET `/challenge` | – | legacy: 3 digits + base64 WAV prompt (no session stored) |
| GET `/authenticate/audio/{session_id}` | – | stitched 8 kHz prompt WAV for a challenge session |
| POST `/enroll` | ⚠ | **staff** self-enrollment: 3 takes → `.pt` + `Enrollment` row |
| DELETE `/enroll?user_id=` | ⚠ | revoke staff voiceprint (row + file) |
| POST `/customers/enroll` | ⚠ | **customer** enrollment. Form: `customer_cnic, customer_name, take_1..3, phone_number, network_operator, imei, admin_user_id, sandbox`. Auto-creates `Customer`, claims orphans |
| DELETE `/customers/enroll?customer_cnic=` | ⚠ (none) | delete customer + enrollment + file, no ownership check |
| POST `/verify` | – | **legacy** staff verify (AuditLog + 3-strike lockout) |
| POST `/signup` | – | create staff user (503 on SQLite) |
| POST `/login` | – | CNIC-or-email + password → `session_token` cookie (24 h); 503 on SQLite |
| GET `/me` (= `get_current_user`) | cookie | session → user dict; 401 if none |
| POST `/logout` | cookie | drop session, clear cookie |
| POST `/authenticate/challenge` | – | new `session_id` + 3 random digits in `active_sessions` |
| POST `/authenticate/verify` | – | **main pipeline** (see §5.2). Form: `session_id, user_id, voice, sandbox` |
| POST `/authenticate/continuous` | – | Gatekeeper + ECAPA on free speech, no challenge (bank step-up) |
| GET `/authenticate/sessions?user_id=` | ⚠ | recent `AuditLog` rows (dashboard "recent sessions") |
| GET `/enrollments` | 🔒 | scoped customer enrollments table |
| GET `/stats/enrollments` | 🔒 | scoped count |
| GET `/dashboard/stats` | 🔒 | attempts, threats_blocked (FAIL), enrollments (scoped); `active_sessions` is global |
| GET `/logs`, `/api/logs` | 🔒 | scoped AuthLog rows + forensic fields (verdict, stage, channel, raw cosine, margin) |
| GET `/enroll/check/{cnic}` | – | `enrolled` = `.pt` exists AND an ACTIVE customer/staff row |
| GET `/enroll/status` | – | **mock** (always enrolled, 0.99) |
| POST `/api/v1/verify` | – | **mock** B2B endpoint: sleeps 1 s, always PASS 0.92 |

### 2.2 `src/database.py`
Reads `DATABASE_URL` (default `postgresql://admin:secret@localhost:5432/awaazonboard`), probes it at
import time, and on failure switches to `sqlite:///:memory:` + `StaticPool` with `_using_sqlite=True`.
Exposes `Base`, `engine`, `SessionLocal`, `get_db`.

### 2.3 `src/models.py` — data model
| Table | PK | Key columns / relations |
|---|---|---|
| `users` | `user_id` (= CNIC) | cnic (unique), full_name, email, hashed_password, phone, operator, imei, failed_attempts, locked_out |
| `enrollments` | id | user_id → users (unique, CASCADE), template_uri, embedding_dim=192, status |
| `audit_logs` | id | **user_id → users (NOT NULL FK)**, coercion_detected, expected_challenge, transcribed_text, liveness_passed, biometric_score, status (GRANTED/DENIED_*) |
| `enterprise_apis` | id | api_key_hash, label, webhook_url (unused by any route) |
| `customers` | `customer_id` (= CNIC) | full_name, phone, operator, imei, **admin_user_id → users (SET NULL)** = owning agent |
| `customer_enrollments` | id | customer_id → customers (unique, CASCADE), template_uri, status |
| `auth_logs` | id | session_id, cnic (**no FK**), status PASS/FAIL, liveness_score, match_confidence (UX), failure_reason, latency_ms, timestamp |

### 2.4 `src/verification/` — ML modules (loaded once at startup)
| File | Class · methods | Notes |
|---|---|---|
| `gatekeeper.py` | `SecurityGatekeeper(hf_token)` · `check_audio_security(path) -> (bool, msg)` | pyannote/speaker-diarization-3.1. Pads clips to 3 s. 0 speakers → reject, >1 → reject (coercion). Fails closed if the pipeline didn't load |
| `digit_asr.py` | `UrduASRInference(model_size)` · `transcribe(path) -> list[str]` | Whisper (`language="ur"`, digit initial prompt, temp 0). Energy-trims silence and maps Urdu words/typos → roman digit words. Returns the first 5 |
| `liveness_validator.py` | `LivenessValidator(pass_threshold)` · `evaluate_challenge(digits, words)` | `difflib.SequenceMatcher` ratio vs expected words. Returns `{liveness_passed, confidence_score(0-100), status_message}` |
| `ecapa_engine.py` | `EcapaVerifier(model_source, finetuned_weights_path)` · `extract_embedding(path)`, `verify_pair(...)` | speechbrain `spkrec-ecapa-voxceleb` (savedir `models/pretrained/`) with the fine-tuned state_dict loaded into `mods.embedding_model` |
| `enrollment.py` | `EnrollmentManager(weights)` · `create_multi_template(id, paths)` | Per take: clean embedding + TelephonySimulator(8 kHz, SNR 15) embedding. Saves `{"clean": mean, "telephony": mean}` to `data/enrollments/{id}_baseline.pt`. Uses a shared temp file `temp_enr_noisy.wav` in cwd |
| `challenge_generator.py` | `ChallengeGenerator(dir)` · `generate_numeric_challenge(n)`, `stitch_audio_prompt(seq)` | `secrets.choice` digits. Stitch writes `tmp_challenge_*.wav` into cwd (never deleted) |

`src/audio/simulator.py` — `TelephonySimulator`: resample → 8 kHz, 300 Hz HP + 3400 Hz LP biquads,
white noise at the given SNR, peak-normalize.

### 2.5 Other backend files
- `alembic/` + `alembic.ini`: 4 migrations (initial → auth → CNIC swap → enterprise). **Out of sync with
  models.py** (no customers/customer_enrollments/auth_logs; drops users.email). Not used at runtime.
- `reset_db.py`: drop_all + create_all (**destructive**).
- `scripts/prefetch_models.py`: Docker build step that caches Whisper small, ECAPA and pyannote (needs `HF_TOKEN`).
- `Dockerfile`: python:3.10-slim, CPU torch 2.1, models baked in, then `HF_HUB_OFFLINE=1`; non-root user; healthcheck on `/health`.
- `tmp_model/`, `models/pretrained/spkrec-ecapa-voxceleb/`: Windows symlinks into the HF cache.

---

## 3. `bank-backend/bank_main.py` — FinSecure

**Config (env)**: `AWAAZ_API_URL` (default `http://localhost:8000`), `BANK_DATABASE_URL`
(default `sqlite:///./bank_data.db`), `BANK_CORS_ORIGINS`, `BANK_ASR_DEVICE` (auto|cpu|cuda),
`WHISPER_CACHE_DIR` / `XDG_CACHE_HOME`.
**Constants**: `HIGH_VALUE_THRESHOLD_PKR=10,000`, `CONFIRMATION_TTL_SECONDS=120`,
`CONFIRMATION_MAX_ATTEMPTS=3`, `VOICE_TRANSFER_LIMIT_PKR=500,000`, `MAX_AUDIO_SECONDS=30`,
`ECAPA_EER_THRESHOLD=0.2393` (mirror).

**Tables**: `accounts(cnic PK, full_name, balance Float)`, `transactions(id, reference FS…, cnic FK,
direction, category, counterparty, amount, balance_after, channel, transcript, created_at)`.
`seed_database()` creates the tables and upserts the two seed accounts (never resets a balance).

**Sections**

| Section | Key symbols |
|---|---|
| Helpers | `normalize_cnic`, `account_to_dict`, `awaaz_response_is_pass` (defensive reading of the Awaaz payload) |
| ASR | `UrduSpeechTranscriber`: lazy thread-safe Whisper load from the local cache only (never downloads). `transcribe()` checks duration, energy VAD, encodes once, then a primed decode (`ASR_PROMPT` / `CONFIRM_PROMPT`); if `_quality_problem` flags no-speech, loops or prompt echo, it runs an unprimed second decode |
| NLU | `normalize_urdu`, `tokenize`, `extract_number_spans` (Urdu/English number words, سو/ہزار/لاکھ/کروڑ multipliers, fuzzy skeletons), `pick_amount`, `extract_recipient`, `_has_cue`, `parse_command → ParsedCommand{intent: TRANSFER / CHECK_BALANCE / NEEDS_AMOUNT / NEGATED / UNKNOWN, amount, recipient, confidence, signals}`, `_is_prompt_echo` |
| Ledger | `validate_transfer`, `execute_transfer` (conditional UPDATE `balance >= amount`, so no double spend), `_new_reference` |
| Forensics | `build_forensics(awaaz_body, channel)`: normalizes an Awaaz rejection into checks / flags / primary_factor / explanation for the UI. `biometric_rejection` |
| Step-up | `PendingTransfer` dataclass, `_pending` dict + lock, `create_pending` (one per account), `get_pending` (bound to CNIC), `discard_pending`, `confirmation_decision` (negation wins) |

**Endpoints**

| Path | What it does |
|---|---|
| GET `/` | health + ASR status |
| POST `/bank/login` (cnic, session_id, audio) | forwards to Awaaz `/authenticate/verify`. On PASS looks up the account; on FAIL → 401 + forensics |
| POST `/bank/command` (cnic, audio, confirmation_token?) | Awaaz `/authenticate/continuous` (fail-closed) → Whisper → parse → balance / transfer. ≥ 10k → `CONFIRMATION_REQUIRED` + token; the next recording carrying the token must say a confirm phrase |

There is no bank session: every command is authenticated only by the voice match on that recording.

---

## 4. Frontends

### 4.1 `frontend/` — Awaaz enterprise console (Next.js 16, :3000)
`next.config.ts` rewrites `/api/:path*` → `${AWAAZ_API_INTERNAL_URL:-http://localhost:8000}/:path*`
(same origin, so the session cookie flows). There is no auth guard or middleware. Pages read
`localStorage.awaaz_user` for display.

| Route (file) | Purpose · backend calls |
|---|---|
| `/` (`app/page.tsx`) | landing page |
| `/login`, `/signup` | `POST /login`, `/signup` (signup auto-logs-in) → store `awaaz_user` → `/console` |
| `/console` (`console/page.tsx`) | dashboard: `/authenticate/sessions?user_id=`, `/enroll/status` (mock), `/dashboard/stats` |
| `/console/enrollment` | customer enrollment (3 takes) `POST /customers/enroll` with `admin_user_id` from localStorage; table `GET /enrollments`; delete `DELETE /customers/enroll` |
| `/console/authenticate` | agent verifies a caller: `/enroll/check/{cnic}` → `/authenticate/challenge` → `/authenticate/verify` |
| `/console/logs` | forensic AuthLog viewer `GET /logs` |
| `/console/settings` | profile, password, staff voice enroll/revoke, delete account |
| `/console/api-management` | B2B docs + sandbox: enroll/verify with `?sandbox=true` (see PROGRESS bug), mock `/api/v1/verify` |
| `/playground` | public demo: enroll (same blob ×3) → challenge → verify, no auth |
| `/docs` | placeholder |
| `components/Navbar.tsx`, `console/layout.tsx` | nav/sidebar, logout |

### 4.2 `bank-frontend/` — FinSecure portal (Next.js 16, :3001)
A single client component, `src/app/page.tsx` (~1700 lines), plus `components/AudioVisualizer.tsx`.
Hard-coded `AWAAZ_URL=http://localhost:8000` and `BANK_URL=http://localhost:8001`.
- Voice login: `POST :8000/authenticate/challenge` → shows digits → record (converted to WAV) → `POST :8001/bank/login`.
- Password tab: **client-side only** check against `DEMO_PASSWORD="admin123"`. It opens a fake session (balance 50,000).
- Dashboard: balance, IBAN derived from CNIC, a transaction list that **starts from hard-coded `SEED_TXNS`**
  (the ledger isn't fetched), the voice-command panel, the step-up confirmation countdown, and `ForensicsModal`.

---

## 5. End-to-end flows

### 5.1 Customer enrollment (console)
Agent fills CNIC/name/phone and records 3 takes (WebM) → `POST /api/customers/enroll` → each take is
converted to 16 kHz mono WAV → `EnrollmentManager.create_multi_template` (clean + telephony-simulated
embeddings, averaged per branch) → `data/enrollments/{cnic}_baseline.pt` → `Customer` (owner =
`admin_user_id`) + `CustomerEnrollment` rows.

### 5.2 Verification `POST /authenticate/verify`
1. Look up `active_sessions[session_id]` (else 400). WebM → 16 kHz WAV.
2. Gatekeeper. On fail: short-circuit, `AuditLog(DENIED_COERCION)` + `AuthLog FAIL`, return.
3. Whisper → `LivenessValidator` (score/100).
4. Load `.pt` (dict / tensor / list), keep the 192-d vectors, max cosine vs the live embedding; match if ≥ 0.2393.
5. UX score: match → 0.80 + (s−T)/(1−T)·0.2; non-match → (s+1)/(T+1)·0.79.
6. `authenticated = liveness AND match`. Delete the challenge session. Write `AuditLog` + `AuthLog`
   (both skipped in sandbox, where the `.pt` is deleted instead).
Response: `authenticated, similarity_score (UX), raw_similarity, threshold, liveness_score, liveness_passed,
risk_score, gatekeeper_score, session_id, message`.

### 5.3 Bank voice login
Bank UI → Awaaz challenge (browser) → user speaks the digits → `POST /bank/login` → bank → Awaaz
`/authenticate/verify` → PASS → account JSON → dashboard.

### 5.4 Bank voice command
Record a command → `POST /bank/command` → Awaaz `/authenticate/continuous` (Gatekeeper + ECAPA,
`AuthLog` session `tx_command:xxxx`) → Whisper → `parse_command`:
- CHECK_BALANCE → return the balance.
- TRANSFER < 10k → `execute_transfer`.
- TRANSFER ≥ 10k → pending token (120 s). The next recording with the token is biometric-checked again and
  `confirmation_decision`: confirm → debit; cancel → drop; unclear → up to 3 tries.

### 5.5 Admin auth + RBAC reads
`POST /login` → cookie → `get_current_user`. `/enrollments`, `/stats/enrollments`, `/dashboard/stats` and `/logs`
scope by `current_user.cnic` through the `_scoped_*` helpers (super admin = global).

---

## 6. External services, models, config & secrets
- **Hugging Face**: `pyannote/speaker-diarization-3.1` (+ `segmentation-3.0`, gated; needs `HF_TOKEN`),
  `speechbrain/spkrec-ecapa-voxceleb`. **OpenAI Whisper** `small` (downloaded to `~/.cache/whisper` or `$XDG_CACHE_HOME/whisper`).
  In Docker everything is baked in at build time and the network is never used at runtime.
- **Local model file**: `backend/models/best_urdu_triplet_ecapa.pth` (fine-tuned ECAPA, triplet loss, Urdu).
  The training/evaluation code is **not in this repo** (see PROGRESS open questions).
- **Env var names** (values live in git-ignored `.env` files; never commit them):
  - root `.env` (compose): `DOCKER_USER`, `HF_TOKEN`, optional `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`.
  - `backend/.env` (local dev, read by `load_dotenv`): `HF_TOKEN`, `DATABASE_URL` (assumed; unconfirmed).
  - awaaz-backend: `DATABASE_URL`, `HF_HUB_OFFLINE`, `XDG_CACHE_HOME`, `HF_HOME`.
  - bank-backend: `AWAAZ_API_URL`, `BANK_DATABASE_URL`, `BANK_CORS_ORIGINS`, `BANK_ASR_DEVICE`, `WHISPER_CACHE_DIR`.
  - awaaz-ui: `AWAAZ_API_INTERNAL_URL` (build arg + env).
- **Hard-coded credentials in code** (demo only): seed passwords in `main.py` lifespan, Postgres defaults in
  `database.py` / compose, `DEMO_PASSWORD` in bank-frontend.
