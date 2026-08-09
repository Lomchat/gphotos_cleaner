"""Face detection and identity embeddings.

Detection reuses the same UltraFace model the extension ships, so a photo gets
the same answer whichever side analyses it. Embeddings use ArcFace (buffalo_l
r50), which is far too large to vendor and is therefore downloaded on first run.
"""

from __future__ import annotations

import io
import math
import os
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image

MODELS = Path(__file__).parent / "models"
VENDORED = Path(__file__).parent.parent / "extension" / "vendor" / "models"

# The detector is the very file the extension ships, not a copy: a backend that
# quietly drifted to a different detector would disagree with the panel about
# which photos contain a face, and nothing would say so.
DETECTOR = VENDORED / "ultraface-rfb320.onnx"
if not DETECTOR.exists():
    DETECTOR = MODELS / "ultraface-rfb320.onnx"

EMBEDDER = MODELS / "arcface_r50.onnx"
EMBEDDER_URL = "https://huggingface.co/immich-app/buffalo_l/resolve/main/recognition/model.onnx"

NET_W, NET_H = 320, 240
FACE_SIZE = 112  # ArcFace input

# Measured on the labelled set in tests/: at 0.6 a collar in two_people.jpg
# scores 0.625 and becomes a face, while every real face there scores 1.000.
# From 0.70 upwards the same set gives 13/13 real faces and no extras. A false
# positive here is worse than a miss: it seeds a junk person group.
DETECT_THRESHOLD = 0.75


def _session(path: Path) -> ort.InferenceSession:
    opts = ort.SessionOptions()
    opts.log_severity_level = 3
    # One thread per inference, parallelism across photos instead of inside one.
    # Measured on a 20-core machine, 512 px thumbnails, detection + embedding:
    #   default intra-op, 1 request at a time ..... 10.1 img/s
    #   default intra-op, 2 concurrent requests ....  6.2 img/s  (cores fight)
    #   intra_op=1, 16 concurrent requests ........  32.5 img/s
    # A lone request is slower this way, but the extension always sends batches.
    opts.intra_op_num_threads = 1
    return ort.InferenceSession(str(path), opts, providers=["CPUExecutionProvider"])


class FaceEngine:
    """Loads both models once and keeps them warm."""

    def __init__(self) -> None:
        if not DETECTOR.exists():
            raise FileNotFoundError(f"detector missing: {DETECTOR}")
        if not EMBEDDER.exists():
            raise FileNotFoundError(
                f"embedding model missing: {EMBEDDER}\n"
                f"Download it once with:  python -m backend.download_models"
            )
        self.det = _session(DETECTOR)
        self.emb = _session(EMBEDDER)
        self.emb_input = self.emb.get_inputs()[0].name
        self.emb_dim = self.emb.get_outputs()[0].shape[-1]

    # ---------------------------------------------------------------- detect

    def detect(self, image: Image.Image, threshold: float = DETECT_THRESHOLD) -> list[dict]:
        """Boxes in normalised [x1, y1, x2, y2], letterboxed like the extension."""
        tensor, pad = letterbox(image, NET_W, NET_H)
        scores, boxes = self.det.run(None, {self.det.get_inputs()[0].name: tensor})
        return decode(scores[0], boxes[0], pad, threshold)

    # ------------------------------------------------------------- embedding

    def embed(self, image: Image.Image, box: list[float]) -> np.ndarray:
        """Identity vector for one detected face.

        The crop is widened by 25%: ArcFace expects a little context around the
        face, and a box tight on the features alone measurably degrades the
        embedding.
        """
        crop = crop_face(image, box, margin=0.25, size=FACE_SIZE)
        arr = np.asarray(crop, dtype=np.float32)
        arr = (arr - 127.5) / 127.5
        arr = np.transpose(arr, (2, 0, 1))[None, ...]
        out = self.emb.run(None, {self.emb_input: arr})[0][0]
        norm = np.linalg.norm(out)
        return (out / norm if norm else out).astype(np.float32)

    def analyse(self, image: Image.Image, threshold: float = DETECT_THRESHOLD) -> list[dict]:
        faces = self.detect(image, threshold)
        for face in faces:
            face["embedding"] = self.embed(image, face["box"]).tolist()
        return faces


# ------------------------------------------------------------------ helpers


def letterbox(image: Image.Image, net_w: int, net_h: int):
    """Fit into the network input without distorting the aspect ratio."""
    rgb = image.convert("RGB")
    w, h = rgb.size
    scale = min(net_w / w, net_h / h)
    dw, dh = max(1, round(w * scale)), max(1, round(h * scale))
    ox, oy = (net_w - dw) // 2, (net_h - dh) // 2

    canvas = Image.new("RGB", (net_w, net_h), (127, 127, 127))
    canvas.paste(rgb.resize((dw, dh), Image.BILINEAR), (ox, oy))

    arr = np.asarray(canvas, dtype=np.float32)
    arr = (arr - 127.0) / 128.0
    arr = np.transpose(arr, (2, 0, 1))[None, ...]
    return arr, {"ox": ox, "oy": oy, "dw": dw, "dh": dh, "net_w": net_w, "net_h": net_h}


def decode(scores: np.ndarray, boxes: np.ndarray, pad: dict, threshold: float) -> list[dict]:
    """Threshold, suppress overlaps, and undo the letterbox padding."""
    keep = scores[:, 1] >= threshold
    cand = [
        {"box": boxes[i].astype(float).tolist(), "score": float(scores[i, 1])}
        for i in np.where(keep)[0]
    ]
    cand.sort(key=lambda c: -c["score"])

    kept: list[dict] = []
    for c in cand:
        if all(iou(c["box"], k["box"]) <= 0.35 for k in kept):
            kept.append(c)
        if len(kept) >= 64:
            break

    out = []
    for face in kept:
        x1, y1, x2, y2 = face["box"]
        nx1 = (x1 * pad["net_w"] - pad["ox"]) / pad["dw"]
        ny1 = (y1 * pad["net_h"] - pad["oy"]) / pad["dh"]
        nx2 = (x2 * pad["net_w"] - pad["ox"]) / pad["dw"]
        ny2 = (y2 * pad["net_h"] - pad["oy"]) / pad["dh"]
        box = [clamp01(nx1), clamp01(ny1), clamp01(nx2), clamp01(ny2)]
        if box[2] <= box[0] or box[3] <= box[1]:
            continue
        out.append({"box": box, "score": face["score"]})
    return out


def iou(a: list[float], b: list[float]) -> float:
    x1, y1 = max(a[0], b[0]), max(a[1], b[1])
    x2, y2 = min(a[2], b[2]), min(a[3], b[3])
    if x2 <= x1 or y2 <= y1:
        return 0.0
    inter = (x2 - x1) * (y2 - y1)
    area_a = max(0.0, a[2] - a[0]) * max(0.0, a[3] - a[1])
    area_b = max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


def crop_face(image: Image.Image, box: list[float], margin: float, size: int) -> Image.Image:
    """Square crop around a normalised box, padded to stay inside the image."""
    w, h = image.size
    x1, y1, x2, y2 = box[0] * w, box[1] * h, box[2] * w, box[3] * h
    cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
    half = max(x2 - x1, y2 - y1) * (1 + margin) / 2

    left, top = int(round(cx - half)), int(round(cy - half))
    right, bottom = int(round(cx + half)), int(round(cy + half))
    return image.convert("RGB").crop((left, top, right, bottom)).resize(
        (size, size), Image.BILINEAR
    )


def clamp01(v: float) -> float:
    return 0.0 if v < 0 else 1.0 if v > 1 else float(v)


def load_image(data: bytes) -> Image.Image:
    return Image.open(io.BytesIO(data))
