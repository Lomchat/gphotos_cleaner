"""Persistence. The interesting cases are re-analysis and renaming survival."""

import numpy as np
import pytest

from backend.cluster import cluster_faces, group_summary
from backend.store import Store, pack, unpack


@pytest.fixture
def store(tmp_path):
    s = Store(tmp_path / "test.db")
    yield s
    s.close()


def face(vector, score=0.9, box=(0.1, 0.1, 0.3, 0.3)):
    return {"box": list(box), "score": score, "embedding": list(vector)}


def direction(seed, dim=32, jitter=0.03, n=1):
    rng = np.random.default_rng(seed)
    centre = rng.normal(size=dim)
    centre /= np.linalg.norm(centre)
    out = []
    for _ in range(n):
        v = centre + rng.normal(scale=jitter, size=dim)
        out.append((v / np.linalg.norm(v)).astype(np.float32))
    return out


class TestPacking:
    def test_round_trip_preserves_values(self):
        v = np.array([0.5, -0.25, 1.0], dtype=np.float32)
        assert np.array_equal(unpack(pack(v)), v)

    def test_blob_is_four_bytes_per_float(self):
        assert len(pack(np.zeros(512))) == 2048


class TestPhotos:
    def test_saving_then_reading_back(self, store):
        store.save_photo("p1", (800, 600), [face(direction(1)[0])])
        got = store.get_photo("p1")
        assert got["faceCount"] == 1 and got["width"] == 800

    def test_unknown_photo_is_none(self, store):
        assert store.get_photo("nope") is None

    def test_reanalysing_replaces_faces_instead_of_adding(self, store):
        store.save_photo("p1", (800, 600), [face(v) for v in direction(1, n=3)])
        store.save_photo("p1", (800, 600), [face(direction(2)[0])])
        assert store.get_photo("p1")["faceCount"] == 1
        assert store.stats()["faces"] == 1

    def test_a_photo_with_no_faces_is_still_recorded(self, store):
        store.save_photo("p1", (10, 10), [])
        assert store.get_photo("p1")["faceCount"] == 0

    def test_an_error_is_kept_so_it_is_not_retried_blindly(self, store):
        store.save_photo("p1", None, [], error="fetch failed")
        assert store.get_photo("p1")["error"] == "fetch failed"

    def test_known_ids_excludes_failures(self, store):
        store.save_photo("ok", (5, 5), [])
        store.save_photo("bad", None, [], error="boom")
        assert store.known_ids(["ok", "bad", "missing"]) == {"ok"}

    def test_known_ids_handles_more_ids_than_sqlite_allows_per_query(self, store):
        ids = [f"p{i}" for i in range(1200)]
        for pid in ids:
            store.save_photo(pid, (5, 5), [])
        assert len(store.known_ids(ids)) == 1200

    def test_known_ids_on_empty_input(self, store):
        assert store.known_ids([]) == set()


class TestGrouping:
    def _two_people(self, store):
        for i, v in enumerate(direction(1, n=4)):
            store.save_photo(f"a{i}", (5, 5), [face(v)])
        for i, v in enumerate(direction(2, n=3)):
            store.save_photo(f"b{i}", (5, 5), [face(v)])
        ids, vecs = store.all_embeddings()
        store.replace_groups(group_summary(cluster_faces(vecs), vecs), ids)

    def test_clustering_result_is_written_back(self, store):
        self._two_people(store)
        groups = store.list_groups()
        assert len(groups) == 2
        assert sorted(g["size"] for g in groups) == [3, 4]

    def test_group_photos_lists_its_members(self, store):
        self._two_people(store)
        biggest = store.list_groups()[0]
        assert len(store.group_photos(biggest["id"])) == biggest["size"]

    def test_a_name_survives_reclustering(self, store):
        self._two_people(store)
        target = store.list_groups()[0]
        store.rename_group(target["id"], "Grandma")

        ids, vecs = store.all_embeddings()
        store.replace_groups(group_summary(cluster_faces(vecs), vecs), ids)

        named = [g for g in store.list_groups() if g["name"] == "Grandma"]
        assert len(named) == 1 and named[0]["size"] == target["size"]

    def test_renaming_an_absent_group_reports_failure(self, store):
        assert store.rename_group(999, "x") is False

    def test_reclustering_does_not_leave_stale_group_ids_on_faces(self, store):
        self._two_people(store)
        store.replace_groups([], [])
        assert store.stats()["grouped"] == 0

    def test_ungrouped_embeddings_shrink_as_faces_are_assigned(self, store):
        self._two_people(store)
        assert len(store.ungrouped_embeddings()[0]) == 0
        store.save_photo("c0", (5, 5), [face(direction(3)[0])])
        assert len(store.ungrouped_embeddings()[0]) == 1

    def test_centroids_come_back_in_group_order(self, store):
        self._two_people(store)
        gids, centroids = store.group_centroids()
        assert gids == sorted(gids) and centroids.shape[0] == len(gids)


class TestLifecycle:
    def test_stats_counts_everything(self, store):
        store.save_photo("p1", (5, 5), [face(v) for v in direction(1, n=2)])
        stats = store.stats()
        assert stats["photos"] == 1 and stats["faces"] == 2

    def test_reset_empties_the_database(self, store):
        store.save_photo("p1", (5, 5), [face(direction(1)[0])])
        store.reset()
        assert store.stats() == {"photos": 0, "faces": 0, "groups": 0, "grouped": 0, "errors": 0}

    def test_data_survives_reopening(self, tmp_path):
        path = tmp_path / "persist.db"
        first = Store(path)
        first.save_photo("p1", (5, 5), [face(direction(1)[0])])
        first.close()

        second = Store(path)
        assert second.get_photo("p1")["faceCount"] == 1
        second.close()

    def test_empty_store_reports_no_embeddings(self, store):
        ids, vecs = store.all_embeddings()
        assert ids == [] and vecs.shape[0] == 0


class TestConcurrency:
    """The API writes from a thread pool. One shared sqlite3 connection with
    interleaved transactions raises "API misuse", which is why Store locks."""

    def test_parallel_writers_all_land(self, store):
        from concurrent.futures import ThreadPoolExecutor

        def write(i):
            store.save_photo(f"p{i}", (5, 5), [face(direction(i % 7)[0])])

        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(write, range(200)))

        assert store.stats()["photos"] == 200
        assert store.stats()["faces"] == 200

    def test_readers_and_writers_mix_without_error(self, store):
        from concurrent.futures import ThreadPoolExecutor

        store.save_photo("seed", (5, 5), [face(direction(1)[0])])

        def churn(i):
            store.save_photo(f"p{i}", (5, 5), [face(direction(i % 5)[0])])
            store.known_ids([f"p{j}" for j in range(20)])
            store.all_embeddings()
            return store.stats()["photos"]

        with ThreadPoolExecutor(max_workers=8) as pool:
            counts = list(pool.map(churn, range(120)))

        assert all(c >= 1 for c in counts)
        assert store.stats()["photos"] == 121
