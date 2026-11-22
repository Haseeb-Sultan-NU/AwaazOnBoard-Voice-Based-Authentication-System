"""P1 step 1: download the CSALT-LUMS Urdu deepfake dataset ONCE and archive it on Drive.

Flow (fast + timeout-safe):
  HF Hub -> /content/work/raw/lums (local SSD, many small files)
         -> one uncompressed .tar on local SSD -> sha256
         -> atomic copy to Drive: <drive>/raw/lums_urdu.tar (+ .sha256)
         -> verify the Drive copy -> write marker state/p1_download_lums.done
If Colab dies midway, nothing on Drive looks finished, so just re-run. Once the marker exists this is a no-op.

Usage (Colab):  !python /content/repo/deepfake/scripts/download_lums.py
Optional: Colab secret HF_TOKEN (the dataset is public; a token only avoids anonymous rate limits).
"""
from __future__ import annotations

import os
import shutil
import sys
import tarfile
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from deepfake.common import (  # noqa: E402
    CFG, DRIVE, LOCAL, atomic_copy, ensure_dirs, is_done, log_event, mark_done, sha256_file,
)

AUDIO_EXT = {".wav", ".flac", ".mp3", ".ogg", ".m4a"}


def main() -> None:
    ensure_dirs()
    if is_done("p1_download_lums"):
        print("Already done (marker exists). Nothing to do.")
        return

    from huggingface_hub import snapshot_download

    lums = CFG["datasets"]["lums"]
    extract_dir = LOCAL / lums["local_extract_dir"]
    if extract_dir.exists():
        shutil.rmtree(extract_dir)  # stale partial download from a dead session
    log_event("p1_download_lums: downloading from HF ...")
    snapshot_download(
        repo_id=lums["hf_repo_id"],
        repo_type=lums["hf_repo_type"],
        local_dir=str(extract_dir),
        max_workers=8,
        token=os.environ.get("HF_TOKEN") or None,
    )
    shutil.rmtree(extract_dir / ".cache", ignore_errors=True)

    # --- sanity check counts against what the HF page reported ---
    counts = Counter()
    for p in extract_dir.rglob("*"):
        if p.is_file() and p.suffix.lower() in AUDIO_EXT:
            counts[p.relative_to(extract_dir).parts[0]] += 1
    print("Audio files per top folder:", dict(counts))
    total = sum(counts.values())
    if total == 0:
        sys.exit("No audio files found - check the download.")
    for k, v in lums["expected_files"].items():
        if counts.get(k, 0) != v:
            print(f"WARNING: {k}: expected {v}, got {counts.get(k, 0)} (dataset may have been updated; note it in the tracker)")

    # --- archive -> Drive ---
    local_tar = LOCAL / "tmp" / Path(lums["drive_archive"]).name
    log_event(f"p1_download_lums: building tar of {total} files ...")
    with tarfile.open(local_tar, "w") as tf:
        for p in sorted(extract_dir.rglob("*")):
            if p.is_file():
                tf.add(p, arcname=str(p.relative_to(extract_dir)))
    digest = sha256_file(local_tar)
    size = local_tar.stat().st_size
    drive_tar = DRIVE / lums["drive_archive"]
    log_event(f"p1_download_lums: copying {size/1e9:.2f} GB to Drive ...")
    atomic_copy(local_tar, drive_tar)
    (drive_tar.with_name(drive_tar.name + ".sha256")).write_text(f"{digest}  {drive_tar.name}\n")

    # verify Drive copy (size + hash)
    if drive_tar.stat().st_size != size or sha256_file(drive_tar) != digest:
        sys.exit("Drive copy verification FAILED - re-run this cell.")
    local_tar.unlink()
    (extract_dir / ".extracted").touch()  # local copy is already usable this session

    mark_done("p1_download_lums", {"files": total, "per_folder": dict(counts), "bytes": size, "sha256": digest})
    log_event(f"p1_download_lums: DONE ({total} files, sha256 {digest[:12]}...)")


if __name__ == "__main__":
    main()
