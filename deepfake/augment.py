"""On-the-fly training augmentation (D4). Applied with the SAME probabilities to bona fide and spoof clips:
the augmenter never sees the label, so "sounds like a phone" cannot become a cue for "fake".

Chain (realistic order): [coloured noise] -> [impulses] -> [telephony channel] -> [Opus codec] -> random peak gain.
Every random choice comes from the per-sample `rng` (seeded from base seed + epoch + index), so a resumed run
produces exactly the same augmentations, independent of DataLoader worker timing.
"""
from __future__ import annotations

import subprocess
from math import gcd

import numpy as np

SR = 16000


def _resample(x, src, dst):
    from scipy.signal import resample_poly
    if src == dst:
        return x
    g = gcd(src, dst)
    return resample_poly(x, dst // g, src // g).astype(np.float32)


def _add_noise(x, rng, snr_db, colour=True):
    from scipy.signal import butter, sosfilt
    n = rng.standard_normal(len(x)).astype(np.float32)
    if colour:
        kind = rng.choice(["low", "high", "white"])
        if kind != "white":
            cut = float(rng.uniform(500, 4000)) if kind == "low" else float(rng.uniform(100, 2000))
            n = sosfilt(butter(1, cut, btype=kind, fs=SR, output="sos"), n).astype(np.float32)
    ps = float(np.mean(x ** 2)) + 1e-10
    pn = float(np.mean(n ** 2)) + 1e-10
    return x + n * np.sqrt(ps / (pn * 10 ** (snr_db / 10)))


def _impulses(x, rng):
    y = x.copy()
    k = int(len(x) * rng.uniform(0.001, 0.01))
    idx = rng.integers(0, len(x), k)
    y[idx] += (rng.uniform(-1, 1, k) * np.max(np.abs(x)) * rng.uniform(0.1, 0.5)).astype(np.float32)
    return y


def _telephony(x, rng, a):
    from scipy.signal import butter, sosfilt
    y = _resample(x, SR, 8000)
    y = sosfilt(butter(2, float(rng.uniform(*a["tel_hp_hz"])), btype="high", fs=8000, output="sos"), y)
    y = sosfilt(butter(2, float(rng.uniform(*a["tel_lp_hz"])), btype="low", fs=8000, output="sos"), y).astype(np.float32)
    y = _add_noise(y, rng, float(rng.uniform(*a["tel_snr_db"])), colour=False)
    return _resample(y.astype(np.float32), 8000, SR)


def _opus(x, kbps: int):
    """Round trip through libopus with pipes (no temp files). Raises on failure (caller skips the op)."""
    enc = subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-f", "f32le", "-ar", str(SR), "-ac", "1",
                          "-i", "pipe:0", "-c:a", "libopus", "-b:a", f"{kbps}k", "-f", "ogg", "pipe:1"],
                         input=np.ascontiguousarray(x, np.float32).tobytes(), capture_output=True, check=True, timeout=30)
    dec = subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-i", "pipe:0", "-f", "f32le", "-ar", str(SR),
                          "-ac", "1", "pipe:1"], input=enc.stdout, capture_output=True, check=True, timeout=30)
    y = np.frombuffer(dec.stdout, dtype=np.float32).copy()
    if len(y) < len(x) // 2:
        raise RuntimeError("opus output too short")
    return y


def augment(x: np.ndarray, rng: np.random.Generator, a: dict) -> tuple[np.ndarray, list[str]]:
    """Returns (augmented clip, list of applied ops). Output length may differ slightly (codec); caller re-windows."""
    ops = []
    if rng.random() < a["p_noise"]:
        x = _add_noise(x, rng, float(rng.uniform(*a["noise_snr_db"])))
        ops.append("noise")
    if rng.random() < a["p_impulse"]:
        x = _impulses(x, rng)
        ops.append("impulse")
    if rng.random() < a["p_telephony"]:
        x = _telephony(x, rng, a)
        ops.append("tel")
    if rng.random() < a["p_opus"]:
        kbps = int(rng.choice(a["opus_kbps"]))
        try:
            x = _opus(x, kbps)
            ops.append(f"opus{kbps}")
        except Exception:  # noqa: BLE001  (never let one codec hiccup kill training)
            ops.append("opus_failed")
    m = float(np.max(np.abs(x))) if len(x) else 0.0
    if m > 1e-6:
        x = x * (float(rng.uniform(*a["peak"])) / m)
    return np.clip(x, -1, 1).astype(np.float32), ops
