"""P3.1: fetch the paper's released XLSR-SLS weights (pinned HF revision), verify sha256, store on Drive.

Only MMpaper_model.pth goes to Drive (1.36 GB). The ONNX export (parity reference) is fetched to local SSD by
parity_check.py when needed. xlsr2_300m.pt is NOT needed (the HF port builds the architecture itself).
"""
from __future__ import annotations

import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from deepfake.common import CFG, DRIVE, LOCAL, atomic_copy, ensure_dirs, is_done, log_event, mark_done, sha256_file  # noqa: E402

PT = CFG["pretrained"]


def fetch(spec: dict, dest_dir: Path) -> Path:
    """Download one pinned file to dest_dir and verify its sha256 (raises on mismatch)."""
    from huggingface_hub import hf_hub_download
    dest_dir.mkdir(parents=True, exist_ok=True)
    out = dest_dir / spec["file"]
    if out.exists() and out.stat().st_size == spec["bytes"] and sha256_file(out) == spec["sha256"]:
        return out
    print(f"downloading {spec['file']} ({spec['bytes'] / 1e9:.2f} GB) ...", flush=True)
    p = hf_hub_download(PT["hf_repo_id"], spec["file"], revision=PT["revision"], local_dir=str(dest_dir))
    p = Path(p)
    h = sha256_file(p)
    if h != spec["sha256"]:
        p.unlink(missing_ok=True)
        raise RuntimeError(f"{spec['file']}: sha256 {h[:12]} != pinned {spec['sha256'][:12]} (download corrupt or file changed upstream)")
    if p != out:
        shutil.move(str(p), out)
    return out


def main() -> None:
    ensure_dirs()
    w = PT["weights"]
    dst = DRIVE / w["drive_path"]
    if is_done("p3_download_pretrained") and dst.exists() and dst.stat().st_size == w["bytes"]:
        print("p3_download_pretrained: already done")
        return
    free = shutil.disk_usage("/content/drive/MyDrive").free
    if free < w["bytes"] * 1.2:
        sys.exit(f"Not enough Drive space ({free / 1e9:.1f} GB free) in the mounted account. Empty Trash or switch account.")
    local = fetch(w, LOCAL / "models")
    print("copying weights to Drive ...", flush=True)
    atomic_copy(local, dst)
    if sha256_file(dst) != w["sha256"]:
        dst.unlink(missing_ok=True)
        sys.exit("Drive copy failed verification; re-run this cell.")
    mark_done("p3_download_pretrained", {"file": w["file"], "sha256": w["sha256"], "revision": PT["revision"]})
    log_event("p3_download_pretrained: DONE")
    print("p3_download_pretrained: DONE (sha256 verified on Drive)")


if __name__ == "__main__":
    main()
