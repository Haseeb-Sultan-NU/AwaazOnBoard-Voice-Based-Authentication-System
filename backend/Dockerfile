# syntax=docker/dockerfile:1
# Awaaz Identity Provider — FastAPI + PyTorch (CPU) + Whisper + pyannote + SpeechBrain ECAPA
#
# Build (via compose):  HF_TOKEN=hf_xxx docker compose build awaaz-backend
# The image is fully offline: every model is downloaded at build time.

FROM python:3.10-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    # One cache root for Whisper ($XDG_CACHE_HOME/whisper) and Hugging Face, readable by the app user
    XDG_CACHE_HOME=/opt/cache \
    HF_HOME=/opt/cache/huggingface

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg libsndfile1 gcc build-essential \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# CPU-only PyTorch: the default PyPI wheels bundle ~2.5 GB of CUDA libraries.
RUN pip install --no-cache-dir --upgrade pip
# --extra-index-url keeps PyPI reachable for build deps (e.g. flit_core); the +cpu pin
# guarantees the CPU wheel is chosen over the CUDA one on PyPI.
RUN pip install torch==2.1.0+cpu torchaudio==2.1.0+cpu --extra-index-url https://download.pytorch.org/whl/cpu

COPY requirements.txt .
# openai-whisper's Linux metadata also pulls `triton` (CUDA kernels, several hundred MB),
# which a CPU image never uses, so whisper is installed without it.
RUN grep -v '^openai-whisper' requirements.txt > /tmp/requirements.txt \
 && pip install -r /tmp/requirements.txt \
 && pip install --no-deps openai-whisper==20250625 \
 && pip install tiktoken more-itertools numba tqdm

# Bake all models into the image (needs network + HF_TOKEN at build time only).
COPY scripts/prefetch_models.py scripts/prefetch_models.py
RUN --mount=type=secret,id=hf_token,required=true \
    HF_TOKEN="$(cat /run/secrets/hf_token)" python scripts/prefetch_models.py

# From here on, never touch the network for models.
ENV HF_HUB_OFFLINE=1

COPY . .

RUN mkdir -p data/temp data/enrollments \
 && useradd --create-home --uid 10001 app \
 && chown -R app:app /app /opt/cache
USER app

EXPOSE 8000

# Model loading on CPU takes a while on first start.
HEALTHCHECK --interval=30s --timeout=10s --start-period=300s --retries=5 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health', timeout=5)" || exit 1

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
