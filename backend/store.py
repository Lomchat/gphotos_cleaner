"""SQLite persistence for analysed photos, faces and people groups.

Everything lives in one file under ``backend/data/`` so "delete my data" is
``rm -r backend/data``. Embeddings are stored as raw float32 blobs rather than
JSON: 512 floats is 2 KB packed against ~10 KB of text, and a library with
50k faces is the difference between 100 MB and 500 MB.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path

import numpy as np

DATA_DIR = Path(__file__).parent / "data"
DB_PATH = DATA_DIR / "cleaner.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS photos (
  photo_id   TEXT PRIMARY KEY,
  width      INTEGER,
  height     INTEGER,
  face_count INTEGER NOT NULL DEFAULT 0,
  analysed_at REAL NOT NULL,
  error      TEXT
);

CREATE TABLE IF NOT EXISTS faces (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  photo_id  TEXT NOT NULL REFERENCES photos(photo_id) ON DELETE CASCADE,
  box       TEXT NOT NULL,
  score     REAL NOT NULL,
  embedding BLOB NOT NULL,
  group_id  INTEGER
);
CREATE INDEX IF NOT EXISTS faces_photo ON faces(photo_id);
CREATE INDEX IF NOT EXISTS faces_group ON faces(group_id);

CREATE TABLE IF NOT EXISTS groups (
  id         INTEGER PRIMARY KEY,
  name       TEXT,
  centroid   BLOB NOT NULL,
  size       INTEGER NOT NULL,
  spread     REAL NOT NULL,
  updated_at REAL NOT NULL
);
"""


def pack(vector) -> bytes:
    return np.asarray(vector, dtype=np.float32).tobytes()


def unpack(blob: bytes) -> np.ndarray:
    return np.frombuffer(blob, dtype=np.float32)


class Store:
    def __init__(self, path: Path | str = DB_PATH) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # The API analyses photos on a thread pool, so this connection is used
        # from several threads. sqlite3 allows that with check_same_thread off,
        # but interleaved transactions on one connection raise "API misuse" —
        # so every access goes through the lock. Writes take microseconds
        # against ~50 ms of inference, so serialising them costs nothing.
        self._lock = threading.RLock()
        self.db = sqlite3.connect(self.path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys = ON")
        self.db.execute("PRAGMA journal_mode = WAL")
        self.db.executescript(SCHEMA)
        self.db.commit()

    def close(self) -> None:
        with self._lock:
            self.db.close()

    # ---------------------------------------------------------------- photos

    def save_photo(self, photo_id: str, size: tuple[int, int] | None, faces: list[dict],
                   error: str | None = None) -> None:
        """Replace everything known about one photo.

        Re-analysing must not accumulate duplicate faces, so the old rows go
        first. Group assignments are lost with them, which is correct: the
        faces themselves have changed.
        """
        with self._lock:
            w, h = size or (None, None)
            with self.db:
                self.db.execute("DELETE FROM faces WHERE photo_id = ?", (photo_id,))
                self.db.execute(
                    "INSERT OR REPLACE INTO photos"
                    " (photo_id, width, height, face_count, analysed_at, error)"
                    " VALUES (?, ?, ?, ?, ?, ?)",
                    (photo_id, w, h, len(faces), time.time(), error),
                )
                self.db.executemany(
                    "INSERT INTO faces (photo_id, box, score, embedding) VALUES (?, ?, ?, ?)",
                    [
                        (photo_id, json.dumps(f["box"]), float(f["score"]), pack(f["embedding"]))
                        for f in faces
                    ],
                )

    def get_photo(self, photo_id: str) -> dict | None:
        with self._lock:
            row = self.db.execute("SELECT * FROM photos WHERE photo_id = ?", (photo_id,)).fetchone()
            if row is None:
                return None
            faces = self.db.execute(
                "SELECT id, box, score, group_id FROM faces WHERE photo_id = ? ORDER BY id",
                (photo_id,),
            ).fetchall()
            return {
                "photoId": row["photo_id"],
                "width": row["width"],
                "height": row["height"],
                "faceCount": row["face_count"],
                "analysedAt": row["analysed_at"],
                "error": row["error"],
                "faces": [
                    {
                        "id": f["id"],
                        "box": json.loads(f["box"]),
                        "score": f["score"],
                        "groupId": f["group_id"],
                    }
                    for f in faces
                ],
            }

    def known_ids(self, photo_ids: list[str]) -> set[str]:
        """Which of these are already analysed — lets the client skip re-sending."""
        with self._lock:
            found: set[str] = set()
            for i in range(0, len(photo_ids), 500):  # SQLite caps variables per statement
                chunk = photo_ids[i : i + 500]
                marks = ",".join("?" * len(chunk))
                rows = self.db.execute(
                    f"SELECT photo_id FROM photos WHERE error IS NULL AND photo_id IN ({marks})",
                    chunk,
                ).fetchall()
                found.update(r["photo_id"] for r in rows)
            return found

    # ----------------------------------------------------------------- faces

    def all_embeddings(self) -> tuple[list[int], np.ndarray]:
        with self._lock:
            rows = self.db.execute("SELECT id, embedding FROM faces ORDER BY id").fetchall()
            if not rows:
                return [], np.empty((0, 0), dtype=np.float32)
            ids = [r["id"] for r in rows]
            vecs = np.stack([unpack(r["embedding"]) for r in rows])
            return ids, vecs

    def ungrouped_embeddings(self) -> tuple[list[int], np.ndarray]:
        with self._lock:
            rows = self.db.execute(
                "SELECT id, embedding FROM faces WHERE group_id IS NULL ORDER BY id"
            ).fetchall()
            if not rows:
                return [], np.empty((0, 0), dtype=np.float32)
            return [r["id"] for r in rows], np.stack([unpack(r["embedding"]) for r in rows])

    def set_group(self, face_ids: list[int], group_id: int | None) -> None:
        with self._lock:
            with self.db:
                self.db.executemany(
                    "UPDATE faces SET group_id = ? WHERE id = ?",
                    [(group_id, fid) for fid in face_ids],
                )

    # ---------------------------------------------------------------- groups

    def replace_groups(self, summaries: list[dict], face_ids: list[int]) -> None:
        """Write a fresh clustering result, keeping any names already given.

        Group ids from DBSCAN are arbitrary and change between runs, so a name
        is carried over by matching the new group against the old centroids
        rather than by id.
        """
        with self._lock:
            old = {
                r["id"]: (r["name"], unpack(r["centroid"]))
                for r in self.db.execute("SELECT id, name, centroid FROM groups").fetchall()
                if r["name"]
            }
            with self.db:
                self.db.execute("UPDATE faces SET group_id = NULL")
                self.db.execute("DELETE FROM groups")
                now = time.time()
                for summary in summaries:
                    gid = summary["group"]
                    centroid = np.asarray(summary["centroid"], dtype=np.float32)
                    name = _closest_name(centroid, old)
                    self.db.execute(
                        "INSERT INTO groups (id, name, centroid, size, spread, updated_at)"
                        " VALUES (?, ?, ?, ?, ?, ?)",
                        (gid, name, pack(centroid), summary["size"], summary["spread"], now),
                    )
                    self.db.executemany(
                        "UPDATE faces SET group_id = ? WHERE id = ?",
                        [(gid, face_ids[m]) for m in summary["members"]],
                    )

    def list_groups(self, cover: int = 4) -> list[dict]:
        with self._lock:
            rows = self.db.execute("SELECT * FROM groups ORDER BY size DESC").fetchall()
            out = []
            for row in rows:
                photos = self.db.execute(
                    "SELECT DISTINCT photo_id FROM faces WHERE group_id = ? LIMIT ?",
                    (row["id"], cover),
                ).fetchall()
                out.append(
                    {
                        "id": row["id"],
                        "name": row["name"],
                        "size": row["size"],
                        "spread": row["spread"],
                        "cover": [p["photo_id"] for p in photos],
                    }
                )
            return out

    def group_photos(self, group_id: int) -> list[str]:
        with self._lock:
            rows = self.db.execute(
                "SELECT DISTINCT photo_id FROM faces WHERE group_id = ? ORDER BY photo_id",
                (group_id,),
            ).fetchall()
            return [r["photo_id"] for r in rows]

    def rename_group(self, group_id: int, name: str | None) -> bool:
        with self._lock:
            with self.db:
                cur = self.db.execute("UPDATE groups SET name = ? WHERE id = ?", (name, group_id))
            return cur.rowcount > 0

    def group_centroids(self) -> tuple[list[int], np.ndarray]:
        with self._lock:
            rows = self.db.execute("SELECT id, centroid FROM groups ORDER BY id").fetchall()
            if not rows:
                return [], np.empty((0, 0), dtype=np.float32)
            return [r["id"] for r in rows], np.stack([unpack(r["centroid"]) for r in rows])

    # ------------------------------------------------------------------ misc

    def stats(self) -> dict:
        with self._lock:
            one = lambda sql: self.db.execute(sql).fetchone()[0]  # noqa: E731
            return {
                "photos": one("SELECT COUNT(*) FROM photos"),
                "faces": one("SELECT COUNT(*) FROM faces"),
                "groups": one("SELECT COUNT(*) FROM groups"),
                "grouped": one("SELECT COUNT(*) FROM faces WHERE group_id IS NOT NULL"),
                "errors": one("SELECT COUNT(*) FROM photos WHERE error IS NOT NULL"),
            }

    def reset(self) -> None:
        with self._lock:
            with self.db:
                self.db.execute("DELETE FROM faces")
                self.db.execute("DELETE FROM groups")
                self.db.execute("DELETE FROM photos")


def _closest_name(centroid: np.ndarray, old: dict[int, tuple[str, np.ndarray]]) -> str | None:
    """Carry a name over when the new group is clearly the same person."""
    best_name, best_dist = None, 1e9
    for name, vec in old.values():
        if vec.shape != centroid.shape:
            continue
        denom = np.linalg.norm(vec) * np.linalg.norm(centroid)
        if denom == 0:
            continue
        dist = 1.0 - float(np.dot(vec, centroid) / denom)
        if dist < best_dist:
            best_name, best_dist = name, dist
    return best_name if best_dist <= 0.35 else None
