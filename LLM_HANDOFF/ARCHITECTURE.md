# Architecture (actual repository)

## Components
```mermaid
flowchart LR
  subgraph Browser
    UI["Next.js pages (frontend/src/app)"]
    LS[("localStorage: awaaz_user")]
    CK[("HttpOnly cookie: session_token")]
  end
  subgraph Next["Next.js dev server :3000"]
    RW["rewrite /api/:path* -> http://localhost:8000/:path* (next.config.ts)"]
  end
  subgraph API["FastAPI :8000 (backend/main.py)"]
    R["Routes"]
    MEM[("In-memory: active_auth_sessions, active_sessions, audio_cache, models")]
    ML["Verification modules (backend/src/verification)"]
  end
  DB[("PostgreSQL awaazonboard\nfallback: in-memory SQLite")]
  FS[("Disk: data/enrollments/*_baseline.pt\ndata/audio_digits/0-9.wav\nmodels/best_urdu_triplet_ecapa.pth")]
  HF["HuggingFace (HF_TOKEN): pyannote, speechbrain ECAPA, Whisper"]

  UI -->|fetch /api/...| RW --> R
  UI <--> LS
  CK -.sent automatically.-> RW
  R <--> MEM
  R --> ML
  R <--> DB
  ML <--> FS
  ML -.model download at startup.-> HF
```

## Authentication flow
```mermaid
sequenceDiagram
  participant P as login/page.tsx
  participant A as FastAPI
  participant S as active_auth_sessions (dict)
  P->>A: POST /api/login {cnic|email, password}
  A->>A: bcrypt verify (503 if SQLite fallback)
  A->>S: token(uuid4) -> {user_id, cnic, full_name}
  A-->>P: Set-Cookie session_token (HttpOnly, 24h) + user JSON
  P->>P: localStorage.awaaz_user = user JSON; push /console
  Note over P,A: Secured GETs (/enrollments, /stats/enrollments,<br/>/dashboard/stats, /logs) use Depends(get_current_user)<br/>= GET /me logic: cookie -> S -> cnic, else 401
  P->>A: POST /api/logout -> delete token, clear cookie
```
The frontend uses localStorage only for display and for (now ignored) `?user_id=` params. There is no frontend route guard.

## RBAC scoping (read side)
```mermaid
flowchart TD
  C["current_user.cnic (from session)"] --> SA{"_is_super_admin?\n== 0000000000000"}
  SA -- yes --> ALL["no filter (global)"]
  SA -- no --> F["Customer.admin_user_id == cnic"]
  F --> E["_scoped_customer_enrollments\nCustomerEnrollment JOIN Customer"]
  F --> L["_scoped_auth_logs\nAuthLog JOIN Customer ON replace(cnic,'-','')=customer_id"]
  E --> T1["/enrollments table"] & T2["/dashboard/stats total_enrollments"] & T3["/stats/enrollments"]
  L --> U1["/logs"] & U2["/dashboard/stats verification_attempts, threats_blocked"]
```

## Verification flow (console Authenticate / Playground)
```mermaid
sequenceDiagram
  participant F as authenticate/page.tsx or playground/page.tsx
  participant A as FastAPI
  F->>A: GET /api/enroll/check/{cnic} (template file + DB row exist?)
  F->>A: POST /api/authenticate/challenge -> {session_id, challenge}; active_sessions[id]=digits
  F->>A: POST /api/authenticate/verify (WebM audio + session_id + user_id)
  A->>A: pydub -> 16kHz WAV
  A->>A: Gatekeeper (pyannote) -- fail => short-circuit, log FAIL
  A->>A: Whisper ASR + LivenessValidator (threshold 0.80)
  A->>A: ECAPA embedding vs data/enrollments/{cnic}_baseline.pt
  A->>A: write AuditLog + AuthLog(PASS/FAIL) via _log_auth_attempt
  A-->>F: decision + scores
```

## Data model (backend/src/models.py)
```mermaid
erDiagram
  users ||--o| enrollments : "staff voiceprint"
  users ||--o{ audit_logs : "full pipeline trail"
  users ||--o{ customers : "admin_user_id (owner agent)"
  customers ||--o| customer_enrollments : "customer voiceprint"
  auth_logs }o..o| customers : "cnic (no FK; joined by normalized CNIC)"
  enterprise_apis
```
- The `users` PK is `user_id` = CNIC. The `customers` PK is `customer_id` = normalized CNIC.
- `auth_logs` drives the dashboard counters and the Logs page. `audit_logs` drives `/authenticate/sessions`.
- Schema is created by `Base.metadata.create_all` at startup, plus ad-hoc `ALTER TABLE auth_logs ADD COLUMN IF NOT EXISTS` (Postgres only). Alembic exists in `backend/alembic/`, but startup does not use it.

## External integrations
HuggingFace models via `HF_TOKEN` in `.env` (pyannote diarization, speechbrain ECAPA, OpenAI Whisper "base"). Requires PostgreSQL via `DATABASE_URL` (default `postgresql://admin:secret@localhost:5432/awaazonboard`). No other third-party APIs are called.
