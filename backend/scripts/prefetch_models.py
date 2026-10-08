"""Bake every model the Awaaz backend loads into the Docker image (build time only).

Runs during `docker build` so a pulled image starts with no network access:
  1. Whisper "small"                       -> $XDG_CACHE_HOME/whisper/small.pt
  2. SpeechBrain ECAPA (spkrec-ecapa-voxceleb) -> HF cache + models/pretrained/ (savedir used by EcapaVerifier)
  3. pyannote speaker-diarization-3.1      -> HF cache (gated: needs HF_TOKEN, passed as a BuildKit secret)

The token is read from the environment for this one RUN step only and is never
written into an image layer.
"""

import os
import sys

WHISPER_MODEL = "small"  # keep in sync with backend/main.py and bank-backend WHISPER_MODEL_SIZE
ECAPA_SOURCE = "speechbrain/spkrec-ecapa-voxceleb"
ECAPA_SAVEDIR = f"models/pretrained/{ECAPA_SOURCE.split('/')[-1]}"  # matches src/verification/ecapa_engine.py
DIARIZATION = "pyannote/speaker-diarization-3.1"  # matches src/verification/gatekeeper.py


def main() -> int:
    token = os.environ.get("HF_TOKEN", "").strip()
    if not token:
        print("ERROR: HF_TOKEN build secret is missing; pyannote models are gated.", file=sys.stderr)
        return 1

    print(f"[prefetch] Whisper '{WHISPER_MODEL}'")
    import whisper
    whisper.load_model(WHISPER_MODEL, device="cpu")

    print(f"[prefetch] SpeechBrain {ECAPA_SOURCE} -> {ECAPA_SAVEDIR}")
    try:
        from speechbrain.inference.speaker import SpeakerRecognition
    except ImportError:
        from speechbrain.pretrained import SpeakerRecognition
    SpeakerRecognition.from_hparams(source=ECAPA_SOURCE, savedir=ECAPA_SAVEDIR)

    print(f"[prefetch] pyannote {DIARIZATION}")
    from pyannote.audio import Pipeline
    if Pipeline.from_pretrained(DIARIZATION, use_auth_token=token) is None:
        print("ERROR: pyannote returned no pipeline. Accept the model terms on huggingface.co for "
              "pyannote/speaker-diarization-3.1 and pyannote/segmentation-3.0.", file=sys.stderr)
        return 1

    print("[prefetch] all models cached")
    return 0


if __name__ == "__main__":
    sys.exit(main())
