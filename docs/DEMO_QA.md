# Demo Q&A (deepfake detector)

Questions an examiner may ask, with answers backed by our logged results (`docs/DEEPFAKE_TRACKER.md` §11).
Add new entries at the bottom.

---

## Q1. Does the fine-tuned model work on both old narrowband phone audio (2G/2.5G) and clean modern phone audio?
*Asked 2026-11-27.*

**Short answer:** yes for both. It works best on modern wideband/clean audio and well, but less well, on
narrowband phone audio.

| Kind of call | Closest test condition we ran | Error (EER) before → after fine-tuning |
|---|---|---|
| Modern phone / HD Voice / VoLTE / app call (wideband, up to ~7 kHz) | **E1** clean, band-limited to 7 kHz | 10.9 % → **3.2 %** |
| Old 2G/2.5G / landline (narrowband, 300–3400 Hz, 8 kHz) | **E2** telephony: 8 kHz, 300–3400 Hz band-pass, noise at 15 dB SNR | 26.0 % → **10.7 %** |
| Narrowband + compressed browser/VoIP stream | **E3** = E2 + Opus 16 kbps | 33.0 % → **13.0 %** |

Why narrowband is harder: the 2G band throws away everything above 3.4 kHz, which is where many synthesis
artefacts live, so the detector has less evidence. Fine-tuning with phone-line and codec augmentation cut the
narrowband error by about 60 %, and the gap between clean and narrowband shrank from 22 points to about 10.

**Honest limits (say these if asked):**
- E2/E3 are *simulated* phone channels (band-pass + noise, Opus). We did **not** simulate the real 2G voice codecs
  (GSM-FR / AMR-NB) or the VoLTE codec (AMR-WB/EVS). Real 2.5G calls also have codec artefacts and packet loss, so
  expect real-call error at or above the E2 number.
- The simulated channels resemble the training augmentation, so they are partly "seen" conditions. The
  independent real-world check is a set of clones recorded through the app (EVAL-EL, not yet built).
- At one fixed threshold, narrowband audio makes real voices score lower (more genuine users rejected), so the
  production threshold must be calibrated on the real call/app channel.
- Possible extension: add an extra eval condition with a real AMR-NB codec round trip (as a new, separately named set,
  never by changing the frozen sets).
