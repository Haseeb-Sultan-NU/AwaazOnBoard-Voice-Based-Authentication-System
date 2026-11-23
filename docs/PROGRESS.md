# Progress & Status

Snapshot: 2026-11-16, from reading the code (nothing was executed). Confidence is marked where it matters.
Update this file at the end of every piece of work.

## ✅ Looks complete / working
- **Awaaz 3-stage pipeline**: Gatekeeper → Whisper digit liveness → fine-tuned ECAPA multi-template
  (`/authenticate/verify`), with short-circuit on gatekeeper failure and structured responses.
- **Multi-template enrollment**: a clean + telephony-simulated centroid per user (`EnrollmentManager`).
- **Continuous / step-up auth** (`/authenticate/continuous`), used by the bank for every command.
- **Admin auth**: bcrypt, HttpOnly cookie session, login by CNIC or email, self-healing password hashes, seed users.
- **RBAC on read endpoints**: `/enrollments`, `/stats/enrollments`, `/dashboard/stats` and `/logs` are session-scoped.
  The dashboard counts match the tables (shared `_scoped_*` helpers).
- **Forensic logs**: `/logs` adds verdict, blocked stage, channel, raw cosine and margin. The console logs page renders them.
- **Account deletion** (`DELETE /profile`), session-based.
- **FinSecure bank**: voice login via Awaaz, Urdu ASR with anti-hallucination guards, rule-based Urdu/English
  NLU (amounts, recipients, negation), atomic ledger debits, high-value step-up confirmation, forensics modal.
- **Docker**: CPU-only images with models baked in, offline runtime, compose with healthchecks, `start.bat` for evaluators.

## ⚠️ Incomplete / mock / dead code
- `GET /enroll/status`: **mock** (always "enrolled, 0.99"), but the dashboard banner still uses it.
- `POST /api/v1/verify`: **mock** B2B endpoint (always PASS 0.92). `enterprise_apis` table: no routes (no real API keys).
- `/docs` page: placeholder.
- Legacy / unused: `POST /verify`, `GET /challenge`, `GET /authenticate/audio/{id}`, `EcapaVerifier.verify_pair`,
  `__main__` test blocks in the verification modules (they reference files that don't exist, e.g. `models/best_urdu_ecapa.pth`).
- Two functions named `get_challenge` in main.py (L336, L911). They work, but the second shadows the first.
- `alembic/`: stale migrations. README "Quick Start" tells users to run them, and its repo-structure section and clone URL are outdated.
- README claims PLDA scoring, z-norm/s-norm, 64-FBank/8 kHz features and "EER 9%". **None of the scoring
  normalization exists in this code**: it's raw cosine against a fixed threshold.
- **No tests** in the working tree (`backend/Tests/`, `test_api.py` deleted).
- Bank UI transaction history is hard-coded `SEED_TXNS` plus this session's commands. The bank ledger
  `transactions` table is never read back (there's no GET endpoint).
- Bank password login is a client-side `admin123` check with fake data (any 13-digit CNIC works).
- `LLM_HANDOFF/` is superseded by these docs (candidate for deletion; your call).

## 🐞 Suspected bugs (ranked)
> #1 and #2 (sandbox): **won't fix**, out of scope per Haseeb (2026-11-16).

1. **API-management "sandbox" isn't a sandbox** (high confidence). The UI sends `?sandbox=true` as a *query*
   param, but the backend declares `sandbox: bool = Form(False)`, so it's always False. Sandbox enroll creates real
   `Customer` ("API Sandbox Tester") rows, and sandbox verify writes real AuditLog/AuthLog rows.
   (`console/api-management/page.tsx` ~L308, L390.)
2. **A real sandbox run would destroy real voiceprints** (latent; triggers once #1 is fixed). Sandbox enroll writes
   `data/enrollments/{cnic}_baseline.pt` (overwriting a real customer's file) and then deletes it. Sandbox verify
   always `os.remove`s `{user_id}_baseline.pt`. Sandbox needs its own file path.
3. **Customer verifications never reach `audit_logs` on Postgres** (high confidence). `AuditLog.user_id` is a NOT NULL FK
   to `users`, but customers live in `customers`. The insert fails, is caught and rolled back. So
   `/authenticate/sessions` (dashboard "recent sessions") only shows staff attempts. AuthLog is unaffected.
4. **Customer enrollment ownership is spoofable**: `admin_user_id` comes from a form field / localStorage. Also, a
   non-existent `admin_user_id` → FK error → 500.
5. **Unauthenticated destructive/identity routes**: `DELETE /customers/enroll` (anyone can delete any customer),
   `GET/PUT /profile`, `PUT /profile/password`, `POST/DELETE /enroll`, `/authenticate/sessions` all trust a client-supplied id.
6. **Bank commands have no replay protection or session**: `/bank/command` needs only `cnic` + audio whose voice
   matches. A recording of the owner saying a transfer phrase could be replayed (continuous auth skips the digit
   challenge). The login result is not tied to later commands.
7. `/authenticate/verify`: `raise HTTPException(400, "template not found")` sits inside `try/except Exception`, so it
   becomes a **500**. On error paths the challenge session isn't deleted (it can be reused until success).
   `user_id` isn't CNIC-normalized for the template path (dashed CNIC → not found).
8. `EnrollmentManager` writes a shared `temp_enr_noisy.wav` in cwd, so concurrent enrollments race.
   `stitch_audio_prompt` leaks `tmp_challenge_*.wav` files.
9. `active_sessions` (challenges) never expire if abandoned, and `/dashboard/stats.active_sessions` is a global unscoped count.
10. `DELETE /profile` deletes customer DB rows but leaves their `.pt` files on disk (orphaned biometric data).
11. Bank login looks up the account only *after* Awaaz passes, so a CNIC enrolled in Awaaz but without a bank
    account burns a challenge. Minor: money stored as `Float`.
12. ASR digit-map quirk (`digit_asr.py`): `"سے"` (the common word "from") maps to zero ("sifar"); `"پی"` maps to three.

## ❓ Open questions for Haseeb
1. **Scope/deadline**: what's left before the final evaluation, and when is it? Which part will examiners focus on
   (ML results, the platform, or the bank demo)?
2. **Training & evaluation code**: where do the fine-tuning (triplet loss), telephony-simulation data prep and
   `evaluate_finetuned.py` scripts live now? (Git history mentions them; they're not in this tree.) Should they be in this repo?
3. **Metrics**: is 0.2393 the EER threshold from your evaluation, and is the README's "EER 9%" the current number?
   On which test set (Common Voice Urdu? your own Kaggle digits set?). Should README claims about PLDA / z-norm / s-norm be removed or implemented?
4. Which demo path is canonical for the evaluator: Docker (`start.bat`) or local dev?
5. Is `backend/.env` = `HF_TOKEN` + `DATABASE_URL`? (I didn't open .env files, to keep secrets out.)
6. Is the API-management sandbox meant to be a truly isolated test mode (bug #1/#2), or just a demo?
7. Should the playground remain public and write real customer rows (orphans visible only to the super admin)?
8. Are the security items (#4–#6) in scope, or is "demo-grade" security acceptable for the FYP?
9. OK to delete `LLM_HANDOFF/` and fix the README now that these docs exist?
10. Are uncommitted changes expected on this branch? (I couldn't run `git status`; the on-device shell was unavailable due to low disk space.)

## Decisions log
| Date | Decision | Why |
|---|---|---|
| (earlier) | Minimal, low-risk edits; don't modify `_scoped_*` helpers, models or write routes without asking | user preference from previous sessions (LLM_HANDOFF) |
| 2026-11-16 | Created CLAUDE.md + docs/ARCHITECTURE.md + docs/PROGRESS.md as the source of truth | onboarding |
| 2026-11-16 | Sandbox bugs #1/#2 are out of scope (ignore) | Haseeb: "we are already over that" |
| 2026-11-16 | Final phase = **deepfake / anti-spoofing defense** (not the agentic bank agent). Budget ~10–14 part-time days. Colab for training, ElevenLabs for clones | fits the security core of the FYP; agent is "just another feature" |
| 2026-11-16 | Shortlist: XLSR-SLS (primary), AASIST (light baseline/fallback), Nes2Net-X (alt). Urdu data: CSALT-LUMS Urdu deepfake dataset + own ElevenLabs clones | – |
| 2026-11-21 | **Model chosen: XLSR-SLS** (fine-tune on LUMS Urdu + channel augmentation; ElevenLabs clones as held-out test) | best open-model generalization; LUMS paper's AASIST-L/RawNet2 baselines were ~chance (EER ≈ 0.5) on Urdu, so SSL on Urdu is an open gap. Known risks: 340 M params on CPU, fixed 4.04 s window, old fairseq/torch 1.12 stack (plan: port to HF `transformers`), telephony false rejects |
| 2026-11-22 | Deepfake work tracked in `docs/DEEPFAKE_TRACKER.md`; Colab-first workflow (code in repo → Colab pulls it; Drive `MyDrive/AwaazDeepfake` = durable storage, shared across rotated free accounts); branch `feature/deepfake-defense` | free Colab timeouts + low local disk |
| 2026-11-22 | LUMS data: 7 kHz common band-limit (D8) because Tacotron clips are all 20 kHz (label leak); 99 duplicates removed; split frozen 8/4/5 | see DEEPFAKE_TRACKER §7.3, §8.5 |
| 2026-11-22 | XLSR-SLS loaded via our own HF `transformers` port (no fairseq); parity vs the published ONNX model is required; score = log-odds | version-proof, no old torch/fairseq stack; DEEPFAKE_TRACKER §4.6, §8.2 |

## Next steps
Deepfake defense: see the status board in `docs/DEEPFAKE_TRACKER.md` §2. Done: P0–P3, P5 run ft1, P6 for ft1 (EVAL EER clean 10.9 → 3.2 %, telephony 26.0 → 10.7 %, tel+Opus 33.0 → 13.0 %). Next: P4 ElevenLabs set (EVAL-EL), P7 backend integration (threshold calibrated on in-domain app recordings, not EVAL).
- [ ] Answer the open questions above, then correct these docs.
