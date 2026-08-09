"""Grouping face embeddings into people.

Pure functions over numpy arrays: no I/O, no model, no database. This is the
part where a mistake is invisible — two people merged into one group looks
exactly like a working feature until you open it — so it is kept separate and
tested on its own.
"""

from __future__ import annotations

import numpy as np


def l2_normalise(vectors: np.ndarray) -> np.ndarray:
    """Project embeddings onto the unit sphere.

    ArcFace is trained with an angular margin, so only direction carries
    identity. Skipping this makes cosine distance depend on vector length, and
    brightly lit faces drift away from dim ones for no reason.
    """
    v = np.asarray(vectors, dtype=np.float32)
    if v.ndim == 1:
        v = v[None, :]
    norms = np.linalg.norm(v, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return v / norms


def cosine_distances(vectors: np.ndarray) -> np.ndarray:
    """Pairwise cosine distance matrix, in [0, 2]."""
    unit = l2_normalise(vectors)
    sim = np.clip(unit @ unit.T, -1.0, 1.0)
    return 1.0 - sim


def cluster_faces(
    vectors: np.ndarray,
    eps: float = 0.55,
    min_samples: int = 2,
) -> np.ndarray:
    """Group embeddings by identity.

    DBSCAN rather than k-means: the number of people is unknown, groups are
    wildly unbalanced (hundreds of photos of a partner, one of a stranger), and
    a face that matches nobody must be allowed to stay ungrouped instead of
    being forced into the nearest cluster.

    ``eps`` is a cosine distance. 0.55 is the usual working point for ArcFace
    embeddings; lower splits one person into several groups, higher starts
    merging different people — which is the failure that matters, because a
    merged group invites deleting the wrong person's photos.

    :returns: label per row, ``-1`` meaning "belongs to nobody".
    """
    from sklearn.cluster import DBSCAN

    v = np.asarray(vectors, dtype=np.float32)
    if v.ndim == 1:
        v = v[None, :]
    if len(v) == 0:
        return np.empty(0, dtype=int)
    if len(v) == 1:
        return np.array([-1], dtype=int)

    unit = l2_normalise(v)
    labels = DBSCAN(eps=eps, min_samples=min_samples, metric="cosine").fit(unit).labels_
    return labels.astype(int)


def group_summary(labels: np.ndarray, vectors: np.ndarray) -> list[dict]:
    """Describe each group: size, centroid, and internal spread.

    ``spread`` is the mean distance to the centroid. A high value on a large
    group is the signature of a merge — two people pulled together — and is the
    number to look at before trusting a group.
    """
    labels = np.asarray(labels)
    unit = l2_normalise(vectors)
    out = []
    for label in sorted(set(labels.tolist())):
        if label < 0:
            continue
        members = np.where(labels == label)[0]
        centroid = unit[members].mean(axis=0)
        norm = np.linalg.norm(centroid)
        centroid = centroid / norm if norm else centroid
        spread = float(np.mean(1.0 - np.clip(unit[members] @ centroid, -1.0, 1.0)))
        out.append(
            {
                "group": int(label),
                "size": int(len(members)),
                "members": members.tolist(),
                "centroid": centroid.astype(float).tolist(),
                "spread": round(spread, 4),
            }
        )
    out.sort(key=lambda g: -g["size"])
    return out


def assign_to_groups(
    vectors: np.ndarray,
    centroids: np.ndarray,
    max_distance: float = 0.5,
) -> np.ndarray:
    """Attach new faces to existing groups without re-clustering everything.

    Re-running DBSCAN over the whole library after every scan would renumber
    every group and undo any naming the user has done. New faces are matched
    against stored centroids instead, and anything too far away stays ungrouped
    rather than being forced into the closest match.
    """
    v = l2_normalise(vectors)
    if len(centroids) == 0:
        return np.full(len(v), -1, dtype=int)
    c = l2_normalise(centroids)
    sim = v @ c.T
    best = np.argmax(sim, axis=1)
    dist = 1.0 - sim[np.arange(len(v)), best]
    return np.where(dist <= max_distance, best, -1).astype(int)
