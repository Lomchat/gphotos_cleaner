"""End-to-end check against photographs whose subjects are known.

Everything else in this suite runs on synthetic vectors, which proves the code
does what it was written to do but says nothing about whether the models are
wired up correctly. A transposed tensor, a wrong normalisation, a crop off by a
quarter still produce plausible-looking numbers. Only labelled photographs
catch that.

The fixtures are downloaded on first run from the face_recognition examples,
where each file's subject is documented. They are not committed: photographs of
real people do not belong in this repository.

Skipped when the model or the network is unavailable, so a plain checkout still
runs green.
"""

from __future__ import annotations

import urllib.error
import urllib.request
from pathlib import Path

import numpy as np
import pytest

from backend.cluster import cluster_faces, group_summary, l2_normalise
from backend.faces import EMBEDDER, FaceEngine

FIXTURES = Path(__file__).parent / "fixtures"
BASE = "https://raw.githubusercontent.com/ageitgey/face_recognition/master/examples"

# local name -> (remote name, subject of each face, left to right)
PHOTOS = {
    "obama_a.jpg": ("obama.jpg", ["obama"]),
    "obama_b.jpg": ("obama2.jpg", ["obama"]),
    "obama_small.jpg": ("obama_small.jpg", ["obama"]),
    "biden.jpg": ("biden.jpg", ["biden"]),
    "two_people.jpg": ("two_people.jpg", ["obama", "biden"]),
}


def fetch_fixtures() -> None:
    FIXTURES.mkdir(parents=True, exist_ok=True)
    for local, (remote, _) in PHOTOS.items():
        target = FIXTURES / local
        if target.exists() and target.stat().st_size > 1000:
            continue
        try:
            with urllib.request.urlopen(f"{BASE}/{remote}", timeout=30) as response:
                body = response.read()
        except (urllib.error.URLError, TimeoutError) as exc:
            pytest.skip(f"fixtures unavailable: {exc}")
        if not body.startswith(b"\xff\xd8"):
            pytest.skip(f"{remote} did not come back as a JPEG")
        target.write_bytes(body)


@pytest.fixture(scope="module")
def embedded():
    """(vectors, subjects, sources) for every face in the labelled set."""
    if not EMBEDDER.exists():
        pytest.skip("run `python -m backend.download_models` to enable this test")
    fetch_fixtures()

    from PIL import Image

    engine = FaceEngine()
    vectors, subjects, sources, counts = [], [], [], {}
    for local, (_, expected) in PHOTOS.items():
        image = Image.open(FIXTURES / local)
        faces = engine.detect(image)
        faces.sort(key=lambda f: f["box"][0])
        counts[local] = (len(faces), len(expected))
        for face, subject in zip(faces, expected):
            vectors.append(engine.embed(image, face["box"]))
            subjects.append(subject)
            sources.append(f"{local}:{subject}")
    return np.array(vectors), np.array(subjects), sources, counts


@pytest.fixture(scope="module")
def gaps(embedded):
    vectors, subjects, _, _ = embedded
    unit = l2_normalise(vectors)
    dist = 1.0 - np.clip(unit @ unit.T, -1.0, 1.0)
    same = np.array([[a == b for b in subjects] for a in subjects])
    off = ~np.eye(len(vectors), dtype=bool)
    return dist[same & off], dist[~same & off]


class TestDetection:
    def test_every_photo_yields_exactly_the_faces_it_contains(self, embedded):
        _, _, _, counts = embedded
        wrong = {k: v for k, v in counts.items() if v[0] != v[1]}
        assert not wrong, f"got (found, expected): {wrong}"


class TestEmbeddings:
    def test_vectors_have_the_documented_width(self, embedded):
        vectors, _, _, _ = embedded
        assert vectors.shape[1] == 512

    def test_vectors_are_unit_length(self, embedded):
        vectors, _, _, _ = embedded
        assert np.allclose(np.linalg.norm(vectors, axis=1), 1.0, atol=1e-4)

    def test_a_downscaled_copy_embeds_almost_identically(self, embedded):
        # obama_small.jpg is obama.jpg at 320x240 — the thumbnail case.
        _, _, sources, _ = embedded
        vectors, _, _, _ = embedded
        i = sources.index("obama_a.jpg:obama")
        j = sources.index("obama_small.jpg:obama")
        assert 1 - float(np.dot(vectors[i], vectors[j])) < 0.15

    def test_the_same_person_stays_close_across_photos(self, gaps):
        same, _ = gaps
        assert same.max() < 0.55, f"worst same-person distance {same.max():.3f}"

    def test_different_people_stay_far_apart(self, gaps):
        _, different = gaps
        assert different.min() > 0.55, f"closest stranger pair {different.min():.3f}"

    def test_the_two_distributions_do_not_touch(self, gaps):
        same, different = gaps
        margin = different.min() - same.max()
        assert margin > 0.2, f"only {margin:.3f} between same and different"


class TestGrouping:
    def test_one_group_per_person(self, embedded):
        vectors, subjects, _, _ = embedded
        groups = group_summary(cluster_faces(vectors), vectors)
        assert len(groups) == len(set(subjects.tolist()))

    def test_no_group_mixes_two_people(self, embedded):
        vectors, subjects, _, _ = embedded
        for group in group_summary(cluster_faces(vectors), vectors):
            assert len(set(subjects[group["members"]].tolist())) == 1

    def test_every_face_is_placed(self, embedded):
        vectors, _, _, _ = embedded
        assert (cluster_faces(vectors) == -1).sum() == 0

    def test_the_default_eps_sits_inside_the_gap(self, gaps):
        # If this ever fails, the 0.55 default needs revisiting, not the test.
        same, different = gaps
        assert same.max() < 0.55 < different.min()
