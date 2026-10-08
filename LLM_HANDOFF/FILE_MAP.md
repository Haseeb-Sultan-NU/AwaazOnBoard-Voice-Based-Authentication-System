# File Map

Paths are relative to the repo root. Line ranges are approximate (snapshot from 2026-10-05). Ask the user for exact ranges.
Excluded: `node_modules/`, `.next/`, `__pycache__/`, `package-lock.json`, binary assets (`*.pt`, `*.pth`, `*.wav`), and files deleted in the working tree (`backend/Tests/*`, `backend/test_api.py`, `backend/src/legacy/*`, most of `backend/src/audio/*`, `frontend/src/lib/api.ts`). **No test suite currently exists in the working tree.**

---

## Backend

### `backend/main.py` (1339 lines) — the entire FastAPI app
- PURPOSE: All routes, auth, startup/model loading, the ML pipeline orchestration and RBAC helpers. It is a single-file app.
- DEPENDS ON: `src/database.py` (`get_db`, `engine`, `Base`, `SessionLocal`, `_using_sqlite`), `src/models.py` (all models), `src/verification/*`, passlib/bcrypt, pydub, torch/torchaudio/soundfile, numpy, dotenv.
- USED BY: `uvicorn main:app` (run from `backend/`); the frontend via the `/api` rewrite.
- STATE: module-level dicts `models`, `audio_cache`, `active_sessions` (challenge session_id→digits), `active_auth_sessions` (login token→user). All are in-memory and lost on reload.

| Lines | Section | Notes |
|---|---|---|
| 1–39 | Imports | `from sqlalchemy import desc, or_, func, false` (L36) |
| 41–59 | Warning filters + Windows monkeypatch | Replaces `torchaudio.load` with a soundfile loader |
| 61–83 | Verification imports, globals, `cosine_sim`, `cleanup_temp_file` | |
| 84–192 | `lifespan` | `create_all`. Postgres-only `ALTER TABLE auth_logs ADD COLUMN IF NOT EXISTS`. Seeds `0000000000000/admin123` + `1111111111111/demo123` if users are empty. Rehashes plaintext passwords. Loads models (paths `models/best_urdu_triplet_ecapa.pth`, `data/audio_digits`). Caches digit WAVs |
| 194–203 | App + CORS | `allow_origins=["*"]`, credentials allowed |
| 205–253 | Security utils + Pydantic | `verify_password`, `get_password_hash`, `validate_cnic` (returns normalized 13 digits), `validate_password`, `UserSignup`, `UserLogin`, `ProfileUpdate`, `PasswordChange` |
| 255–331 | `/health`, `GET/PUT /profile`, `PUT /profile/password` | Identity comes from the param/body, **not the session** |
| 332–373 | `GET /challenge`, `GET /authenticate/audio/{session_id}` | Stitches Urdu digit prompt audio |
| 374–450 | `POST /enroll` | Staff self-enrollment. 3 takes → 16 kHz WAV → `EnrollmentManager.create_multi_template` → `data/enrollments/{id}_baseline.pt` + `Enrollment` row |
| 451–505 | `DELETE /enroll`, `DELETE /customers/enroll` | Deletes the DB rows and the `.pt` file. Not RBAC-checked |
| 506–603 | `POST /customers/enroll` | Form: `customer_cnic`, `customer_name`, `take_1..3`, phone/operator/imei, **`admin_user_id` (client-supplied → spoofable ownership)**. Auto-creates `Customer`, claims orphans |
| 604–703 | `POST /verify` | Legacy staff verification (writes `AuditLog`, lockout counters) |
| 704–730 | `POST /signup` | 503 on SQLite |
| 731–787 | `POST /login` | 503 on SQLite. Creates the token in `active_auth_sessions`. Sets HttpOnly `session_token` cookie (24h) |
| 789–807 | `GET /me` = **`get_current_user(request, db)`** | Cookie→session dict. Returns dict `{user_id, cnic, full_name, is_enrolled}`. 401 if missing. Also used as a dependency |
| 809–816 | `POST /logout` | |
| 818–832 | `POST /authenticate/challenge` | Stores `active_sessions[session_id]` |
| 834–859 | `_log_auth_attempt` | Inserts an `AuthLog` row (cnic stored exactly as received, may contain dashes) |
| 861–1094 | `POST /authenticate/verify` | Main pipeline. L877 WebM→WAV. L889–947 Gatekeeper + short-circuit (logs FAIL). L948–956 ASR+liveness. L957–1007 ECAPA vs `data/enrollments/{user_id}_baseline.pt`. L1008–1045 decision. L1046–1065 `AuditLog` insert. L1067–1086 `AuthLog` PASS/FAIL |
| 1096–1104 | `SUPER_ADMIN_CNIC`, `_normalize_cnic`, `_is_super_admin` | |
| 1106–1141 | `GET /authenticate/sessions` | Reads `AuditLog`. **Still uses the spoofable `?user_id=`** (next fix candidate) |
| 1143–1159 | `_scoped_customer_enrollments(db, user_id)` | RBAC helper (user asked not to modify) |
| 1161–1196 | `GET /enrollments` | Secured with `Depends(get_current_user)`. `user_id` ignored |
| 1198–1211 | `GET /stats/enrollments` | Secured |
| 1213–1231 | `_scoped_auth_logs(db, user_id)` | RBAC helper (user asked not to modify) |
| 1233–1256 | `GET /dashboard/stats` | Secured. `active_sessions` count is still global |
| 1258–1287 | `GET /logs` + `GET /api/logs` | Secured |
| 1289–1330 | `GET /enroll/check/{cnic}` | `.pt` file exists AND DB row (customer or staff) |
| 1332–1339 | `GET /enroll/status` | **Mock** response |
- RELEVANCE: **Very high.** Nearly all current work is here.

### `backend/src/models.py` (201 lines)
- PURPOSE: SQLAlchemy ORM models.
- KEY SYMBOLS:
  - `User` L25–51: PK `user_id` = CNIC, `cnic`, `hashed_password`, lockout fields.
  - `Enrollment` L58–77: staff voiceprint, `template_uri`.
  - `AuditLog` L84–112: FK `user_id`→users, pipeline fields.
  - `EnterpriseAPI` L119–128.
  - `Customer` L135–157: PK `customer_id` = normalized CNIC, **`admin_user_id` FK→users (owner)**.
  - `CustomerEnrollment` L164–183: FK `customer_id`, `status`.
  - `AuthLog` L190–201: `session_id`, `cnic` (no FK), `status` PASS/FAIL, scores, `latency_ms`, `timestamp`.
- USED BY: `main.py`, `alembic/env.py`.
- RELEVANCE: High (reference for joins). The user said not to modify it.

### `backend/src/database.py` (49 lines)
- PURPOSE: The engine tries `DATABASE_URL` (default `postgresql://admin:secret@localhost:5432/awaazonboard`) and falls back to in-memory SQLite (`StaticPool`), setting `_using_sqlite=True`. Provides `SessionLocal`, `get_db`.
- SIDE EFFECTS: Connects at import time.
- RELEVANCE: Medium (it explains the 503 on login and data loss when on SQLite).

### `backend/src/verification/` — ML modules (loaded once in `lifespan`)
| File | Class / methods | Purpose |
|---|---|---|
| `gatekeeper.py` (72) | `SecurityGatekeeper(hf_token)`, `check_audio_security(path)` →(bool,msg) | Pyannote diarization; rejects multiple speakers |
| `digit_asr.py` (92) | `UrduASRInference(model_size)`, `transcribe(path)` | Whisper ASR for Urdu digits |
| `liveness_validator.py` (61) | `LivenessValidator(pass_threshold)`, `evaluate_challenge(orig, asr)` | Fuzzy-matches the digits against the challenge |
| `ecapa_engine.py` (74) | `EcapaVerifier(model_source, finetuned_weights_path)`, `extract_embedding`, `verify_pair` | speechbrain ECAPA-TDNN embeddings |
| `enrollment.py` (85) | `EnrollmentManager(weights)`, `create_multi_template(user_id, paths)` | Writes `data/enrollments/{id}_baseline.pt`. Also has its own `custom_audio_load` |
| `challenge_generator.py` (51) | `ChallengeGenerator(prompt_audio_dir)`, `generate_numeric_challenge`, `stitch_audio_prompt` | Random digits + 8 kHz prompt audio |
- RELEVANCE: Low for the current RBAC task.

### Other backend files
- `backend/src/audio/simulator.py` (41): `TelephonySimulator` (8 kHz resample, band filter, noise). Not imported by `main.py`. Low relevance.
- `backend/reset_db.py` (10): DB reset utility (destructive). Low relevance.
- `backend/alembic.ini`, `backend/alembic/env.py` (83), `backend/alembic/versions/*.py` (4 migrations): Alembic is **not** run by app startup (which uses `create_all`). Low relevance.
- `backend/requirements.txt`: Python dependencies.

---

## Frontend (Next.js App Router, `frontend/src/app`)

### `frontend/next.config.ts` (15)
- Rewrite `/api/:path*` → `http://localhost:8000/:path*`. Same-origin, so the cookie is forwarded. RELEVANCE: Medium.

### `frontend/src/app/console/layout.tsx` (163)
- PURPOSE: Console shell/sidebar. L41–52 reads `awaaz_user` from localStorage for display. L64–72 `handleLogout` (POST `/api/logout`, clear storage, push `/login`). **No auth guard.** RELEVANCE: Medium.

### `frontend/src/app/console/page.tsx` (332) — Dashboard
- L53–60: reads the user from localStorage (`currentCnic`).
- L69–110: fetches `/api/authenticate/sessions?user_id=` (L74, spoofable backend), `/api/enroll/status` (L84, mock) and `/api/dashboard/stats?user_id=` (L94, param now ignored). Sets the stat cards.
- RELEVANCE: High.

### `frontend/src/app/console/enrollment/page.tsx` (781) — Voice Enrollment + Enrolled Profiles table
- L40: profile type (matches the `/enrollments` response).
- L239–285: customer enroll submit. **POST `/api/customers/enroll` with `admin_user_id` from localStorage**.
- L293–314: fetch `/api/enrollments?user_id=`.
- L318–323: `filteredProfiles` (null-safe search).
- L329: DELETE `/api/customers/enroll?customer_cnic=`.
- L655–781: table, `.map` with key `${p.type}-${p.user_id}` (L693–694).
- RELEVANCE: High.

### `frontend/src/app/console/logs/page.tsx` (263) — Audit logs
- L182–205: `fetchLogs` reads localStorage and GETs `/api/logs?user_id=`. Above it is the `AuthLogEntry` type and card rendering. No 401 handling. RELEVANCE: High.

### `frontend/src/app/console/authenticate/page.tsx` (untracked/new)
- `API="/api"` (L53). L164 `GET /enroll/check/{digits}`. L196 `POST /authenticate/challenge`. L289 `POST /authenticate/verify` (records mic audio). RELEVANCE: Medium (it writes the `AuthLog` rows that get scoped).

### `frontend/src/app/console/settings/page.tsx` (940)
- L123–190: profile load/save via `/api/profile?user_id=`, and syncs localStorage. L215: password change. L251: DELETE `/api/enroll?user_id=`. L370: POST `/api/enroll` (staff voice enrollment). All identity comes from localStorage. RELEVANCE: Medium (future RBAC hardening).

### `frontend/src/app/console/api-management/page.tsx` (133)
- Static/UI page; no fetches found. RELEVANCE: Low.

### Auth pages
- `frontend/src/app/login/page.tsx` (245): L63 POST `/api/login`. L77 sets `localStorage.awaaz_user`. L86 → `/console`. RELEVANCE: Medium.
- `frontend/src/app/signup/page.tsx` (270): L54 POST `/api/signup`, then auto-login (L75), sets storage. RELEVANCE: Low.

### Other frontend files
- `frontend/src/app/playground/page.tsx` (765): public demo. `API="/api"` (L86). Enroll customer (L224), challenge (L265), verify (L312). RELEVANCE: Low–Medium.
- `frontend/src/components/Navbar.tsx` (167): L31 reads the user. L61–68 logout. RELEVANCE: Low.
- `frontend/src/app/page.tsx` (148) landing, `layout.tsx` (26) root layout, `globals.css`. RELEVANCE: Low.
- `frontend/package.json`, `tsconfig.json`, `eslint.config.mjs`, `postcss.config.mjs`. `frontend/AGENTS.md` / `CLAUDE.md` contain agent notes for the Next.js version. Read them before editing frontend code.

---

## CURRENT TASK → FILES MOST LIKELY NEEDED
1. `backend/main.py` **L1096–1290**: RBAC helpers + all secured read endpoints + `/authenticate/sessions` (next fix).
2. `backend/main.py` **L731–816**: `login` / `get_current_user` / `logout` (session mechanism).
3. `backend/src/models.py` **L135–201**: `Customer`, `CustomerEnrollment`, `AuthLog` (join keys).
4. `frontend/src/app/console/page.tsx` **L50–110**: dashboard fetches.
5. `backend/main.py` **L506–603** + `frontend/src/app/console/enrollment/page.tsx` **L239–285**: ownership spoofing on customer enroll (if write routes become in scope).
6. `frontend/src/app/console/enrollment/page.tsx` **L293–330, L655–781**: table fetch/render.
7. `frontend/src/app/console/logs/page.tsx` **L182–210**.
8. `backend/main.py` **L834–859, L1046–1086**: how `AuthLog`/`AuditLog` rows are written (the cnic format).
9. `frontend/src/app/console/layout.tsx` **L40–72**: for adding 401/redirect handling.
10. `backend/src/database.py`: only if SQLite fallback / login 503 issues arise.
