"""P3.2: prove our HF port == the published model (ONNX export of the same checkpoint), on real Urdu clips.

Uses TRAIN clips only (never dev/eval). Checks CPU fp32, and GPU fp32 too when a GPU is present.
Pass = max |Δ log-prob| < 1e-3 on every window AND identical decisions.
Saves the windows + reference outputs to Drive (models/pretrained/parity_ref.npz) so every later eval/train
run can re-check the port in seconds (catches a silent transformers upgrade on Colab).
"""
from __future__ import annotations

import gc
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import numpy as np  # noqa: E402

from deepfake.common import CFG, DRIVE, LOCAL, atomic_copy, ensure_dirs, is_done, log_event, mark_done  # noqa: E402

TOL = CFG["pretrained"]["parity_tolerance"]


def pick_windows():
    import soundfile as sf
    from deepfake.data import ensure_local_set, wav_path
    from deepfake.model.xlsr_sls import fixed_window
    from deepfake.scripts.build_eval import _telephony
    df, root = ensure_local_set("train", "e1")
    df = df.sort_values("relpath")
    picks = []
    for attack in ["-", "vits", "tacotron"]:
        g = df[df.attack == attack]
        picks += list(g.groupby("speaker").head(1).relpath[:5])           # 5 speakers per class
    picks += list(df.sort_values("n_samples").relpath[:2])               # shortest -> tiling path
    names, X = [], []
    for r in picks:
        x, _ = sf.read(wav_path(root, "train", "e1", r), dtype="float32")
        names.append(r)
        X.append(fixed_window(x))
    for r in picks[:2] + picks[5:6] + picks[10:11]:                      # telephony-band versions (E2 style)
        x, _ = sf.read(wav_path(root, "train", "e1", r), dtype="float32")
        names.append("E2:" + r)
        X.append(fixed_window(_telephony(x, r)))
    rng = np.random.default_rng(1234)
    names += ["silence", "low_noise"]
    X += [np.zeros(64600, np.float32), (1e-3 * rng.standard_normal(64600)).astype(np.float32)]
    return names, np.stack(X).astype(np.float32)


def main() -> None:
    import torch
    ensure_dirs()
    if not is_done("p3_download_pretrained"):
        sys.exit("Run P3.1 first (download_pretrained.py).")
    from deepfake.scripts.download_pretrained import fetch
    from deepfake.model.loader import get_model, logprobs, set_exact_math
    set_exact_math()
    names, X = pick_windows()
    print(f"parity windows: {len(X)}")

    import onnxruntime as ort
    onnx = fetch(CFG["pretrained"]["onnx_reference"], LOCAL / "models")
    sess = ort.InferenceSession(str(onnx), providers=["CPUExecutionProvider"])
    ref = np.concatenate([sess.run(None, {"wav": X[i:i + 4]})[0] for i in range(0, len(X), 4)])
    del sess
    gc.collect()

    results = {}
    model, rep = get_model("pretrained", torch.device("cpu"))
    print("weights:", rep)
    out = logprobs(model, X, torch.device("cpu"))
    results["cpu"] = out
    if torch.cuda.is_available():
        model.to("cuda")
        results["gpu"] = logprobs(model, X, torch.device("cuda"))
    del model
    gc.collect()

    ok, report = True, {}
    for k, o in results.items():
        d = float(np.abs(o - ref).max())
        same = bool((o.argmax(1) == ref.argmax(1)).all())
        report[k] = {"max_abs_diff_logprob": d, "same_decisions": same}
        ok &= d < TOL and same
    lo_ref = ref[:, 1] - ref[:, 0]
    print("\n========= PASTE EVERYTHING BELOW BACK TO CLAUDE =========")
    import transformers
    print(f"torch {torch.__version__} | transformers {transformers.__version__} | windows {len(X)} | tol {TOL}")
    for k, v in report.items():
        print(f"{k:4}: max|Δlogprob| = {v['max_abs_diff_logprob']:.2e}   same decisions = {v['same_decisions']}")
    print("reference log-odds (higher = more real; pretrained model, TRAIN clips):")
    for n, s in zip(names, lo_ref):
        print(f"  {s:9.3f}  {n}")
    print("PARITY:", "PASS" if ok else "FAIL")
    print("=========================================================")
    if not ok:
        sys.exit("Parity FAILED. Do not run P3.3. Paste the block to Claude.")
    tmp = LOCAL / "tmp" / "parity_ref.npz"
    np.savez(tmp, X=X, ref=ref.astype(np.float32), names=np.array(names))
    atomic_copy(tmp, DRIVE / CFG["pretrained"]["parity_ref_drive_path"])
    onnx.unlink(missing_ok=True)                                          # local only; frees 1.36 GB
    mark_done("p3_model_ready", {"report": report, "torch": torch.__version__, "transformers": transformers.__version__,
                                 "windows": len(X)})
    log_event(f"p3_model_ready: PASS {json.dumps(report)}")


if __name__ == "__main__":
    main()
