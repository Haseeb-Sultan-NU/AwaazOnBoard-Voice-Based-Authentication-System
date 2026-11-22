"""Called by the notebook's MASTER SEQUENCE cell on every new session / account.

Idempotent. It:
  1. checks Drive is mounted and the shared project folder is reachable,
  2. creates the Drive + local folder layout,
  3. reports GPU, local disk and Drive quota of the *current* account,
  4. restores the local fast cache: copies archives from Drive to /content/work and extracts them
     (only for steps that are already done),
  5. prints a status board of which pipeline steps are finished.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tarfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from deepfake.common import CFG, DRIVE, LOCAL, ensure_dirs, is_done, log_event, read_marker  # noqa: E402

# Ordered list of pipeline steps (marker names). Keep in sync with docs/DEEPFAKE_TRACKER.md.
STEPS = [
    ("p1_download_lums", "P1  LUMS Urdu dataset archived on Drive"),
    ("p1_inventory_lums", "P1  Inventory + full manifest written"),
    ("p2_split_frozen", "P2  Speaker split frozen (train/dev/eval)"),
    ("p2_eval_built", "P2  Frozen eval set built (E1/E2/E3)"),
    ("p3_download_pretrained", "P3  Pretrained weights on Drive (sha256 verified)"),
    ("p3_model_ready", "P3  HF port parity-checked vs ONNX reference"),
    ("p3_baseline_eval", "P3  Baseline (zero-shot) eval done"),
    ("p5_train_ft1", "P5  Fine-tuning run ft1 finished"),
]


def gb(n: float) -> str:
    return f"{n / 1e9:.1f} GB"


def check_drive(init: bool) -> None:
    if not Path("/content/drive/MyDrive").exists():
        sys.exit("Drive is not mounted. Run the MASTER SEQUENCE cell from the top.")
    if not DRIVE.exists():
        if init:
            DRIVE.mkdir(parents=True)
            print(f"Created project folder {DRIVE}. Now share it (Editor) with your other Colab accounts.")
            return
        sys.exit(
            f"Project folder not found: {DRIVE}\n"
            "-> HOME account, first time ever: run the one-time 'INIT DRIVE' cell.\n"
            "-> Other accounts: open the shared 'AwaazDeepfake' folder in Drive web, "
            "right-click > Organize > Add shortcut > My Drive (keep the name AwaazDeepfake), then re-run."
        )


def report_resources() -> None:
    try:
        gpu = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"],
            capture_output=True, text=True, check=True,
        ).stdout.strip()
    except Exception:
        gpu = "NONE (Runtime > Change runtime type > T4 GPU)"
    local = shutil.disk_usage("/content")
    drv = shutil.disk_usage("/content/drive/MyDrive")
    print(f"GPU            : {gpu}")
    print(f"Local disk free: {gb(local.free)}")
    print(f"Drive free     : {gb(drv.free)}  (quota of the account mounted right now)")
    log_event(f"session_start gpu={gpu!r} drive_free={gb(drv.free)}")


def restore_cache() -> None:
    """Copy finished archives Drive -> local SSD and extract (skip if already extracted)."""
    lums = CFG["datasets"]["lums"]
    if is_done("p1_download_lums"):
        archive = DRIVE / lums["drive_archive"]
        target = LOCAL / lums["local_extract_dir"]
        flag = target / ".extracted"
        if flag.exists():
            print(f"LUMS raw       : already extracted at {target}")
        else:
            local_tar = LOCAL / "tmp" / archive.name
            print(f"LUMS raw       : copying {archive.name} from Drive -> local ...")
            shutil.copyfile(archive, local_tar)
            target.mkdir(parents=True, exist_ok=True)
            with tarfile.open(local_tar) as tf:
                if hasattr(tarfile, "data_filter"):
                    tf.extractall(target, filter="data")  # safe extraction (Python >= 3.12)
                else:
                    tf.extractall(target)
            local_tar.unlink()
            flag.touch()
            print(f"LUMS raw       : extracted to {target}")
    # Later phases add their archives here (processed eval set, pretrained weights).


def status_board() -> None:
    print("\n=== PIPELINE STATUS ===")
    for name, label in STEPS:
        m = read_marker(name)
        print(f"[{'x' if m else ' '}] {label}" + (f"   ({m['finished_utc']})" if m else ""))
    print("=======================\n")


def main() -> None:
    check_drive(init="--init" in sys.argv)
    ensure_dirs()
    report_resources()
    restore_cache()
    status_board()


if __name__ == "__main__":
    main()
