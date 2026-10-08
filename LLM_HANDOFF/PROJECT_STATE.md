# Project State (snapshot 2026-10-05)

## Purpose
"Awaaz" — a final-year-project **telephony speaker-verification platform** for Urdu speakers. A B2B console lets agents/admins enroll customers' voices and verify callers. Verification runs in this order: (0) Pyannote diarization gatekeeper (coercion / multiple speakers) → (1) Whisper ASR liveness on a random 3-digit Urdu challenge → (2) ECAPA-TDNN (fine-tuned) cosine match against a `.pt` multi-template.
Stack: FastAPI + SQLAlchemy (PostgreSQL, in-memory SQLite fallback) backend; Next.js (App Router, TSX, Tailwind classes) frontend that proxies `/api/*` to `localhost:8000`.

## Current objective
**RBAC data scoping and anti-spoofing for console read endpoints.** Standard agents must see only the customers they enrolled and those customers' telemetry. The super admin (CNIC `0000000000000`) sees everything. The dashboard counts must match the tables exactly.

## Completed (this session, all in `backend/main.py` unless noted)
1. **Ghost row fixed.** The dashboard "Enrolled Profiles" count used an unscoped `db.query(CustomerEnrollment).count()` (= 3, global). The table used a scoped join (= 2). Both now call `_scoped_customer_enrollments(db, id)`.
   - It joins `CustomerEnrollment`↔`Customer`, filters `Customer.admin_user_id == normalized id` for non-super-admins, and returns nothing (`false()`) when there is no id.
   - Unassigned customers (`admin_user_id IS NULL`) are **no longer** visible to agents (previously they were).
2. **Telemetry scoped.** Added `_scoped_auth_logs(db, id)`. For agents it joins `AuthLog` to `Customer` on `replace(AuthLog.cnic,'-','') == Customer.customer_id` and filters by `admin_user_id`. The super admin gets all logs with no join.
   - Used for `verification_attempts`, `threats_blocked` (`status=="FAIL"`) and `GET /logs` + `/api/logs`.
3. **Anti-spoofing.** `GET /enrollments`, `GET /stats/enrollments`, `GET /dashboard/stats`, `GET /logs`/`/api/logs` now take `current_user: dict = Depends(get_current_user)` and use `current_user["cnic"]`.
   - `user_id` stays in the signatures (to avoid 422s) but is **ignored**.
   - No valid session cookie → 401.
4. Frontend (earlier steps):
   - `frontend/src/app/console/page.tsx` sends `?user_id=` to `/api/dashboard/stats`.
   - `frontend/src/app/console/logs/page.tsx` reads `awaaz_user` from localStorage and sends `?user_id=` to `/api/logs`.
   - `frontend/src/app/console/enrollment/page.tsx` search filter made null-safe (`(p.user_id ?? "")`).
   - These params are now harmless (ignored by the backend).

## Recent changes (working tree, uncommitted)
`git status` shows modifications to `backend/main.py`, `backend/src/models.py`, several console pages, `Navbar.tsx`, login/signup/playground/settings pages, plus an untracked `frontend/src/app/console/authenticate/`.
Many files are deleted in the working tree but still tracked: `backend/Tests/*`, `backend/test_api.py`, `backend/src/audio/*` (except `simulator.py`), `backend/src/legacy/*`, `frontend/src/lib/api.ts`, `frontend/public/*.svg`.
Not all of these changes come from this session; don't assume who made them.

## Broken / unresolved (verified by reading code)
- **`GET /authenticate/sessions`** (`main.py` ~L1106–1140) still trusts the spoofable `?user_id=` query param. It is used by the dashboard "recent sessions" (`console/page.tsx` L74). This is the **next candidate** for the same `Depends(get_current_user)` treatment.
- **`active_sessions`** in `/dashboard/stats` = `len(active_sessions)`. This is a global in-memory challenge-session count and is unscoped.
- **Write path ownership is spoofable.** `POST /customers/enroll` takes `admin_user_id` as a form field. `console/enrollment/page.tsx` (~L239–260) fills it from localStorage, so a client can enroll customers under another agent. Not yet fixed; the user forbade touching write routes in the last step.
- `GET /profile`, `PUT /profile`, `PUT /profile/password`, `DELETE /enroll`, `DELETE /customers/enroll` take identity from params/body (not session). Not audited for RBAC.
- `GET /enroll/status` is a **mock** endpoint (`get_mock_enrollment`, ~L1332).
- Sessions live in the in-memory dict `active_auth_sessions`. Every `uvicorn --reload` restart logs everyone out → the secured endpoints return 401 until the user logs in again.
- The frontend has no 401 handling and no route guard. The console layout only reads localStorage.
- `/signup` and `/login` return 503 when the DB fell back to SQLite. So on SQLite no one can log in, and the secured endpoints are unusable.

## Constraints / decisions (from the user)
- Minimal, zero-risk edits. In the last step the user said: do not modify the `_scoped_*` helpers, the DB models, insert/update/delete routes, or Next.js frontend files.
- Do not write or run tests unless asked.
- Super admin is identified by `SUPER_ADMIN_CNIC = "0000000000000"` (main.py ~L1097). CNICs are normalized by stripping dashes/spaces (`_normalize_cnic`).
- Seeded users on an empty DB: `0000000000000`/`admin123` (admin) and `1111111111111`/`demo123`.

## Exact continuation point
`backend/main.py`, the read-endpoint block ~L1097–1290: `_normalize_cnic` / `_is_super_admin` → `/authenticate/sessions` → `_scoped_customer_enrollments` → `/enrollments` → `/stats/enrollments` → `_scoped_auth_logs` → `/dashboard/stats` → `/logs`.

## Immediate next steps (proposals; confirm with user)
1. Secure `GET /authenticate/sessions` with `Depends(get_current_user)` (same pattern as the others).
2. If the user permits write-route changes: derive `admin_user_id` in `POST /customers/enroll` from the session instead of the form field.
3. Optionally scope or remove the `active_sessions` count.
4. Optionally add 401 → redirect-to-`/login` handling in the console pages.

## Tests / commands actually run
- None. The user explicitly said not to run tests. The only commands run were read-only (`git ls-files`, `git status`, `git log`, line counts, `Select-String`).
- Dev servers were already running at the user's end: `npm run dev` (frontend) and `uvicorn main:app --reload --port 8000` (backend). There was no verification of runtime behavior after the edits.

## Known failed approaches
None recorded. Note the root cause found: the "missing" table row was **not** a frontend `.map()`/key bug (the keys are unique `${type}-${user_id}`). It was a count/query mismatch.
