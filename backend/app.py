"""Optional local analysis server.

The extension works without this. What the backend adds is the one thing a
thumbnail cannot give you: identity. It embeds each detected face and groups
the library by person, so "everything without Grandma in it" becomes a filter.

It listens on 127.0.0.1 only, and nothing ever leaves the machine.

    python -m backend.app          # http://127.0.0.1:8765
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import binascii
import os
import re
import secrets
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlparse

import numpy as np
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .cluster import assign_to_groups, cluster_faces, group_summary
from .faces import DETECT_THRESHOLD, FaceEngine, load_image
from .store import DATA_DIR, Store

MAX_BYTES = 12 * 1024 * 1024
FETCH_TIMEOUT = 15

# Each session runs single-threaded (see faces._session), so throughput comes
# from running many photos at once. Measured on 20 cores the curve is flat past
# 16 threads: 24.1 img/s at 8, 32.5 at 16, 32.3 at 20.
WORKERS = min(16, max(2, os.cpu_count() or 4))

# Thumbnail URLs are supplied by a web page, so the server must not be usable
# as a probe for anything else on the network. Only Google's photo CDNs.
ALLOWED_HOST_SUFFIXES = (
    ".googleusercontent.com",
    ".usercontent.google.com",
    ".ggpht.com",
    ".google.com",
)

TOKEN_FILE = DATA_DIR / "token"

# The extension is served from photos.google.com or from a chrome-extension://
# origin. Anything else has no business driving this server, so extra origins
# must be named on purpose — for a Firefox port, a different extension id, or a
# harness page during development.
DEFAULT_ORIGIN_REGEX = r"^(https://photos\.google\.com|chrome-extension://[a-p]+)$"


def origin_regex(extra: str = "") -> str:
    """Widen the allowed origins with a comma-separated list of exact origins."""
    names = [o.strip() for o in extra.split(",") if o.strip()]
    if not names:
        return DEFAULT_ORIGIN_REGEX
    escaped = "|".join(re.escape(o) for o in names)
    return DEFAULT_ORIGIN_REGEX[:-2] + "|" + escaped + ")$"


# --------------------------------------------------------------------- models


class Item(BaseModel):
    photoId: str
    url: str | None = None
    data: str | None = None  # base64 JPEG/PNG, for when the URL is not fetchable


class AnalyseRequest(BaseModel):
    items: list[Item] = Field(default_factory=list, max_length=256)
    threshold: float = DETECT_THRESHOLD
    force: bool = False


class GroupRequest(BaseModel):
    eps: float = 0.55
    minSamples: int = 2
    incremental: bool = True


class NameRequest(BaseModel):
    name: str | None = None


class KnownRequest(BaseModel):
    photoIds: list[str] = Field(default_factory=list)


# ---------------------------------------------------------------- app wiring


def read_or_create_token() -> str:
    """A shared secret so only the extension can drive this server.

    Without it, any page open in the browser could POST to localhost. CORS
    would hide the response, but a blind write that wipes the user's named
    groups is damage enough.
    """
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if TOKEN_FILE.exists():
        existing = TOKEN_FILE.read_text(encoding="utf-8").strip()
        if existing:
            return existing
    token = secrets.token_urlsafe(24)
    TOKEN_FILE.write_text(token, encoding="utf-8")
    return token


def create_app(store: Store | None = None, engine_factory=FaceEngine,
               token: str | None = None, extra_origins: str = "") -> FastAPI:
    app = FastAPI(title="Photo Cleaner backend", version="1.0.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=origin_regex(extra_origins or os.environ.get("CLEANER_ORIGINS", "")),
        allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def allow_private_network(request, call_next):
        """Answer Chrome's Private Network Access preflight.

        photos.google.com is a public origin and 127.0.0.1 is a private one, so
        Chrome sends an extra preflight before letting the page reach this
        server. Without this header the browser blocks every request and the
        panel sees a plain network error with nothing to explain it.

        (http://127.0.0.1 is exempt from mixed-content blocking, which is why
        the server does not need TLS.)
        """
        response = await call_next(request)
        if request.headers.get("access-control-request-private-network") == "true":
            response.headers["Access-Control-Allow-Private-Network"] = "true"
        return response

    app.state.store = store or Store()
    app.state.token = token if token is not None else read_or_create_token()
    app.state.engine = None
    app.state.engine_error = None
    app.state.pool = ThreadPoolExecutor(max_workers=WORKERS, thread_name_prefix="infer")

    def engine() -> FaceEngine:
        """Loaded on first use: 166 MB of weights should not block startup."""
        if app.state.engine is None:
            if app.state.engine_error:
                raise HTTPException(503, app.state.engine_error)
            try:
                app.state.engine = engine_factory()
            except Exception as exc:  # noqa: BLE001
                app.state.engine_error = str(exc)
                raise HTTPException(503, str(exc)) from exc
        return app.state.engine

    def require_token(x_cleaner_token: str = Header(default="")) -> None:
        if not app.state.token:
            return
        if not secrets.compare_digest(x_cleaner_token, app.state.token):
            raise HTTPException(401, "bad or missing X-Cleaner-Token")

    guard = [Depends(require_token)]

    # ------------------------------------------------------------- health

    @app.get("/health")
    def health() -> dict:
        """Unauthenticated on purpose: the extension needs to discover the
        server before the user has pasted a token."""
        return {
            "status": "ok",
            "version": app.version,
            "modelReady": app.state.engine is not None,
            "modelError": app.state.engine_error,
            "authRequired": bool(app.state.token),
            "stats": app.state.store.stats(),
        }

    # ------------------------------------------------------------ analyse

    @app.post("/known", dependencies=guard)
    def known(req: KnownRequest) -> dict:
        return {"known": sorted(app.state.store.known_ids(req.photoIds))}

    @app.post("/analyse", dependencies=guard)
    async def analyse(req: AnalyseRequest) -> dict:
        eng = engine()
        store = app.state.store
        skip = set() if req.force else store.known_ids([i.photoId for i in req.items])

        started = time.perf_counter()
        loop = asyncio.get_running_loop()
        todo = [i for i in req.items if i.photoId not in skip]
        results = await asyncio.gather(
            *(loop.run_in_executor(app.state.pool, _analyse_one, eng, store, i, req.threshold)
              for i in todo)
        )

        return {
            "analysed": [r for r in results if r["error"] is None],
            "failed": [r for r in results if r["error"] is not None],
            "skipped": sorted(skip),
            "elapsedMs": round((time.perf_counter() - started) * 1000),
        }

    @app.get("/photos/{photo_id}", dependencies=guard)
    def photo(photo_id: str) -> dict:
        found = app.state.store.get_photo(photo_id)
        if found is None:
            raise HTTPException(404, "not analysed")
        return found

    # ------------------------------------------------------------- groups

    @app.post("/group", dependencies=guard)
    def group(req: GroupRequest) -> dict:
        store = app.state.store

        if req.incremental:
            gids, centroids = store.group_centroids()
            if len(gids):
                # Attach newcomers to existing people first, so a rescan does
                # not renumber groups the user has already named.
                face_ids, vecs = store.ungrouped_embeddings()
                if len(face_ids):
                    assigned = assign_to_groups(vecs, centroids)
                    for slot, gid in enumerate(gids):
                        members = [face_ids[i] for i in np.where(assigned == slot)[0]]
                        if members:
                            store.set_group(members, gid)
                return {"mode": "incremental", "groups": store.list_groups()}

        ids, vecs = store.all_embeddings()
        if len(ids) < req.minSamples:
            return {"mode": "full", "groups": [], "note": "not enough faces yet"}

        labels = cluster_faces(vecs, eps=req.eps, min_samples=req.minSamples)
        summaries = group_summary(labels, vecs)
        store.replace_groups(summaries, ids)
        return {"mode": "full", "groups": store.list_groups()}

    @app.get("/groups", dependencies=guard)
    def groups() -> dict:
        return {"groups": app.state.store.list_groups()}

    @app.get("/groups/{group_id}/photos", dependencies=guard)
    def group_photos(group_id: int) -> dict:
        return {"groupId": group_id, "photoIds": app.state.store.group_photos(group_id)}

    @app.post("/groups/{group_id}/name", dependencies=guard)
    def name_group(group_id: int, req: NameRequest) -> dict:
        if not app.state.store.rename_group(group_id, req.name):
            raise HTTPException(404, "no such group")
        return {"groupId": group_id, "name": req.name}

    # -------------------------------------------------------------- reset

    @app.delete("/data", dependencies=guard)
    def reset() -> dict:
        app.state.store.reset()
        return {"status": "cleared", "stats": app.state.store.stats()}

    return app


# ------------------------------------------------------------------ workers


def _analyse_one(eng: FaceEngine, store: Store, item: Item, threshold: float) -> dict:
    try:
        raw = _load_bytes(item)
        image = load_image(raw)
        image.load()
        faces = eng.analyse(image, threshold)
    except Exception as exc:  # noqa: BLE001
        store.save_photo(item.photoId, None, [], error=str(exc)[:300])
        return {"photoId": item.photoId, "error": str(exc)[:300]}

    store.save_photo(item.photoId, image.size, faces)
    return {
        "photoId": item.photoId,
        "width": image.size[0],
        "height": image.size[1],
        "faceCount": len(faces),
        "faces": [{"box": f["box"], "score": f["score"]} for f in faces],
        "error": None,
    }


def _load_bytes(item: Item) -> bytes:
    if item.data:
        payload = item.data.split(",", 1)[-1] if item.data.startswith("data:") else item.data
        try:
            return base64.b64decode(payload, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise ValueError("invalid base64 data") from exc
    if not item.url:
        raise ValueError("item needs url or data")
    return _fetch(item.url)


def _fetch(url: str) -> bytes:
    parsed = urlparse(url)
    if parsed.scheme != "https":
        raise ValueError("only https urls are fetched")
    host = parsed.hostname or ""
    if not any(host == s.lstrip(".") or host.endswith(s) for s in ALLOWED_HOST_SUFFIXES):
        raise ValueError(f"host not allowed: {host}")

    request = urllib.request.Request(url, headers={"User-Agent": "photo-cleaner-backend/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=FETCH_TIMEOUT) as response:
            # Read one byte past the cap so an oversized image is rejected
            # rather than silently truncated into a corrupt decode.
            body = response.read(MAX_BYTES + 1)
    except urllib.error.URLError as exc:
        raise ValueError(f"fetch failed: {exc.reason}") from exc
    if len(body) > MAX_BYTES:
        raise ValueError("image larger than 12 MB")
    if not body:
        raise ValueError("empty response")
    return body


# --------------------------------------------------------------------- main


def main() -> None:
    parser = argparse.ArgumentParser(description="Photo Cleaner local backend")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-auth", action="store_true", help="disable the token check")
    parser.add_argument("--allow-origin", default="", metavar="ORIGIN[,ORIGIN]",
                        help="extra browser origins allowed to call this server")
    args = parser.parse_args()

    import uvicorn

    token = "" if args.no_auth else read_or_create_token()
    app = create_app(token=token, extra_origins=args.allow_origin)

    print("\n  Photo Cleaner backend")
    print(f"  http://{args.host}:{args.port}")
    if token:
        print(f"  token: {token}")
        print("  paste it into the extension panel, People tab")
    else:
        print("  running without a token (--no-auth)")
    print(f"  data:  {DATA_DIR}\n")

    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
