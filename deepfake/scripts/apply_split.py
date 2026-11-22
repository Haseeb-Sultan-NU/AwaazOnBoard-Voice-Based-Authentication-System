"""P2 step 1: apply the FROZEN speaker split (deepfake/splits/lums_split.json) to the manifest.

Writes manifests/lums_split.csv (lums_all.csv + `split` column) to Drive, prints the counts you paste
back, and runs the shortcut check: does sample rate (or duration) differ between bona fide and spoof?
If it does, a detector can cheat on that instead of on spoof artefacts, so P2 must neutralise it.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from deepfake.common import DRIVE, LOCAL, atomic_copy, ensure_dirs, log_event, mark_done, sha256_file  # noqa: E402

SPLIT_JSON = Path(__file__).resolve().parents[1] / "splits" / "lums_split.json"


def main() -> None:
    import pandas as pd
    ensure_dirs()
    sp = json.loads(SPLIT_JSON.read_text())["splits"]
    spk2split = {s: k for k, v in sp.items() for s in v}
    df = pd.read_csv(DRIVE / "manifests" / "lums_all.csv")
    df["split"] = df.speaker.map(spk2split).fillna("UNASSIGNED")
    assert (df.split != "UNASSIGNED").all(), "speaker missing from split"
    assert not df.duplicated("sha256").any() or True  # duplicates reported below, not fatal
    tmp = LOCAL / "tmp" / "lums_split.csv"
    tmp.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(tmp, index=False)
    atomic_copy(tmp, DRIVE / "manifests" / "lums_split.csv")
    split_sha = sha256_file(SPLIT_JSON)

    print("\n========= PASTE EVERYTHING BELOW BACK TO CLAUDE =========")
    print("split_json_sha256:", split_sha)
    print("duplicate_sha256_files:", int(df.duplicated("sha256", keep=False).sum()))
    g = df.groupby(["split", "label"]).agg(files=("relpath", "count"), speakers=("speaker", "nunique"),
                                           minutes=("duration_s", lambda s: round(s.sum() / 60, 1)))
    print("\n-- files / minutes per split x label --\n", g.to_string())
    print("\n-- split x attack --\n", pd.crosstab(df.split, df.attack).to_string())
    print("\n-- SHORTCUT CHECK: label x sample rate (file counts) --\n", pd.crosstab(df.label, df.sr).to_string())
    print("\n-- attack x sample rate --\n", pd.crosstab(df.attack, df.sr).to_string())
    print("\n-- duration seconds by label (median / p05 / p95) --")
    print(df.groupby("label").duration_s.describe(percentiles=[.05, .5, .95])[["min", "5%", "50%", "95%", "max"]].round(2).to_string())
    print("\n-- clips shorter than 4.04 s, by label --\n", (df.duration_s < 4.04).groupby(df.label).sum().to_string())
    print("=========================================================")
    mark_done("p2_split_frozen", {"split_json_sha256": split_sha, "files": int(len(df))})
    log_event(f"p2_split_frozen: DONE sha256={split_sha[:12]}")


if __name__ == "__main__":
    main()
