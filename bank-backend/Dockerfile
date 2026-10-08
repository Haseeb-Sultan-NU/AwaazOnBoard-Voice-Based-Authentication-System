# syntax=docker/dockerfile:1
# FinSecure Bank API — FastAPI + Whisper "small" (CPU) Urdu voice agent
# Fully offline at runtime: the Whisper checkpoint is baked in at build time
# (bank_main.py never downloads models itself).

FROM python:3.10-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    # bank_main.py resolves the Whisper cache as $XDG_CACHE_HOME/whisper
    XDG_CACHE_HOME=/opt/cache \
    BANK_ASR_DEVICE=cpu \
    BANK_DATABASE_URL=sqlite:////data/bank_data.db

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# CPU-only PyTorch: the default PyPI wheels bundle ~2.5 GB of CUDA libraries.
RUN pip install --no-cache-dir --upgrade pip
# --extra-index-url keeps PyPI reachable for build deps (e.g. flit_core); the +cpu pin
# guarantees the CPU wheel is chosen over the CUDA one on PyPI.
RUN pip install torch==2.1.0+cpu torchaudio==2.1.0+cpu --extra-index-url https://download.pytorch.org/whl/cpu

COPY requirements.txt .
# Install whisper without `triton` (CUDA-only kernels pulled by its Linux metadata).
RUN grep -v '^openai-whisper' requirements.txt > /tmp/requirements.txt \
 && pip install -r /tmp/requirements.txt \
 && pip install --no-deps openai-whisper==20250625 \
 && pip install tiktoken more-itertools numba tqdm

# Bake the same Whisper checkpoint the Awaaz backend uses.
RUN python -c "import whisper; whisper.load_model('small', device='cpu')"

COPY bank_main.py .

RUN mkdir -p /data \
 && useradd --create-home --uid 10001 app \
 && chown -R app:app /app /data /opt/cache
USER app

EXPOSE 8001

HEALTHCHECK --interval=30s --timeout=10s --start-period=180s --retries=5 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8001/', timeout=5)" || exit 1

CMD ["uvicorn", "bank_main:app", "--host", "0.0.0.0", "--port", "8001"]
