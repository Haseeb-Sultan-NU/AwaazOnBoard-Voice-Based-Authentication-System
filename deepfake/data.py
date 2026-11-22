"""Frozen-set access: Drive tar -> local SSD, with integrity checks (Golden rules 1 and 5).

ensure_local_set("eval", "e2") returns (dataframe, root_dir). It
  1. checks the manifest on Drive against deepfake/splits/frozen_hashes.json (refuses if changed),
  2. copies + extracts processed/<split>_<cond>.tar to /content/work/sets/ once per session,
  3. verifies every wav's sha256 against the manifest the first time it is extracted.
"""
from __future__ import annotations

import json
import shutil
import tarfile
from pathlib import Path

from deepfake.common import DRIVE, LOCAL, REPO_ROOT, sha256_file

FROZEN = json.loads((REPO_ROOT / "deepfake" / "splits" / "frozen_hashes.json").read_text())


def manifest_path(split: str, cond: str) -> Path:
    return DRIVE / "manifests" / f"proc_{split}_{cond}.csv"


def check_manifest(split: str, cond: str) -> str:
    name = f"proc_{split}_{cond}.csv"
    p = DRIVE / "manifests" / name
    if not p.exists():
        raise FileNotFoundError(f"{p} missing: run build_eval.py (P2.2)")
    h = sha256_file(p)
    if name in FROZEN and h != FROZEN[name]:
        raise RuntimeError(f"FROZEN MANIFEST CHANGED: {name} sha256 {h[:12]} != {FROZEN[name][:12]}. "
                           "The frozen set was rebuilt or edited. Stop and tell Claude; do not score on it.")
    return h


def wav_path(root: Path, split: str, cond: str, relpath: str) -> Path:
    return root / split / cond / (relpath.rsplit(".", 1)[0] + ".wav")


def ensure_local_set(split: str, cond: str, verify: bool = True):
    import pandas as pd
    mhash = check_manifest(split, cond)
    df = pd.read_csv(manifest_path(split, cond))
    root = LOCAL / "sets"
    flag = root / f".{split}_{cond}.ok"
    if not flag.exists():
        tar = DRIVE / "processed" / f"{split}_{cond}.tar"
        if not tar.exists():
            raise FileNotFoundError(f"{tar} missing")
        tmp = LOCAL / "tmp" / tar.name
        tmp.parent.mkdir(parents=True, exist_ok=True)
        print(f"  restoring {tar.name} ({tar.stat().st_size / 1e9:.2f} GB) Drive -> local ...", flush=True)
        shutil.copyfile(tar, tmp)
        root.mkdir(parents=True, exist_ok=True)
        with tarfile.open(tmp) as tf:
            if hasattr(tarfile, "data_filter"):
                tf.extractall(root, filter="data")
            else:
                tf.extractall(root)
        tmp.unlink()
        if verify:
            bad = [r for r, h in zip(df.relpath, df.wav_sha256) if
                   not wav_path(root, split, cond, r).exists() or sha256_file(wav_path(root, split, cond, r)) != h]
            if bad:
                raise RuntimeError(f"{len(bad)} files in {split}_{cond} missing/corrupt, e.g. {bad[:3]}")
        flag.write_text(mhash)
        print(f"  {split}_{cond}: {len(df)} files verified", flush=True)
    return df, root
