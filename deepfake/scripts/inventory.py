"""P1 step 2: inventory the LUMS dataset and write the full manifest.

Reads the local extracted copy (/content/work/raw/lums), never Drive directly.
Writes (atomically) to Drive:
  manifests/lums_all.csv          one row per audio file (path, label, attack, speaker, sr, duration, sha256 ...)
  manifests/lums_inventory.json   summary used to decide the speaker split (P2)
Prints a summary you paste back to Claude to freeze the split.

F0 column = median pitch of a few bona fide clips per speaker. It is ONLY a gender hint
(< ~165 Hz usually male) so the eval split can contain both genders; it is not used for training.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from deepfake.common import (  # noqa: E402
    CFG, DRIVE, LOCAL, atomic_copy, atomic_write_json, ensure_dirs, is_done, log_event, mark_done, sha256_file,
)

AUDIO_EXT = {".wav", ".flac", ".mp3", ".ogg", ".m4a"}
SPK_RE = re.compile(r"(?i)speaker[_\- ]?(\d+)")


def main() -> None:
    import numpy as np
    import pandas as pd
    import soundfile as sf
    from tqdm import tqdm

    ensure_dirs()
    if not is_done("p1_download_lums"):
        sys.exit("Run download_lums.py first.")
    lums = CFG["datasets"]["lums"]
    root = LOCAL / lums["local_extract_dir"]
    if not (root / ".extracted").exists():
        sys.exit(f"Local copy missing at {root}. Run the MASTER SEQUENCE cell (it restores it).")

    rows = []
    files = sorted(p for p in root.rglob("*") if p.is_file() and p.suffix.lower() in AUDIO_EXT)
    for p in tqdm(files, desc="inventory"):
        rel = p.relative_to(root)
        top = rel.parts[0]
        m = next((SPK_RE.search(part) for part in rel.parts if SPK_RE.search(part)), None)
        row = {
            "relpath": str(rel).replace("\\", "/"),
            "source": "lums",
            "folder": top,
            "label": lums["label_map"].get(top, "UNKNOWN"),
            "attack": lums["attack_map"].get(top, "UNKNOWN"),
            "speaker": f"S{int(m.group(1)):02d}" if m else "unknown",
            "bytes": p.stat().st_size,
            "sha256": sha256_file(p),
        }
        try:
            info = sf.info(str(p))
            row.update(sr=info.samplerate, channels=info.channels, frames=info.frames,
                       duration_s=round(info.frames / info.samplerate, 3), subtype=info.subtype, error="")
        except Exception as e:  # unreadable file -> keep a row so we notice it
            row.update(sr=0, channels=0, frames=0, duration_s=0.0, subtype="", error=str(e)[:200])
        rows.append(row)
    df = pd.DataFrame(rows)

    # --- per-speaker pitch hint (5 bona fide clips each) ---
    import librosa
    f0 = {}
    for spk, g in df[(df.label == "bonafide") & (df.error == "")].groupby("speaker"):
        vals = []
        for rel in g.relpath.head(5):
            y, sr = librosa.load(str(root / rel), sr=16000, mono=True, duration=8.0)
            f = librosa.yin(y, fmin=60, fmax=400, sr=sr)
            vals.append(float(np.median(f)))
        f0[spk] = round(float(np.median(vals)), 1) if vals else None

    # --- summaries ---
    by_spk = (df.groupby(["speaker", "label", "attack"])
                .agg(files=("relpath", "count"), minutes=("duration_s", lambda s: round(s.sum() / 60, 1)))
                .reset_index())
    summary = {
        "total_files": int(len(df)),
        "unreadable": int((df.error != "").sum()),
        "per_folder": df.folder.value_counts().to_dict(),
        "sample_rates": {str(k): int(v) for k, v in df.sr.value_counts().items()},
        "channels": {str(k): int(v) for k, v in df.channels.value_counts().items()},
        "subtypes": df.subtype.value_counts().to_dict(),
        "duration_s": {q: round(float(df.duration_s.quantile(x)), 2)
                       for q, x in [("min", 0), ("p05", .05), ("median", .5), ("p95", .95), ("max", 1)]},
        "clips_shorter_than_window": int((df.duration_s < CFG["audio"]["window_seconds"]).sum()),
        "speakers": sorted(df.speaker.unique().tolist()),
        "f0_median_hz_hint": f0,
        "per_speaker": by_spk.to_dict(orient="records"),
    }

    tmp = LOCAL / "tmp" / "lums_all.csv"
    df.to_csv(tmp, index=False)
    atomic_copy(tmp, DRIVE / "manifests" / "lums_all.csv")
    summary["manifest_sha256"] = sha256_file(tmp)
    atomic_write_json(summary, DRIVE / "manifests" / "lums_inventory.json")

    # --- print what to paste back ---
    print("\n========= PASTE EVERYTHING BELOW BACK TO CLAUDE =========")
    for k in ["total_files", "unreadable", "per_folder", "sample_rates", "channels", "subtypes",
              "duration_s", "clips_shorter_than_window", "speakers", "f0_median_hz_hint", "manifest_sha256"]:
        print(f"{k}: {summary[k]}")
    pivot = by_spk.pivot_table(index="speaker", columns="attack", values="files", fill_value=0)
    mins = by_spk.groupby("speaker").minutes.sum()
    pivot["total_min"] = mins
    print(pivot.to_string())
    print("=========================================================")
    mark_done("p1_inventory_lums", {"total_files": int(len(df)), "manifest_sha256": summary["manifest_sha256"]})
    log_event("p1_inventory_lums: DONE")


if __name__ == "__main__":
    main()
