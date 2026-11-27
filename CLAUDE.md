# CLAUDE.md — Awaaz × FinSecure (Telephony Speaker Verification FYP)

Read this first in every session. Open `docs/ARCHITECTURE.md` (detailed map) or
`docs/PROGRESS.md` (status, bugs, decisions) only when the task needs them.
**When a piece of work is finished, update whichever of these three files changed.**

## What this is
Final-year project: a voice-biometric identity platform for **Urdu speakers over telephony-quality audio**.
- **Awaaz** (`backend/` + `frontend/`): an identity provider. Agents enroll customers' voices (3 takes) and
  verify callers with a 3-stage pipeline:
  0. **Gatekeeper**: pyannote diarization rejects no-speech / multiple speakers (coercion).
  1. **Liveness**: random 3-digit Urdu challenge → Whisper "small" ASR → fuzzy match (≥ 0.80).
  2. **Biometric**: fine-tuned ECAPA-TDNN embedding (192-d), max cosine vs a clean + telephony-simulated
     template, threshold **0.2393** (`ECAPA_EER_THRESHOLD`).
- **FinSecure** (`bank-backend/` + `bank-frontend/`): a mock bank that consumes Awaaz. Voice login via
  Awaaz challenge-response, then an **Urdu voice-banking agent** (balance / transfer). Each command is
  re-verified with Awaaz `/authenticate/continuous`, and transfers ≥ PKR 10,000 need a spoken confirmation.
- Git remote: `Haseeb-Sultan-NU/AwaazOnBoard-Voice-Based-Authentication-System`. The active branch is
  `feature/finsecure-bank-integration`.

## Tech stack
- Backends: Python (3.10 in Docker, 3.11 locally), FastAPI 0.109, SQLAlchemy 2, PyTorch 2.1 (CPU),
  speechbrain 0.5.16, pyannote.audio 3.1.1, openai-whisper, pydub (+ ffmpeg), passlib/bcrypt.
- DB: PostgreSQL 15 for Awaaz (in-memory SQLite fallback if unreachable); SQLite file for the bank ledger.
- Frontends: Next.js 16 (App Router, React 19, TypeScript, Tailwind 4). **This Next.js version has breaking
  changes**: read `frontend/AGENTS.md` and `node_modules/next/dist/docs/` before editing frontend code.
- Deploy: `docker-compose.yml` (5 services), images pushed to Docker Hub under `$DOCKER_USER`.

## Layout
```
backend/                Awaaz API (port 8000)
  main.py               the ENTIRE API: all routes, auth, RBAC, pipeline orchestration (~1665 lines)
  src/database.py       engine (Postgres → SQLite fallback), SessionLocal, get_db
  src/models.py         ORM: User, Enrollment, AuditLog, EnterpriseAPI, Customer, CustomerEnrollment, AuthLog
  src/verification/     gatekeeper, digit_asr, liveness_validator, ecapa_engine, enrollment, challenge_generator
  src/audio/simulator.py  TelephonySimulator (8 kHz, 300–3400 Hz band-pass, noise) used at enrollment
  models/best_urdu_triplet_ecapa.pth   fine-tuned ECAPA weights (git-ignored, ~83 MB)
  data/audio_digits/0-9.wav            Urdu digit prompts (git-ignored)
  data/enrollments/{cnic}_baseline.pt  voiceprint templates (biometric data, git-ignored)
  alembic/              migrations, STALE (startup uses create_all instead)
  scripts/prefetch_models.py  bakes Whisper/ECAPA/pyannote into the Docker image
bank-backend/bank_main.py     FinSecure API (port 8001): login proxy, Whisper ASR, Urdu NLU, ledger
frontend/               Awaaz enterprise console (port 3000); /api/* is rewritten to the backend
bank-frontend/          FinSecure portal (port 3001); a single 1700-line page.tsx that calls :8000 and :8001 directly
deepfake/               anti-spoofing (XLSR-SLS) pipeline run on Colab: config.json, scripts/, model/ (HF port), colab/AwaazDeepfake.ipynb
LLM_HANDOFF/            older (2026-10-05) hand-off notes, superseded by docs/
docker-compose.yml, start.bat, .env.example
```

## Run
**Docker (the evaluator path):** `cp .env.example .env` (set `DOCKER_USER` and `HF_TOKEN`), then
`docker compose build && docker compose push`. On another machine run `start.bat` (pull + `up -d --no-build`).
Bank UI: http://localhost:3001 · Admin console: http://localhost:3000.

**Local dev (4 terminals, Windows):**
```bash
# 0. Postgres running at DATABASE_URL (default postgresql://admin:secret@localhost:5432/awaazonboard)
cd backend && source venv/Scripts/activate        # install torch 2.1 CPU first (see requirements.txt header)
uvicorn main:app --reload --port 8000             # start this first: it downloads Whisper small.pt
cd bank-backend && ../backend/venv/Scripts/python -m uvicorn bank_main:app --port 8001 --reload
cd frontend && npm install && npm run dev         # :3000
cd bank-frontend && npm install && npm run dev -- -p 3001
```
- Needs `ffmpeg` on PATH, plus an `HF_TOKEN` that has accepted the pyannote/speaker-diarization-3.1 and
  segmentation-3.0 terms.
- **Do not run `alembic upgrade head`** (the README says to, but it's wrong). The migrations are stale:
  they drop `users.email` and never create customers/auth_logs. Startup `create_all` builds the schema.
- Seeded logins on an empty DB: `0000000000000` / `admin123` (super admin) and `1111111111111` / `demo123`.
  Bank seed accounts: `1111111111111` (Haseeb Sultan), `3333333333333` (Ayesha Siddiqui), PKR 50,000 each.

## Test / lint / build
- **There is no test suite** (old `backend/Tests/` was deleted). Don't write or run tests unless asked.
- Frontends: `npm run lint`, `npm run build`. Backends: no linter is configured.

## Conventions
- **CNIC is the identity key everywhere.** Normalize it to 13 digits (`_normalize_cnic` / `validate_cnic`
  in main.py, `normalize_cnic` in bank_main.py). `users.user_id == cnic` and `customers.customer_id == cnic`.
- Users = staff/agents with dashboard logins. Customers = end-users without logins, owned by
  `Customer.admin_user_id`.
- RBAC: super admin = CNIC `0000000000000` sees everything. Agents see only the customers they own and
  those customers' AuthLogs. Read paths must go through `_scoped_customer_enrollments` / `_scoped_auth_logs`.
- Session: `POST /login` → HttpOnly `session_token` cookie → in-memory `active_auth_sessions`.
  Use `Depends(get_current_user)` and never trust `?user_id=`. The frontend keeps `awaaz_user` in
  localStorage for display only.
- Telemetry: `AuthLog` (PASS/FAIL, written by `_log_auth_attempt`) drives the dashboard and Logs page.
  `AuditLog` is the older detailed trail.
- Score shown to users = "UX score" (match 0.80–1.0, non-match 0–0.79). Raw cosine is `raw_similarity`.
  `_raw_cosine_from_confidence` inverts the mapping.
- Whisper size must stay `"small"` in three places: main.py, bank_main.py `WHISPER_MODEL_SIZE`, prefetch_models.py.
- User's standing preference (from earlier sessions): minimal, low-risk edits, and don't touch files
  outside the task's scope.

## Gotchas
- Every backend path is relative to `backend/` (`models/...`, `data/...`). Run uvicorn **from `backend/`**.
- If Postgres is down, the API silently falls back to in-memory SQLite. Then `/login` and `/signup`
  return 503 and all data is lost on restart.
- `active_auth_sessions` / `active_sessions` are in-memory: every `--reload` logs everyone out (secured GETs → 401).
- If the fine-tuned `.pth` is missing, `EcapaVerifier` silently falls back to the base English model,
  but the 0.2393 threshold is calibrated for the fine-tuned model.
- A fresh git clone **cannot** build the backend image: weights, digit WAVs and `*.yaml` are git-ignored.
- main.py monkeypatches `torchaudio.load` with a soundfile loader (Windows fix); enrollment.py does the same.
- ML calls run inside `async def` routes, so they block the event loop (requests are effectively serialized).
- Bank `/bank/command` sends `audio/wav` (the bank UI converts recordings to WAV). The Awaaz console sends WebM.
- Ports are hard-coded in bank-frontend (`http://localhost:8000` / `:8001`), so the browser must reach both.

## Docs
- `docs/ARCHITECTURE.md`: per-module map, every endpoint, data model, end-to-end flows, config/secrets.
- `docs/PROGRESS.md`: what works, what's broken, suspected bugs, open questions, decisions log, next steps.
- `docs/DEMO_QA.md`: examiner-style questions and answers for the deepfake demo (append new ones).
- `docs/DEEPFAKE_TRACKER.md`: **current focus.** Deepfake-defense status board, exact model/training constraints,
  frozen-eval rules, Colab/Drive manual, run log. Read it for any deepfake task and update it after every step.
