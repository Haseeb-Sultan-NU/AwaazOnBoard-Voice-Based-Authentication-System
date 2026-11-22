"""P2 step 2: preprocess LUMS and build the frozen train/dev/eval sets (+ E1/E2/E3 conditions).

Input : Drive manifests/lums_split.csv  +  local raw clips (/content/work/raw/lums, restored by MASTER SEQUENCE)
Output: Drive processed/<set>_<cond>.tar  and  manifests/proc_<set>_<cond>.csv  (per-file sha256)

Sets / conditions (docs/DEEPFAKE_TRACKER.md §7.4-7.5):
  train: e1                     (training augmentation is applied on the fly later, never stored)
  dev  : e1, e2                 (threshold + early stopping use dev e2)
  eval : e1, e2, e3             (FROZEN: built once, never rebuilt)
Preprocessing, identical for every file / both classes:
  mono -> 7 kHz low-pass at the NATIVE rate -> resample 16 kHz -> the same 7 kHz low-pass again (D8: removes the 16 vs 20 kHz label leak)
  -> trim leading/trailing silence (energy, conservative) -> peak-normalize 0.95 -> drop if < 1.0 s.
Conditions: e2 = 8 kHz, 300-3400 Hz band-pass, white noise SNR 15 dB (same recipe as backend TelephonySimulator),
  e3 = e2 + WebM/Opus 16 kbps round trip (ffmpeg). Noise seed = hash(relpath), so reruns give identical files.
Resumable: finished sets are skipped (marker p2_set_<set>); partly done sets reuse already written wavs.
Usage: python deepfake/scripts/build_eval.py [--only eval|dev|train] [--limit N]   (limit = smoke test, writes nothing to Drive)
"""
from __future__ import annotations

import hashlib
import multiprocessing as mp
import os
import shutil
import subprocess
import sys
import tarfile
from math import gcd
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from deepfake.common import (  # noqa: E402
    CFG, DRIVE, LOCAL, atomic_copy, ensure_dirs, is_done, log_event, mark_done, sha256_file,
)

SR = CFG["audio"]["sample_rate"]            # 16000
SEED = CFG["seed"]
SETS = {"eval": ["e1", "e2", "e3"], "dev": ["e1", "e2"], "train": ["e1"]}   # build order: eval first
PRIORITY = {"eval": 0, "dev": 1, "train": 2}                               # who keeps a duplicated file
BANDLIMIT_HZ = 7000.0
MIN_SECONDS = 1.0
PEAK = 0.95
RAW = LOCAL / "raw" / CFG["datasets"]["lums"]["local_extract_dir"].split("/", 1)[1]
OUT = LOCAL / "processed"


# ----------------------------------------------------------------------------- signal helpers
def _resample(x, src, dst):
    from scipy.signal import resample_poly
    if src == dst:
        return x
    g = gcd(src, dst)
    return resample_poly(x, dst // g, src // g).astype("float32")


def _bandlimit(x, sr):
    from scipy.signal import butter, sosfiltfilt
    sos = butter(8, BANDLIMIT_HZ, btype="low", fs=sr, output="sos")
    return sosfiltfilt(sos, x).astype("float32")


def _trim(x, sr=SR):
    import numpy as np
    n = int(0.020 * sr)
    k = len(x) // n
    if k < 3:
        return x
    rms = np.sqrt((x[: k * n].reshape(k, n) ** 2).mean(axis=1)) + 1e-8
    db = 20 * np.log10(rms)
    keep = np.where(db > db.max() - 40.0)[0]
    if len(keep) == 0:
        return x
    a = max(0, keep[0] - 5) * n
    b = min(k, keep[-1] + 6) * n
    return x[a:b]


def _norm(x):
    import numpy as np
    m = float(np.max(np.abs(x))) if len(x) else 0.0
    return (x * (PEAK / m)).astype("float32") if m > 1e-6 else x


def _seed_for(relpath, tag):
    return int(hashlib.sha256(f"{relpath}|{tag}|{SEED}".encode()).hexdigest()[:8], 16)


def _telephony(x16, relpath, snr_db=15.0):
    import numpy as np
    from scipy.signal import butter, sosfilt
    x = _resample(x16, SR, 8000)
    x = sosfilt(butter(2, 300.0, btype="high", fs=8000, output="sos"), x)
    x = sosfilt(butter(2, 3400.0, btype="low", fs=8000, output="sos"), x)
    p = float(np.mean(x ** 2)) + 1e-12
    rng = np.random.default_rng(_seed_for(relpath, "E2"))
    x = x + rng.standard_normal(len(x)).astype("float32") * np.sqrt(p / (10 ** (snr_db / 10)))
    m = float(np.max(np.abs(x)))
    if m > 1.0:
        x = x / m
    return _norm(_resample(x.astype("float32"), 8000, SR))


def _opus(x16, tmpdir: Path):
    import soundfile as sf
    tmpdir.mkdir(parents=True, exist_ok=True)
    a, b, c = tmpdir / "in.wav", tmpdir / "o.webm", tmpdir / "out.wav"
    sf.write(a, x16, SR, subtype="PCM_16")
    run = lambda cmd: subprocess.run(cmd, check=True, capture_output=True)  # noqa: E731
    run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", str(a), "-c:a", "libopus", "-b:a", "16k", str(b)])
    run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", str(b), "-ar", str(SR), "-ac", "1", "-c:a", "pcm_s16le", str(c)])
    y, _ = sf.read(c, dtype="float32")
    return _norm(y)


# ----------------------------------------------------------------------------- worker
def _work(job):
    import numpy as np
    import soundfile as sf
    rel, split, conds, root, out = job
    root, out = Path(root), Path(out)
    stem = rel.rsplit(".", 1)[0]
    paths = {c: out / split / c / (stem + ".wav") for c in conds}
    try:
        if all(p.exists() for p in paths.values()):          # resume
            e1, _ = sf.read(paths["e1"], dtype="float32")
        else:
            x, sr = sf.read(root / rel, dtype="float32", always_2d=True)
            x = x.mean(axis=1)
            x = _bandlimit(_resample(_bandlimit(x, sr), sr, SR), SR)   # native 7 kHz, resample, then the SAME 7 kHz filter for every file
            x = _norm(_trim(x))
            if len(x) < MIN_SECONDS * SR:
                return {"relpath": rel, "dropped": f"short_after_trim({len(x) / SR:.2f}s)"}
            e1 = x
            outs = {"e1": e1}
            if "e2" in conds or "e3" in conds:
                outs["e2"] = _telephony(e1, rel)
            if "e3" in conds:
                outs["e3"] = _opus(outs["e2"], LOCAL / "tmp" / f"opus_{os.getpid()}")
            for c in conds:
                paths[c].parent.mkdir(parents=True, exist_ok=True)
                tmp = paths[c].with_name(paths[c].name + ".partial")
                sf.write(tmp, np.clip(outs[c], -1, 1), SR, subtype="PCM_16", format="WAV")
                os.replace(tmp, paths[c])
        rows = {}
        for c, p in paths.items():
            info = sf.info(p)
            rows[c] = {"n_samples": int(info.frames), "wav_sha256": sha256_file(p)}
        return {"relpath": rel, "ok": rows}
    except Exception as e:  # noqa: BLE001
        return {"relpath": rel, "dropped": f"error:{type(e).__name__}:{str(e)[:120]}"}


# ----------------------------------------------------------------------------- main
def _check_ffmpeg():
    enc = subprocess.run(["ffmpeg", "-hide_banner", "-encoders"], capture_output=True, text=True).stdout
    if "libopus" not in enc:
        sys.exit("ffmpeg has no libopus encoder; E3 cannot be built. (Colab: apt-get install -y ffmpeg)")


def _dedupe(df):
    """Same audio under several names: keep ONE copy, preferring eval > dev > train, then sorted relpath."""
    df = df.copy()
    df["prio"] = df.split.map(PRIORITY)
    df = df.sort_values(["prio", "relpath"])
    first = ~df.duplicated("sha256", keep="first")
    n_conflict = int(df[df.duplicated("sha256", keep=False)].groupby("sha256").label.nunique().gt(1).sum())
    dropped = df[~first]
    kept_split = df[first].set_index("sha256").split
    cross = int((dropped.split.values != kept_split.loc[dropped.sha256].values).sum())
    return df[first].drop(columns="prio"), {"dup_dropped": int(len(dropped)), "dup_dropped_cross_split": cross,
                                            "dup_groups_with_label_conflict": n_conflict}


def _tar(files: list[tuple[Path, str]], dst_tmp: Path):
    dst_tmp.parent.mkdir(parents=True, exist_ok=True)

    def norm(ti):
        ti.mtime, ti.uid, ti.gid, ti.uname, ti.gname = 0, 0, 0, "", ""
        return ti
    with tarfile.open(dst_tmp, "w") as tf:
        for p, arc in files:
            tf.add(p, arcname=arc, filter=norm)


def _bandwidth_check(df_e1, out):
    """Fraction of energy above 7.2 kHz, by label x native sample rate. Should now be ~equal and tiny."""
    import numpy as np
    import soundfile as sf
    from scipy.signal import welch
    rows = []
    for (lab, sr), g in df_e1.groupby(["label", "sr"]):
        vals = []
        for rel in g.relpath.sort_values().head(40):
            p = out / g.split.iloc[0] / "e1" / (rel.rsplit(".", 1)[0] + ".wav")
            p = next((out / s / "e1" / (rel.rsplit(".", 1)[0] + ".wav") for s in SETS if (out / s / "e1" / (rel.rsplit(".", 1)[0] + ".wav")).exists()), p)
            if p.exists():
                x, _ = sf.read(p, dtype="float32")
                f, pxx = welch(x, SR, nperseg=1024)
                vals.append(float(pxx[f > 7200].sum() / (pxx.sum() + 1e-20)))
        if vals:
            rows.append((lab, int(sr), len(vals), f"{np.mean(vals):.2e}"))
    return rows


def main() -> None:
    import pandas as pd
    only = sys.argv[sys.argv.index("--only") + 1] if "--only" in sys.argv else None
    limit = int(sys.argv[sys.argv.index("--limit") + 1]) if "--limit" in sys.argv else None
    ensure_dirs()
    _check_ffmpeg()
    if not (RAW.exists() and any(RAW.iterdir())):
        sys.exit(f"Raw LUMS not found at {RAW}. Run the MASTER SEQUENCE cell first.")
    if not is_done("p2_split_frozen"):
        sys.exit("Run apply_split.py first (marker p2_split_frozen missing).")

    df = pd.read_csv(DRIVE / "manifests" / "lums_split.csv")
    df = df[df.error.isna() | (df.error == "")]
    df, dupinfo = _dedupe(df)
    print("dedupe:", dupinfo)
    log_event(f"build_eval dedupe {dupinfo}")
    smoke = limit is not None
    all_dropped, summary = [], []

    for split in [s for s in SETS if only in (None, s)]:
        conds = SETS[split]
        if not smoke and is_done(f"p2_set_{split}"):
            print(f"[skip] {split}: already built (marker p2_set_{split})")
            continue
        d = df[df.split == split].sort_values("relpath")
        if smoke:
            d = d.groupby("label", group_keys=False).head(limit)
        print(f"\n=== {split}: {len(d)} files -> {conds} ===")
        jobs = [(r, split, conds, str(RAW), str(OUT)) for r in d.relpath]
        results = []
        with mp.Pool(max(1, (os.cpu_count() or 2))) as pool:
            for i, res in enumerate(pool.imap(_work, jobs, chunksize=8), 1):
                results.append(res)
                if i % 250 == 0 or i == len(jobs):
                    print(f"  {split}: {i}/{len(jobs)}", flush=True)
        ok = {r["relpath"]: r["ok"] for r in results if "ok" in r}
        dropped = [(r["relpath"], r["dropped"]) for r in results if "dropped" in r]
        all_dropped += [(split,) + t for t in dropped]
        if any(x[1].startswith("error") for x in dropped):
            print("  ERRORS:", [x for x in dropped if x[1].startswith("error")][:5])
        d = d[d.relpath.isin(ok)].copy()
        for c in conds:
            m = d[["relpath", "label", "attack", "speaker", "split", "sr", "sha256"]].rename(columns={"sr": "orig_sr", "sha256": "orig_sha256"})
            m["cond"] = c
            m["n_samples"] = [ok[r][c]["n_samples"] for r in m.relpath]
            m["wav_sha256"] = [ok[r][c]["wav_sha256"] for r in m.relpath]
            man = LOCAL / "tmp" / f"proc_{split}_{c}.csv"
            m.to_csv(man, index=False)
            msha = sha256_file(man)
            tarp = LOCAL / "tmp" / f"{split}_{c}.tar"
            _tar([(OUT / split / c / (r.rsplit(".", 1)[0] + ".wav"), f"{split}/{c}/" + r.rsplit(".", 1)[0] + ".wav") for r in m.relpath], tarp)
            summary.append((split, c, len(m), round(m.n_samples.sum() / SR / 60, 1), msha, int(m.label.eq("bonafide").sum()), int(m.label.eq("spoof").sum())))
            if not smoke:
                atomic_copy(man, DRIVE / "manifests" / man.name)
                atomic_copy(tarp, DRIVE / "processed" / tarp.name)
                assert (DRIVE / "processed" / tarp.name).stat().st_size == tarp.stat().st_size, "Drive copy size mismatch"
            tarp.unlink()
        if not smoke:
            mark_done(f"p2_set_{split}", {"files": int(len(d)), "dropped": len(dropped)})
            log_event(f"p2_set_{split}: DONE files={len(d)} dropped={len(dropped)}")

    print("\n========= PASTE EVERYTHING BELOW BACK TO CLAUDE =========")
    print("dedupe:", dupinfo)
    print("dropped after trim/errors:", len(all_dropped), all_dropped[:6])
    print(f"{'set':6}{'cond':5}{'files':>7}{'real':>6}{'fake':>6}{'min':>8}  manifest_sha256")
    for s in summary:
        print(f"{s[0]:6}{s[1]:5}{s[2]:>7}{s[5]:>6}{s[6]:>6}{s[3]:>8}  {s[4]}")
    e1 = df[df.relpath.isin([r for r in df.relpath])]
    print("\nenergy above 7.2 kHz in e1 (label, native_sr, n, mean fraction): should be tiny and similar")
    for r in _bandwidth_check(e1, OUT):
        print("  ", r)
    print("=========================================================")
    if not smoke and all(is_done(f"p2_set_{s}") for s in SETS):
        mark_done("p2_eval_built", {"sets": list(SETS)})
        log_event("p2_eval_built: DONE")


if __name__ == "__main__":
    main()
