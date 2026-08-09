"""Fetch the ArcFace recognition model.

The detector is vendored with the extension (1.2 MB). The recognition model is
166 MB, which is too large for a git repository, so it is downloaded once into
``backend/models/`` and never again.

    python -m backend.download_models
"""

from __future__ import annotations

import hashlib
import sys
import urllib.request
from pathlib import Path

MODELS = Path(__file__).parent / "models"
TARGET = MODELS / "arcface_r50.onnx"
URL = "https://huggingface.co/immich-app/buffalo_l/resolve/main/recognition/model.onnx"
EXPECTED_BYTES = 174383860


def download(url: str = URL, target: Path = TARGET) -> Path:
    if target.exists() and target.stat().st_size == EXPECTED_BYTES:
        print(f"already present: {target}")
        return target

    MODELS.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(".part")
    print(f"downloading {url}\n         -> {target}")

    with urllib.request.urlopen(url) as response, tmp.open("wb") as out:
        total = int(response.headers.get("content-length") or 0)
        done = 0
        digest = hashlib.sha256()
        while chunk := response.read(1 << 20):
            out.write(chunk)
            digest.update(chunk)
            done += len(chunk)
            if total:
                print(f"\r  {done / 1e6:7.1f} / {total / 1e6:.1f} MB", end="", flush=True)
    print()

    if total and done != total:
        tmp.unlink(missing_ok=True)
        raise RuntimeError(f"truncated download: {done} of {total} bytes")

    # Written to a .part first so an interrupted run never leaves a half model
    # that loads and then produces silent nonsense.
    tmp.replace(target)
    print(f"done, sha256 {digest.hexdigest()[:16]}...")
    return target


if __name__ == "__main__":
    try:
        download()
    except Exception as exc:  # noqa: BLE001
        print(f"failed: {exc}", file=sys.stderr)
        sys.exit(1)
