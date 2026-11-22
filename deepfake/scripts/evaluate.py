"""Score a model on the FROZEN sets and compute metrics. The SAME script produces the baseline and the final numbers.

  python deepfake/scripts/evaluate.py --run baseline                       # pretrained XLSR-SLS (P3.3)
  python deepfake/scripts/evaluate.py --run ft1 --ckpt /content/drive/MyDrive/AwaazDeepfake/checkpoints/ft1/best.pt

Protocol (tracker §8): score = log-odds; primary = first 64,600 samples (tile if shorter); secondary = mean over
<=4 non-overlapping windows. tau = EER threshold on DEV e2 (primary), then applied unchanged to every EVAL condition.
Resumable: per-file scores are saved to Drive results/<run>/scores_<split>_<cond>.csv every ~200 files; finished
files are skipped on re-run. Requires a GPU (refuses CPU unless --allow-cpu).
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import numpy as np  # noqa: E402

from deepfake.common import DRIVE, LOCAL, REPO_ROOT, atomic_copy, atomic_write_json, ensure_dirs, is_done, log_event, mark_done, now  # noqa: E402

DEFAULT_SETS = ["dev:e1", "dev:e2", "eval:e1", "eval:e2", "eval:e3"]
COLS = ["relpath", "split", "cond", "label", "attack", "speaker", "n_samples", "n_windows",
        "score_primary", "score_multi", "lp_bona_w0", "lp_spoof_w0"]


def git_hash() -> str:
    try:
        return subprocess.run(["git", "-C", str(REPO_ROOT), "rev-parse", "--short", "HEAD"],
                              capture_output=True, text=True, check=True).stdout.strip()
    except Exception:  # noqa: BLE001
        return "unknown"


def score_set(model, dev, split, cond, run_dir: Path, batch_clips: int):
    import pandas as pd
    import soundfile as sf
    import torch
    from concurrent.futures import ThreadPoolExecutor
    from deepfake.data import ensure_local_set, wav_path
    from deepfake.model.xlsr_sls import windows

    df, root = ensure_local_set(split, cond)
    out_csv = run_dir / f"scores_{split}_{cond}.csv"
    done = pd.read_csv(out_csv) if out_csv.exists() else pd.DataFrame(columns=COLS)
    todo = df[~df.relpath.isin(set(done.relpath))].sort_values("relpath")
    print(f"[{split}:{cond}] {len(df)} files, {len(done)} already scored, {len(todo)} to go", flush=True)
    rows = done.to_dict("records")

    def load(r):
        x, sr = sf.read(wav_path(root, split, cond, r.relpath), dtype="float32")
        assert sr == 16000 and x.ndim == 1, f"bad audio {r.relpath}"
        return r, windows(x)

    def flush():
        tmp = LOCAL / "tmp" / out_csv.name
        pd.DataFrame(rows, columns=COLS).to_csv(tmp, index=False)
        atomic_copy(tmp, out_csv)

    t0, last_flush = time.time(), 0
    recs = list(todo.itertuples(index=False))
    with ThreadPoolExecutor(4) as pool:
        for i in range(0, len(recs), batch_clips):
            items = list(pool.map(load, recs[i:i + batch_clips]))
            W = np.concatenate([np.stack(w) for _, w in items]).astype(np.float32)
            with torch.inference_mode():
                lp = torch.cat([model(torch.from_numpy(W[j:j + 16]).to(dev)) for j in range(0, len(W), 16)]).float().cpu().numpy()
            if not np.isfinite(lp).all():
                raise RuntimeError(f"non-finite model output in {split}:{cond} near {items[0][0].relpath}")
            lo = lp[:, 1] - lp[:, 0]
            k = 0
            for r, w in items:
                n = len(w)
                rows.append({"relpath": r.relpath, "split": split, "cond": cond, "label": r.label, "attack": r.attack,
                             "speaker": r.speaker, "n_samples": int(r.n_samples), "n_windows": n,
                             "score_primary": float(lo[k]), "score_multi": float(lo[k:k + n].mean()),
                             "lp_bona_w0": float(lp[k, 1]), "lp_spoof_w0": float(lp[k, 0])})
                k += n
            if len(rows) - last_flush >= 200:
                flush()
                last_flush = len(rows)
                rate = (len(rows) - len(done)) / (time.time() - t0)
                print(f"  {split}:{cond} {len(rows)}/{len(df)}  ({rate:.1f} files/s)", flush=True)
    flush()
    res = pd.read_csv(out_csv)
    assert len(res) == len(df) and set(res.relpath) == set(df.relpath), f"{split}:{cond} incomplete scores"
    return res


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True, help="results folder name, e.g. baseline, ft1")
    ap.add_argument("--ckpt", default="pretrained")
    ap.add_argument("--sets", default=",".join(DEFAULT_SETS))
    ap.add_argument("--batch-clips", type=int, default=8)
    ap.add_argument("--allow-cpu", action="store_true")
    a = ap.parse_args()

    import pandas as pd
    import torch
    import transformers
    from deepfake.data import check_manifest
    from deepfake.metrics import summarize
    from deepfake.model.loader import device, get_model, self_check, set_exact_math

    ensure_dirs()
    if not is_done("p3_model_ready"):
        sys.exit("Run P3.2 (parity_check.py) first.")
    sets = [tuple(s.split(":")) for s in a.sets.split(",")]
    if ("dev", "e2") not in sets:
        sys.exit("dev:e2 must be included (it defines the threshold tau).")
    set_exact_math()
    dev = device(a.allow_cpu)
    model, rep = get_model(a.ckpt, dev)
    print("model:", rep.get("ckpt"), "| device:", torch.cuda.get_device_name(0) if dev.type == "cuda" else "cpu")
    if a.ckpt == "pretrained":
        self_check(model, dev)
    run_dir = DRIVE / "results" / a.run
    run_dir.mkdir(parents=True, exist_ok=True)

    scores = {f"{s}:{c}": score_set(model, dev, s, c, run_dir, a.batch_clips) for s, c in sets}

    tau = {}
    metrics = {"run": a.run, "ckpt": rep.get("ckpt"), "git": git_hash(), "date": now(), "torch": torch.__version__,
               "transformers": transformers.__version__,
               "manifests": {f"{s}:{c}": check_manifest(s, c) for s, c in sets}, "results": {}}
    for col in ["score_primary", "score_multi"]:
        tau[col] = summarize(scores["dev:e2"], col)["all"]["eer_threshold"]
        for key, df in scores.items():
            metrics["results"].setdefault(key, {})[col] = summarize(df, col, tau[col])
    metrics["tau_dev_e2"] = tau
    atomic_write_json(metrics, run_dir / "metrics.json")

    print("\n========= PASTE EVERYTHING BELOW BACK TO CLAUDE =========")
    print(f"run={a.run} ckpt={rep.get('ckpt')} git={metrics['git']} torch={torch.__version__} transformers={transformers.__version__}")
    print(f"tau (dev e2 EER threshold, log-odds): primary={tau['score_primary']:.4f}  multi={tau['score_multi']:.4f}")
    for col in ["score_primary", "score_multi"]:
        print(f"\n-- {col}: EER% (AUC) | at tau: bona-fide reject% / spoof accept% --")
        print(f"{'set':9}{'attack':10}{'EER%':>7}{'AUC':>7}{'BFrej%':>8}{'SPacc%':>8}{'n_b':>6}{'n_s':>6}")
        for key in scores:
            for att, m in metrics["results"][key][col].items():
                print(f"{key:9}{att:10}{100 * m['eer']:7.2f}{m['auc']:7.3f}{100 * m['bona_reject_rate']:8.2f}"
                      f"{100 * m['spoof_accept_rate']:8.2f}{m['n_bona']:6}{m['n_spoof']:6}")
    q = {k: np.percentile(v.score_primary, [5, 50, 95]).round(2).tolist() for k, v in
         {f"{k}:{lab}": d[d.label == lab] for k, d in scores.items() for lab in ["bonafide", "spoof"]}.items()}
    print("\nscore_primary percentiles [p5, p50, p95]:")
    for k, v in q.items():
        print(f"  {k:22} {v}")
    print("=========================================================")
    log_event(f"evaluate run={a.run} done")
    if a.run == "baseline" and a.ckpt == "pretrained" and set(DEFAULT_SETS) <= {f"{s}:{c}" for s, c in sets}:
        mark_done("p3_baseline_eval", {"tau": tau, "git": metrics["git"]})


if __name__ == "__main__":
    main()
