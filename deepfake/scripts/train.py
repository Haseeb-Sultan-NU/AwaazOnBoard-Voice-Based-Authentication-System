"""P5: fine-tune XLSR-SLS on Urdu (LUMS train speakers) with channel augmentation on both classes.

  python deepfake/scripts/train.py --smoke            # ~10 min: speed, memory, checkpoint save/reload, Drive purge
  python deepfake/scripts/train.py --run ft1          # real run; re-run the same command after any disconnect

Bulletproofing (tracker §15):
  * auto-resume from <run>_last.pt (local SSD copy if newer, else Drive), mid-epoch, at an exact batch position
  * deterministic data order + augmentation (seeded by run seed, epoch, index), so a resumed epoch is identical
  * checkpoint = model + optimizer + GradScaler + epoch/batch/step + RNG + best metric + history + config hash + git
  * refuses to resume if the training config changed (config hash) unless --force-config
  * atomic Drive writes, free-space check, permanent purge of our own old checkpoints from Drive Trash
  * non-finite loss/grad steps are skipped by GradScaler; too many in a row -> stop (never saves NaN weights)
  * Ctrl-C / cell stop -> saves a checkpoint at the last clean boundary before exiting
  * dev metrics on the frozen DEV sets only (never eval); best.pt chosen on DEV; early stopping on DEV
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import signal
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import numpy as np  # noqa: E402

from deepfake.common import (  # noqa: E402
    CFG, DRIVE, LOCAL, atomic_copy, atomic_write_json, ensure_dirs, is_done, log_event, mark_done, now, purge_trashed,
)

TC = CFG["train"]
SEED = CFG["seed"]
LABEL = {"bonafide": 1, "spoof": 0}
STOP = {"flag": False}


# ============================================================================ data
class TrainSet:
    """Items are addressed as (epoch, index) so the per-sample RNG is deterministic across workers and resumes."""

    def __init__(self, items, aug_cfg, augment_on=True):
        self.items = items              # list of (wav_path, label_int)
        self.aug = aug_cfg
        self.augment_on = augment_on

    def __len__(self):
        return len(self.items)

    def __getitem__(self, key):
        import soundfile as sf
        import torch
        from deepfake.augment import augment
        from deepfake.model.xlsr_sls import WINDOW, fixed_window
        epoch, i = key
        path, y = self.items[i]
        rng = np.random.default_rng([SEED, epoch, i])
        x, sr = sf.read(path, dtype="float32")
        if sr != 16000 or x.ndim != 1:
            raise RuntimeError(f"bad training audio {path}")
        if len(x) > WINDOW:                                   # random crop (eval uses the first window)
            s = int(rng.integers(0, len(x) - WINDOW + 1))
            x = x[s:s + WINDOW]
        x = fixed_window(x)
        if self.augment_on:
            x, _ = augment(x, rng, self.aug)
            x = fixed_window(x)                               # codec may change length by a few ms
        if not np.isfinite(x).all():
            x = np.nan_to_num(x)
        return torch.from_numpy(np.ascontiguousarray(x, np.float32)), y


class EpochBatches:
    """Batch sampler: deterministic permutation per epoch, can start mid-epoch, drops the last partial batch."""

    def __init__(self, n, batch, epoch, start_batch=0):
        perm = np.random.default_rng([SEED, 999, epoch]).permutation(n)
        self.batches = [[(epoch, int(j)) for j in perm[k:k + batch]] for k in range(0, n - batch + 1, batch)]
        self.start = start_batch

    def __iter__(self):
        return iter(self.batches[self.start:])

    def __len__(self):
        return len(self.batches) - self.start


def load_items(sets):
    from deepfake.data import ensure_local_set, wav_path
    items, counts = [], {}
    for s in sets:
        split, cond = s.split(":")
        if split in ("eval",):
            raise SystemExit("REFUSING: eval data can never be used for training (Golden rule 2).")
        df, root = ensure_local_set(split, cond)
        for r in df.itertuples(index=False):
            items.append((str(wav_path(root, split, cond, r.relpath)), LABEL[r.label]))
            counts[r.label] = counts.get(r.label, 0) + 1
    return items, counts


def worker_init(_):
    import torch
    torch.set_num_threads(1)                                  # avoid CPU oversubscription in workers


# ============================================================================ helpers
def config_hash(args) -> str:
    blob = json.dumps({"train": TC, "seed": SEED, "batch": args.batch, "accum": args.accum}, sort_keys=True)
    return hashlib.sha256(blob.encode()).hexdigest()[:16]


def git_hash() -> str:
    import subprocess
    try:
        from deepfake.common import REPO_ROOT
        return subprocess.run(["git", "-C", str(REPO_ROOT), "rev-parse", "--short", "HEAD"],
                              capture_output=True, text=True, check=True).stdout.strip()
    except Exception:  # noqa: BLE001
        return "unknown"


def param_groups(model):
    head, back = [], []
    for n, p in model.named_parameters():
        if not p.requires_grad:
            continue
        (head if not n.startswith("wav2vec2.") else back).append(p)
    return [{"params": back, "lr": TC["lr_backbone"], "base_lr": TC["lr_backbone"], "name": "backbone"},
            {"params": head, "lr": TC["lr_head"], "base_lr": TC["lr_head"], "name": "head"}]


def set_lr(opt, step):
    f = min(1.0, (step + 1) / max(1, TC["warmup_steps"]))
    for g in opt.param_groups:
        g["lr"] = g["base_lr"] * f


def rng_state():
    import torch
    return {"torch": torch.get_rng_state(), "cuda": torch.cuda.get_rng_state_all() if torch.cuda.is_available() else [],
            "numpy": np.random.get_state(), "python": random.getstate()}


def set_rng_state(s):
    import torch
    torch.set_rng_state(s["torch"])
    if torch.cuda.is_available() and s["cuda"]:
        torch.cuda.set_rng_state_all(s["cuda"])
    np.random.set_state(s["numpy"])
    random.setstate(s["python"])


def finite_model(model) -> bool:
    import torch
    return all(torch.isfinite(p).all() for p in model.parameters())


# ============================================================================ checkpoints
class Ckpt:
    def __init__(self, run):
        self.run = run
        self.drive_dir = DRIVE / "checkpoints" / run
        self.local_dir = LOCAL / "ckpt" / run
        self.drive_dir.mkdir(parents=True, exist_ok=True)
        self.local_dir.mkdir(parents=True, exist_ok=True)
        self.last_name, self.best_name = f"{run}_last.pt", f"{run}_best.pt"
        self.purge_status = "not tried"

    def _to_drive(self, local: Path, name: str):
        import shutil
        size = local.stat().st_size
        free = shutil.disk_usage("/content/drive/MyDrive").free
        if free < size * 1.1 + 1e9:
            self.purge_status = purge_trashed([self.last_name, self.best_name])
            free = shutil.disk_usage("/content/drive/MyDrive").free
        if free < size * 1.1 + 1e9:
            msg = (f"!!! DRIVE FULL: {free / 1e9:.1f} GB free, need {size / 1e9:.1f} GB. {name} saved LOCALLY ONLY "
                   f"(lost on disconnect). Empty Drive Trash / free space, or delete raw/lums_urdu.tar. !!!")
            print(msg, flush=True)
            log_event(msg)
            return False
        atomic_copy(local, self.drive_dir / name)
        self.purge_status = purge_trashed([name])            # the replaced old copy went to Trash
        return True

    def save_last(self, state: dict):
        import torch
        t = time.time()
        local = self.local_dir / self.last_name
        tmp = local.with_name(local.name + ".partial")
        torch.save(state, tmp)
        os.replace(tmp, local)
        ok = self._to_drive(local, self.last_name)
        print(f"  [checkpoint] epoch {state['epoch']} batch {state['batch_in_epoch']} step {state['opt_step']} -> "
              f"{'Drive' if ok else 'LOCAL ONLY'} in {time.time() - t:.0f}s | trash purge: {self.purge_status}", flush=True)

    def save_best(self, model, meta: dict):
        import torch
        sd = {k: (v.half() if v.is_floating_point() else v) for k, v in model.state_dict().items()}
        local = self.local_dir / self.best_name
        tmp = local.with_name(local.name + ".partial")
        torch.save({"model": sd, **meta}, tmp)
        os.replace(tmp, local)
        ok = self._to_drive(local, self.best_name)
        print(f"  [best] saved ({'Drive' if ok else 'LOCAL ONLY'})", flush=True)

    def load_last(self):
        """Newest valid of (local, Drive). Corrupt files are reported and skipped."""
        import torch
        cands = [p for p in (self.local_dir / self.last_name, self.drive_dir / self.last_name) if p.exists()]
        cands.sort(key=lambda p: p.stat().st_mtime, reverse=True)
        for p in cands:
            try:
                return torch.load(p, map_location="cpu", weights_only=False), p
            except Exception as e:  # noqa: BLE001
                print(f"  could not read {p} ({type(e).__name__}); trying next", flush=True)
        return None, None


# ============================================================================ dev evaluation
def dev_eval(model, dev, sets, limit=None):
    import pandas as pd
    import soundfile as sf
    import torch
    from deepfake.data import ensure_local_set, wav_path
    from deepfake.metrics import eer
    from deepfake.model.xlsr_sls import fixed_window
    model.eval()
    res = {}
    try:
        for s in sets:
            split, cond = s.split(":")
            assert split == "dev", "early stopping / model selection may only use DEV"
            df, root = ensure_local_set(split, cond)
            df = df.sort_values("relpath")
            if limit:
                df = df.groupby("label", group_keys=False).head(limit // 2)
            scores = []
            paths = [wav_path(root, split, cond, r) for r in df.relpath]
            for k in range(0, len(paths), 16):
                X = np.stack([fixed_window(sf.read(p, dtype="float32")[0]) for p in paths[k:k + 16]])
                with torch.inference_mode(), torch.autocast("cuda", dtype=torch.float16, enabled=dev.type == "cuda"):
                    lp = model(torch.from_numpy(X).to(dev)).float().cpu().numpy()
                scores.append(lp[:, 1] - lp[:, 0])
            sc = np.concatenate(scores)
            if not np.isfinite(sc).all():
                res[s] = {"eer": 1.0, "nonfinite": True}
                continue
            lab = df.label.values
            e, t = eer(sc[lab == "bonafide"], sc[lab == "spoof"])
            res[s] = {"eer": e, "thr": t, "bona_median": float(np.median(sc[lab == "bonafide"])),
                      "spoof_median": float(np.median(sc[lab == "spoof"]))}
    finally:
        model.train()
    res["select"] = float(np.mean([res[s]["eer"] for s in sets]))
    return res


# ============================================================================ main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", default="ft1")
    ap.add_argument("--smoke", action="store_true")
    ap.add_argument("--batch", type=int, default=TC["batch"])
    ap.add_argument("--accum", type=int, default=TC["accum"])
    ap.add_argument("--grad-ckpt", action="store_true", help="gradient checkpointing (use if CUDA out of memory)")
    ap.add_argument("--force-config", action="store_true")
    ap.add_argument("--smoke-steps", type=int, default=12)
    a = ap.parse_args()
    if a.smoke:
        a.run = "smoke"

    import torch
    import torch.nn.functional as F
    from torch.utils.data import DataLoader
    from deepfake.model.loader import device, get_model

    ensure_dirs()
    if not is_done("p3_model_ready"):
        sys.exit("Run P3 first (parity check).")
    dev = device(allow_cpu=False)
    torch.backends.cuda.matmul.allow_tf32 = False             # same numerics as eval
    torch.backends.cudnn.allow_tf32 = False
    torch.manual_seed(SEED)
    np.random.seed(SEED)
    random.seed(SEED)
    chash, ghash = config_hash(a), git_hash()

    items, counts = load_items(TC["train_sets"])
    n_b, n_s = counts.get("bonafide", 0), counts.get("spoof", 0)
    cls_w = torch.tensor([len(items) / (2 * n_s), len(items) / (2 * n_b)], dtype=torch.float32, device=dev)  # [spoof, bona]
    print(f"train items: {len(items)} (bona {n_b} / spoof {n_s}); class weights [spoof, bona] = "
          f"{cls_w.tolist()}; config {chash}; git {ghash}", flush=True)

    model, _ = get_model("pretrained", dev)
    if TC["freeze_cnn"]:
        model.freeze_cnn()
    model.grad_ckpt = a.grad_ckpt
    model.train()
    opt = torch.optim.AdamW(param_groups(model), weight_decay=TC["weight_decay"])
    scaler = torch.amp.GradScaler("cuda")
    ck = Ckpt(a.run)

    # ---------------- resume
    st = {"epoch": 0, "batch_in_epoch": 0, "opt_step": 0, "best": None, "bad_epochs": 0, "history": []}
    if not a.smoke:
        saved, where = ck.load_last()
        if saved is not None:
            if saved["config_hash"] != chash and not a.force_config:
                sys.exit(f"Checkpoint {where} was made with config {saved['config_hash']}, current is {chash}. "
                         "Refusing to mix recipes. Use a new --run name (or --force-config if you really mean it).")
            model.load_state_dict(saved["model"])
            opt.load_state_dict(saved["optimizer"])
            scaler.load_state_dict(saved["scaler"])
            set_rng_state(saved["rng"])
            st = {k: saved[k] for k in st}
            print(f"RESUMED from {where}: epoch {st['epoch']} batch {st['batch_in_epoch']} step {st['opt_step']} "
                  f"best {st['best']}", flush=True)
            if saved.get("finished"):
                print("This run already finished. Evaluate it with evaluate.py --ckpt (see notebook).")
                return
        else:
            print("starting a NEW run", flush=True)

    def full_state(epoch, batch_in_epoch, finished=False):
        return {"model": model.state_dict(), "optimizer": opt.state_dict(), "scaler": scaler.state_dict(),
                "rng": rng_state(), "epoch": epoch, "batch_in_epoch": batch_in_epoch, "opt_step": st["opt_step"],
                "best": st["best"], "bad_epochs": st["bad_epochs"], "history": st["history"], "config_hash": chash,
                "git": ghash, "train_cfg": TC, "saved_utc": now(), "finished": finished}

    def on_signal(*_):
        STOP["flag"] = True
        print("\n  stop requested: saving at the next clean boundary ...", flush=True)
    signal.signal(signal.SIGINT, on_signal)
    signal.signal(signal.SIGTERM, on_signal)

    ds = TrainSet(items, TC["aug"])
    run_dir = DRIVE / "results" / a.run
    run_dir.mkdir(parents=True, exist_ok=True)
    max_epochs = 1 if a.smoke else TC["max_epochs"]
    smoke_steps = a.smoke_steps
    last_ck = time.time()
    skipped_in_row = 0

    for epoch in range(st["epoch"], max_epochs):
        sampler = EpochBatches(len(ds), a.batch, epoch, st["batch_in_epoch"] if epoch == st["epoch"] else 0)
        n_batches = len(sampler.batches)
        dl = DataLoader(ds, batch_sampler=sampler, num_workers=TC["num_workers"], pin_memory=True,
                        worker_init_fn=worker_init, persistent_workers=False, prefetch_factor=4)
        b = sampler.start
        t_ep, seen, loss_sum, loss_n = time.time(), 0, 0.0, 0
        opt.zero_grad(set_to_none=True)
        print(f"\n=== epoch {epoch + 1}/{max_epochs}: batches {b}..{n_batches} (batch {a.batch} x accum {a.accum}) ===", flush=True)
        for x, y in dl:
            x, y = x.to(dev, non_blocking=True), y.to(dev, non_blocking=True)
            with torch.autocast("cuda", dtype=torch.float16):
                lp = model(x)
            loss = F.nll_loss(lp.float(), y, weight=cls_w) / a.accum
            scaler.scale(loss).backward()
            b += 1
            seen += len(y)
            if torch.isfinite(loss):
                loss_sum += loss.item() * a.accum
                loss_n += 1
            if b % a.accum == 0:                              # optimizer step boundary = clean checkpoint point
                set_lr(opt, st["opt_step"])
                scaler.unscale_(opt)
                gn = torch.nn.utils.clip_grad_norm_([p for g in opt.param_groups for p in g["params"]], TC["grad_clip"])
                prev_scale = scaler.get_scale()
                scaler.step(opt)
                scaler.update()
                opt.zero_grad(set_to_none=True)
                skipped = scaler.get_scale() < prev_scale or not torch.isfinite(gn)
                skipped_in_row = skipped_in_row + 1 if skipped else 0
                if skipped_in_row >= TC["max_skipped_steps"]:
                    sys.exit(f"{skipped_in_row} optimizer steps in a row had inf/NaN gradients. Stopping WITHOUT saving. "
                             "Re-run to resume from the last good checkpoint; if it repeats, paste the log to Claude.")
                if not skipped:
                    st["opt_step"] += 1
                if b % (20 * a.accum) == 0:
                    el = time.time() - t_ep
                    eta = el / max(1, b - sampler.start) * (n_batches - b)
                    mem = torch.cuda.max_memory_allocated() / 1e9
                    print(f"  ep {epoch + 1} batch {b}/{n_batches} step {st['opt_step']} loss {loss_sum / max(1, loss_n):.4f} "
                          f"| {seen / el:.1f} clips/s | GPU peak {mem:.1f} GB | epoch ETA {eta / 60:.0f} min", flush=True)
                    loss_sum, loss_n = 0.0, 0
                if a.smoke and st["opt_step"] >= smoke_steps:
                    break
                if STOP["flag"] or time.time() - last_ck > TC["checkpoint_minutes"] * 60:
                    if finite_model(model):
                        ck.save_last(full_state(epoch, b))
                    last_ck = time.time()
                    if STOP["flag"]:
                        print("saved; exiting. Re-run the same cell to resume.")
                        return
        del dl

        if a.smoke:
            smoke_report(model, dev, ck, full_state(epoch, b), t_ep, seen, len(items))
            return

        # ---------------- end of epoch: DEV metrics, model selection, early stopping
        if not finite_model(model):
            sys.exit("Model weights became non-finite. Not saving. Re-run to resume from the last checkpoint.")
        t_dev = time.time()
        m = dev_eval(model, dev, TC["dev_sets"])
        improved = st["best"] is None or m["select"] < st["best"]["select"] - 1e-4
        st["bad_epochs"] = 0 if improved else st["bad_epochs"] + 1
        rec = {"epoch": epoch + 1, "opt_step": st["opt_step"], "train_min": round((t_dev - t_ep) / 60, 1),
               "dev_min": round((time.time() - t_dev) / 60, 1), "dev": m, "improved": improved, "utc": now()}
        st["history"].append(rec)
        tag = "(BEST)" if improved else f"(no gain {st['bad_epochs']}/{TC['patience']})"
        print(f"  DEV after epoch {epoch + 1}: " + " | ".join(f"{s} EER {100 * m[s]['eer']:.2f}%" for s in TC["dev_sets"])
              + f" | select {100 * m['select']:.2f}% {tag}", flush=True)
        if improved:
            st["best"] = {"epoch": epoch + 1, "select": m["select"], "dev": m}
            ck.save_best(model, {"epoch": epoch + 1, "dev": m, "config_hash": chash, "git": ghash, "train_cfg": TC})
        atomic_write_json({"run": a.run, "config_hash": chash, "git": ghash, "history": st["history"], "best": st["best"]},
                          run_dir / "train_history.json")
        done = st["bad_epochs"] >= TC["patience"] or epoch + 1 >= max_epochs
        st["epoch"], st["batch_in_epoch"] = epoch + 1, 0
        ck.save_last(full_state(epoch + 1, 0, finished=done))
        last_ck = time.time()
        log_event(f"train {a.run} epoch {epoch + 1} select {m['select']:.4f} best {st['best']['select']:.4f}")
        if done:
            break
        if STOP["flag"]:
            return

    print("\n========= PASTE EVERYTHING BELOW BACK TO CLAUDE =========")
    print(f"run={a.run} config={chash} git={ghash} best_epoch={st['best']['epoch']} best_select_EER={100 * st['best']['select']:.2f}%")
    for r in st["history"]:
        d = r["dev"]
        print(f"  epoch {r['epoch']:2} step {r['opt_step']:5} " + " ".join(f"{s} {100 * d[s]['eer']:.2f}%" for s in TC["dev_sets"])
              + f"  ({r['train_min']}+{r['dev_min']} min){'  *' if r['improved'] else ''}")
    print("=========================================================")
    mark_done(f"p5_train_{a.run}", {"best": st["best"], "config_hash": chash})


def smoke_report(model, dev, ck, state, t_ep, seen, n_items):
    """Speed + memory + checkpoint round trip + Drive purge + short DEV pass. Leaves nothing behind."""
    import torch
    el = time.time() - t_ep
    rate = seen / el
    mem = torch.cuda.max_memory_allocated() / 1e9
    t = time.time()
    ck.save_last(state)
    t_save = time.time() - t
    saved, where = ck.load_last()
    cur = model.state_dict()
    same = saved is not None and set(saved["model"]) == set(cur) and all(
        torch.equal(saved["model"][k], v.detach().cpu()) for k, v in cur.items())
    opt_ok = saved is not None and len(saved["optimizer"]["state"]) > 0
    del saved
    m = dev_eval(model, dev, TC["dev_sets"], limit=64)
    for p in [ck.local_dir / ck.last_name, ck.drive_dir / ck.last_name]:
        p.unlink(missing_ok=True)
    purge = purge_trashed([ck.last_name])
    ep_min = n_items / rate / 60
    print("\n========= PASTE EVERYTHING BELOW BACK TO CLAUDE =========")
    print(f"SMOKE: {seen} clips in {el:.0f}s = {rate:.2f} clips/s (incl. worker start) | GPU peak {mem:.1f} GB")
    print(f"est. train time per epoch ~{ep_min:.0f} min (+ ~4 min DEV) -> 10 epochs ~{10 * (ep_min + 4) / 60:.1f} h")
    print(f"checkpoint: {where} | save {t_save:.0f}s | reload identical = {same} | optimizer state saved = {opt_ok}")
    print(f"Drive trash purge: {purge}")
    print(f"dev (64 clips each, after {state['opt_step']} steps): " + " | ".join(f"{s} EER {100 * m[s]['eer']:.1f}%" for s in TC["dev_sets"]))
    print("SMOKE:", "PASS" if same and opt_ok else "FAIL")
    print("=========================================================")


if __name__ == "__main__":
    main()
