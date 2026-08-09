"""Clustering, on synthetic vectors where the right answer is known by construction."""

import numpy as np
import pytest

from backend.cluster import (
    assign_to_groups,
    cluster_faces,
    cosine_distances,
    group_summary,
    l2_normalise,
)


def people(counts, dim=64, jitter=0.05, seed=0):
    """Tight blobs around random directions: one blob per person."""
    rng = np.random.default_rng(seed)
    vectors, truth = [], []
    for person, n in enumerate(counts):
        centre = rng.normal(size=dim)
        centre /= np.linalg.norm(centre)
        for _ in range(n):
            v = centre + rng.normal(scale=jitter, size=dim)
            vectors.append(v / np.linalg.norm(v))
            truth.append(person)
    return np.array(vectors, dtype=np.float32), np.array(truth)


class TestNormalise:
    def test_rows_become_unit_length(self):
        out = l2_normalise(np.array([[3.0, 4.0], [0.0, 2.0]]))
        assert np.allclose(np.linalg.norm(out, axis=1), 1.0)

    def test_scaling_a_vector_does_not_change_it(self):
        v = np.array([[1.0, 2.0, 3.0]])
        assert np.allclose(l2_normalise(v), l2_normalise(v * 17.0))

    def test_zero_vector_survives(self):
        out = l2_normalise(np.zeros((1, 4)))
        assert np.all(np.isfinite(out))

    def test_one_dimensional_input_is_treated_as_one_vector(self):
        assert l2_normalise(np.array([3.0, 4.0])).shape == (1, 2)


class TestDistances:
    def test_diagonal_is_zero(self):
        v, _ = people([3])
        assert np.allclose(np.diag(cosine_distances(v)), 0.0, atol=1e-5)

    def test_opposite_directions_are_two_apart(self):
        d = cosine_distances(np.array([[1.0, 0.0], [-1.0, 0.0]]))
        assert d[0, 1] == pytest.approx(2.0, abs=1e-5)

    def test_orthogonal_directions_are_one_apart(self):
        d = cosine_distances(np.array([[1.0, 0.0], [0.0, 1.0]]))
        assert d[0, 1] == pytest.approx(1.0, abs=1e-5)


class TestClustering:
    def test_finds_one_group_per_person(self):
        v, truth = people([6, 5, 4])
        labels = cluster_faces(v)
        assert len({int(l) for l in labels if l >= 0}) == 3

    def test_never_puts_two_people_in_one_group(self):
        v, truth = people([6, 5, 4])
        labels = cluster_faces(v)
        for label in set(labels.tolist()):
            if label >= 0:
                assert len(set(truth[labels == label].tolist())) == 1

    def test_a_lone_face_is_left_ungrouped_rather_than_forced(self):
        v, _ = people([5, 1], seed=3)
        labels = cluster_faces(v, min_samples=2)
        assert labels[-1] == -1

    def test_unbalanced_groups_both_survive(self):
        v, truth = people([40, 2], seed=7)
        labels = cluster_faces(v)
        assert len({int(l) for l in labels if l >= 0}) == 2

    def test_a_huge_eps_is_what_merges_people(self):
        # Documents the failure mode the default guards against.
        v, truth = people([5, 5])
        labels = cluster_faces(v, eps=1.5)
        assert len({int(l) for l in labels if l >= 0}) == 1

    def test_empty_input(self):
        assert cluster_faces(np.empty((0, 8))).shape == (0,)

    def test_single_vector_is_ungrouped(self):
        assert cluster_faces(np.ones((1, 8))).tolist() == [-1]


class TestSummary:
    def test_sizes_and_members_match_the_labels(self):
        v, _ = people([6, 3])
        summaries = group_summary(cluster_faces(v), v)
        assert sum(g["size"] for g in summaries) == 9
        assert all(len(g["members"]) == g["size"] for g in summaries)

    def test_largest_group_comes_first(self):
        v, _ = people([3, 9])
        sizes = [g["size"] for g in group_summary(cluster_faces(v), v)]
        assert sizes == sorted(sizes, reverse=True)

    def test_noise_is_not_reported_as_a_group(self):
        v, _ = people([5, 1], seed=3)
        assert all(g["group"] >= 0 for g in group_summary(cluster_faces(v), v))

    def test_centroid_is_a_unit_vector(self):
        v, _ = people([5])
        for g in group_summary(cluster_faces(v), v):
            assert np.linalg.norm(g["centroid"]) == pytest.approx(1.0, abs=1e-4)

    def test_spread_is_higher_for_a_merged_group(self):
        v, _ = people([5, 5])
        tight = group_summary(cluster_faces(v), v)
        merged = group_summary(cluster_faces(v, eps=1.5), v)
        assert merged[0]["spread"] > max(g["spread"] for g in tight)


class TestIncrementalAssignment:
    def test_new_face_joins_its_own_person(self):
        v, truth = people([5, 5])
        summaries = group_summary(cluster_faces(v), v)
        centroids = np.array([g["centroid"] for g in summaries])
        owner = {g["group"]: truth[g["members"][0]] for g in summaries}

        assigned = assign_to_groups(v, centroids)
        for i, slot in enumerate(assigned):
            assert owner[summaries[slot]["group"]] == truth[i]

    def test_a_stranger_stays_ungrouped(self):
        v, _ = people([5], seed=1)
        summaries = group_summary(cluster_faces(v), v)
        centroids = np.array([g["centroid"] for g in summaries])
        stranger, _ = people([1], seed=99)
        assert assign_to_groups(stranger, centroids)[0] == -1

    def test_no_groups_means_nothing_is_assigned(self):
        v, _ = people([3])
        assert assign_to_groups(v, np.empty((0, 64))).tolist() == [-1, -1, -1]
