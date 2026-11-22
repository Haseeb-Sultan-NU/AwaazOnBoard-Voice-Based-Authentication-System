"""Shared helpers for the deepfake-defense pipeline (Colab-first).

Design rules (see docs/DEEPFAKE_TRACKER.md, "Colab & Drive operating manual"):
- Google Drive = durable storage (survives timeouts / account switches). Never train or
  read thousands of small files from it directly; it is slow.
- /content (Colab local SSD) = fast scratch. Anything there is lost on disconnect.
- Every write to Drive is atomic: write `<name>.partial`, then os.replace -> `<name>`.
  A half-written file therefore never looks complete after a timeout.
- Finished steps leave a marker JSON in <drive>/state/<step>.done, so re-running a cell is safe.
"""
from __future__ import annotations

import datetime as _dt
import hashlib
import json
import os
import shutil
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = REPO_ROOT / "deepfake" / "config.json"


def load_config() -> dict:
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


CFG = load_config()
DRIVE = Path(CFG["paths"]["drive_root"])
LOCAL = Path(CFG["paths"]["local_root"])


def now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def ensure_dirs() -> None:
    for d in CFG["paths"]["drive_subdirs"]:
        (DRIVE / d).mkdir(parents=True, exist_ok=True)
    for d in CFG["paths"]["local_subdirs"]:
        (LOCAL / d).mkdir(parents=True, exist_ok=True)


def sha256_file(path: os.PathLike, chunk: int = 8 * 1024 * 1024) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            b = f.read(chunk)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def atomic_copy(src: os.PathLike, dst: os.PathLike) -> None:
    """Copy src -> dst so dst only ever appears complete."""
    dst = Path(dst)
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name(dst.name + ".partial")
    if tmp.exists():
        tmp.unlink()
    shutil.copyfile(src, tmp)
    os.replace(tmp, dst)


def atomic_write_json(obj, dst: os.PathLike) -> None:
    dst = Path(dst)
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name(dst.name + ".partial")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)
    os.replace(tmp, dst)


def marker_path(step: str) -> Path:
    return DRIVE / "state" / f"{step}.done"


def is_done(step: str) -> bool:
    return marker_path(step).exists()


def mark_done(step: str, info: dict | None = None) -> None:
    atomic_write_json({"step": step, "finished_utc": now(), **(info or {})}, marker_path(step))


def read_marker(step: str) -> dict | None:
    p = marker_path(step)
    if not p.exists():
        return None
    with open(p, "r", encoding="utf-8") as f:
        return json.load(f)


def log_event(msg: str) -> None:
    """Append one line to the Drive session log (survives account switches)."""
    line = f"{now()}\t{msg}\n"
    print(msg)
    try:
        (DRIVE / "logs").mkdir(parents=True, exist_ok=True)
        with open(DRIVE / "logs" / "events.log", "a", encoding="utf-8") as f:
            f.write(line)
    except OSError:
        pass


def purge_trashed(names: list[str]) -> str:
    """Permanently delete OUR trashed checkpoint files (exact names, owned by the mounted account).
    Needed because overwriting a file on mounted Drive moves the old copy to Trash, where it still uses quota
    (a 3.9 GB checkpoint every 30 min would fill 15 GB in a few hours). Never touches anything else in Trash.
    Requires `from google.colab import auth; auth.authenticate_user()` in the notebook first; best-effort."""
    try:
        import google.auth
        from googleapiclient.discovery import build
        creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/drive"])
        svc = build("drive", "v3", credentials=creds, cache_discovery=False)
        n = 0
        for name in names:
            q = f"name = '{name}' and trashed = true and 'me' in owners"
            for f in svc.files().list(q=q, fields="files(id,name)", pageSize=100).execute().get("files", []):
                svc.files().delete(fileId=f["id"]).execute()
                n += 1
        return f"ok ({n} purged)"
    except Exception as e:  # noqa: BLE001
        return f"UNAVAILABLE ({type(e).__name__}: {str(e)[:120]})"
