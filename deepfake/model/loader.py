"""Model loading + reproducibility settings + per-run self-check (guards against library drift)."""
from __future__ import annotations

import shutil
from pathlib import Path

import numpy as np
import torch

from deepfake.common import CFG, DRIVE, LOCAL, sha256_file
from deepfake.model.xlsr_sls import XLSRSLS, load_pretrained

PT = CFG["pretrained"]


def set_exact_math():
    """fp32 everywhere, no TF32 (A100/T4 would otherwise change scores in the 3rd decimal), deterministic cudnn."""
    torch.backends.cuda.matmul.allow_tf32 = False
    torch.backends.cudnn.allow_tf32 = False
    torch.backends.cudnn.benchmark = False
    torch.backends.cudnn.deterministic = True
    try:
        torch.set_float32_matmul_precision("highest")
    except Exception:  # noqa: BLE001
        pass


def device(allow_cpu: bool = False) -> torch.device:
    if torch.cuda.is_available():
        return torch.device("cuda")
    if not allow_cpu:
        raise SystemExit("No GPU. Runtime > Change runtime type > T4 GPU, then run MASTER SEQUENCE again. "
                         "(Scoring on CPU would take ~8 h.)")
    return torch.device("cpu")


def pretrained_local() -> Path:
    """Copy the pinned weights Drive -> local SSD once per session (faster load, avoids FUSE hiccups)."""
    w = PT["weights"]
    src = DRIVE / w["drive_path"]
    dst = LOCAL / "models" / w["file"]
    if not src.exists():
        raise SystemExit("Pretrained weights missing on Drive: run P3.1 (download_pretrained.py) first.")
    if not (dst.exists() and dst.stat().st_size == w["bytes"]):
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dst)
        if sha256_file(dst) != w["sha256"]:
            dst.unlink()
            raise RuntimeError("local copy of pretrained weights failed sha256; re-run")
    return dst


def get_model(ckpt: str = "pretrained", dev: torch.device | None = None) -> tuple[XLSRSLS, dict]:
    path = pretrained_local() if ckpt == "pretrained" else Path(ckpt)
    model = XLSRSLS()
    rep = load_pretrained(model, path, strict=True)
    rep["ckpt"] = str(path) if ckpt != "pretrained" else f"pretrained:{PT['weights']['sha256'][:12]}"
    model.eval()
    if dev is not None:
        model.to(dev)
    return model, rep


@torch.inference_mode()
def logprobs(model, windows: np.ndarray, dev, batch: int = 8) -> np.ndarray:
    out = []
    for i in range(0, len(windows), batch):
        x = torch.from_numpy(np.ascontiguousarray(windows[i:i + batch], dtype=np.float32)).to(dev)
        out.append(model(x).float().cpu().numpy())
    return np.concatenate(out)


def self_check(model, dev, tol: float | None = None) -> float:
    """Re-score the stored parity windows; refuse to continue if the port drifted (e.g. Colab upgraded transformers).
    Only valid for the PRETRAINED weights (fine-tuned checkpoints legitimately give different scores)."""
    tol = tol or PT["selfcheck_tolerance"]
    p = DRIVE / PT["parity_ref_drive_path"]
    if not p.exists():
        raise SystemExit("parity_ref.npz missing: run P3.2 (parity_check.py) first.")
    ref = np.load(p)
    d = float(np.abs(logprobs(model, ref["X"], dev) - ref["ref"]).max())
    if d > tol:
        raise SystemExit(f"SELF-CHECK FAILED: max |Δlogprob| = {d:.2e} > {tol}. The model port no longer matches "
                         "the reference (library version change?). Stop and tell Claude.")
    print(f"self-check ok (max |Δlogprob| = {d:.1e})")
    return d
