# Real-Time Speaker Verification System (ECAPA-TDNN)

![PyTorch](https://img.shields.io/badge/PyTorch-EE4C2C?style=for-the-badge&logo=pytorch&logoColor=white)
![Python](https://img.shields.io/badge/Python-3776AB?style=for-the-badge&logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-009688?style=for-the-badge&logo=fastapi&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white)
![Status](https://img.shields.io/badge/status-active-success?style=for-the-badge)

A production-oriented audio biometric authentication system delivering **low-latency speaker verification**, **liveness detection**, and **cross-channel robustness** — fine-tuned on Urdu speech and deployed via FastAPI for real-time web and mobile use.

---

## 📊 Performance

| Metric | Value |
|:---|:---|
| **Equal Error Rate (EER)** | 9% |
| **Inference Latency** | Sub-second |
| **Robustness** | Cross-channel stable (telephony ↔ microphone) |

---

## 🔧 System Specifications

| Component | Details |
|:---|:---|
| **Model** | ECAPA-TDNN |
| **Embedding Size** | 192-dim |
| **Input Features** | Mel-Spectrogram (64 FBanks, 25ms window, 8kHz) |
| **Scoring** | Cosine Similarity / PLDA |
| **Normalization** | z-norm / s-norm |
| **Dataset** | Mozilla Common Voice (Urdu) + VoxCeleb subsets |
| **Deployment Target** | Real-time Web / Mobile (FastAPI) |

---

## 🏗️ Verification Pipeline

```
Audio Input (.wav)
      │
      ▼
Preprocessing
(Resampling → 8kHz, Framing, Mel-Spectrogram extraction)
      │
      ▼
Embedding Extraction
(ECAPA-TDNN → 192-dim speaker embedding)
      │
      ▼
Similarity Scoring
(Cosine Similarity / PLDA)
      │
      ▼
Score Normalization
(z-norm / s-norm — cross-device stabilization)
      │
      ▼
Decision Thresholding
(FAR / FRR trade-off tuning)
      │
      ▼
Liveness Verification Layer
(Challenge-response — replay & spoofing prevention)
      │
      ▼
OUTPUT: Verified / Rejected
```

---

## 🚀 Core Components

**1. Data Pipeline**
Audio resampled to 8kHz with structured Mel-spectrogram extraction (64 filter banks, 25ms window) ensuring consistent feature representation across devices and recording conditions.

**2. Embedding Model — ECAPA-TDNN**
Fine-tuned on Mozilla Common Voice (Urdu) + VoxCeleb subsets for:
- Channel variability robustness
- Noise-resilient speaker discrimination
- Improved Urdu phoneme recognition

**3. Scoring & Calibration**
Cosine similarity scoring with z-norm and s-norm normalization stabilizes decision thresholds across microphone types, telephony channels, and acoustic environments.

**4. Liveness Detection**
Dynamic challenge-response prompts prevent replay attacks and pre-recorded spoofing, adding a behavioural verification layer on top of biometric matching.

**5. Inference Layer**
FastAPI-based deployment supporting low-latency, concurrent verification requests with Docker containerization for portable production deployment.

---

## 🔬 Experimental Focus

- Cross-channel verification: telephony (8kHz) vs. microphone recordings
- Impact of z-norm vs. s-norm on EER reduction
- FAR/FRR trade-off tuning across decision thresholds
- Embedding stability analysis under varying SNR conditions

---

## 🛠️ Tech Stack

| Layer | Tools |
|-------|-------|
| **Modeling** | PyTorch, ECAPA-TDNN, pyannote.audio |
| **Data Processing** | Librosa, NumPy, Pandas |
| **Deployment** | FastAPI, Docker |

---

## 📂 Repository Structure

```
real-time-speaker-verification-ecapa/
├── data/
├── models/
├── inference/
│   └── run_inference.py
├── evaluation/
├── utils/
├── scripts/
└── README.md
```

---

## Quick Start

This system is built with a decoupled architecture. You will need to run the FastAPI machine learning backend and the Next.js enterprise frontend simultaneously.

### Prerequisites
* **Python 3.9+** (For the PyTorch/FastAPI backend)
* **Node.js 18+** (For the Next.js 15 frontend)
* **PostgreSQL** (Ensure your database connection string is set up in your backend `.env` file)

### 1. Clone the Repository
```bash
git clone [https://github.com/Haseeb-Sultan-NU/real-time-speaker-verification-ecapa.git](https://github.com/Haseeb-Sultan-NU/real-time-speaker-verification-ecapa.git)
cd real-time-speaker-verification-ecapa
```

### 2. Start the AI Backend (FastAPI)

Open your terminal, navigate to the `backend` directory, and initialize the pipeline. 

```bash
cd backend

# Create a virtual environment
python -m venv venv

# Activate the virtual environment (Windows / Git Bash)
source venv/Scripts/activate  
# Or activate (Mac / Linux)
# source venv/bin/activate

# Install the required Python packages
pip install -r requirements.txt

# Run database migrations to set up the enterprise schema
alembic upgrade head

# Start the FastAPI server
uvicorn main:app --reload --port 8000
```

---

## 🗺️ Roadmap

- [ ] Real-time streaming inference
- [ ] Edge / mobile deployment optimization
- [ ] Advanced anti-spoofing (deepfake audio detection)
- [ ] Batch inference optimization (GPU)
