"""Detection geometry and pre-processing, tested without loading any model.

These are the parts where an error is silent: a box that survives the letterbox
maths shifted by a few percent still looks like a face, and the crop it produces
still embeds — just into the wrong person.
"""

import numpy as np
import pytest
from PIL import Image

from backend.faces import NET_H, NET_W, clamp01, crop_face, decode, iou, letterbox


def solid(w, h, colour=(120, 90, 60)):
    return Image.new("RGB", (w, h), colour)


class TestLetterbox:
    def test_output_matches_the_network_input_shape(self):
        tensor, _ = letterbox(solid(800, 600), NET_W, NET_H)
        assert tensor.shape == (1, 3, NET_H, NET_W)

    def test_aspect_ratio_is_preserved(self):
        _, pad = letterbox(solid(1000, 250), NET_W, NET_H)
        assert pad["dw"] / pad["dh"] == pytest.approx(4.0, rel=0.02)

    def test_a_wide_image_is_padded_vertically(self):
        _, pad = letterbox(solid(1000, 250), NET_W, NET_H)
        assert pad["oy"] > 0 and pad["ox"] == 0

    def test_a_tall_image_is_padded_horizontally(self):
        _, pad = letterbox(solid(250, 1000), NET_W, NET_H)
        assert pad["ox"] > 0 and pad["oy"] == 0

    def test_values_land_in_the_range_the_model_expects(self):
        tensor, _ = letterbox(solid(400, 400, (255, 255, 255)), NET_W, NET_H)
        assert tensor.max() == pytest.approx(1.0, abs=0.01)
        tensor, _ = letterbox(solid(400, 400, (0, 0, 0)), NET_W, NET_H)
        assert tensor.min() == pytest.approx(-0.992, abs=0.01)

    def test_a_one_pixel_image_does_not_collapse(self):
        _, pad = letterbox(solid(1, 1), NET_W, NET_H)
        assert pad["dw"] >= 1 and pad["dh"] >= 1

    def test_greyscale_input_is_accepted(self):
        tensor, _ = letterbox(Image.new("L", (300, 300), 128), NET_W, NET_H)
        assert tensor.shape[1] == 3


class TestIou:
    def test_identical_boxes(self):
        assert iou([0, 0, 1, 1], [0, 0, 1, 1]) == pytest.approx(1.0)

    def test_disjoint_boxes(self):
        assert iou([0, 0, 0.4, 0.4], [0.6, 0.6, 1, 1]) == 0.0

    def test_touching_edges_do_not_overlap(self):
        assert iou([0, 0, 0.5, 1], [0.5, 0, 1, 1]) == 0.0

    def test_half_overlap(self):
        assert iou([0, 0, 1, 1], [0.5, 0, 1.5, 1]) == pytest.approx(1 / 3)

    def test_degenerate_box_does_not_divide_by_zero(self):
        assert iou([0.5, 0.5, 0.5, 0.5], [0, 0, 1, 1]) == 0.0


def synth(boxes_scores, anchors=40):
    """Build the raw (scores, boxes) pair UltraFace emits."""
    scores = np.zeros((anchors, 2), dtype=np.float32)
    scores[:, 0] = 1.0
    boxes = np.tile(np.array([0.4, 0.4, 0.5, 0.5], dtype=np.float32), (anchors, 1))
    for i, (box, score) in enumerate(boxes_scores):
        scores[i] = [1 - score, score]
        boxes[i] = box
    return scores, boxes


SQUARE_PAD = {"ox": 0, "oy": 0, "dw": NET_W, "dh": NET_H, "net_w": NET_W, "net_h": NET_H}


class TestDecode:
    def test_reads_the_face_column_not_the_background_column(self):
        # Column 0 is background. Reading it would return every anchor.
        scores, boxes = synth([([0.1, 0.1, 0.2, 0.2], 0.99)])
        assert len(decode(scores, boxes, SQUARE_PAD, 0.75)) == 1

    def test_low_scores_are_dropped(self):
        scores, boxes = synth([([0.1, 0.1, 0.2, 0.2], 0.5)])
        assert decode(scores, boxes, SQUARE_PAD, 0.75) == []

    def test_overlapping_detections_collapse_to_one(self):
        scores, boxes = synth([
            ([0.10, 0.10, 0.30, 0.30], 0.99),
            ([0.11, 0.11, 0.31, 0.31], 0.90),
        ])
        assert len(decode(scores, boxes, SQUARE_PAD, 0.75)) == 1

    def test_the_stronger_of_two_overlaps_is_the_one_kept(self):
        scores, boxes = synth([
            ([0.10, 0.10, 0.30, 0.30], 0.80),
            ([0.11, 0.11, 0.31, 0.31], 0.95),
        ])
        kept = decode(scores, boxes, SQUARE_PAD, 0.75)
        assert kept[0]["score"] == pytest.approx(0.95, abs=1e-5)

    def test_separate_faces_are_both_kept(self):
        scores, boxes = synth([
            ([0.05, 0.05, 0.20, 0.20], 0.99),
            ([0.70, 0.70, 0.90, 0.90], 0.98),
        ])
        assert len(decode(scores, boxes, SQUARE_PAD, 0.75)) == 2

    def test_padding_is_undone_so_boxes_map_back_to_the_original(self):
        # A wide image letterboxed into a 4:3 net: a box in the middle band
        # must expand once the grey bars are removed.
        _, pad = letterbox(solid(1000, 250), NET_W, NET_H)
        scores, boxes = synth([([0.4, 0.45, 0.6, 0.55], 0.99)])
        face = decode(scores, boxes, pad, 0.75)[0]
        height = face["box"][3] - face["box"][1]
        assert height > 0.10 / (pad["dh"] / NET_H) * 0.9

    def test_boxes_stay_inside_the_image(self):
        scores, boxes = synth([([-0.4, -0.4, 1.9, 1.9], 0.99)])
        box = decode(scores, boxes, SQUARE_PAD, 0.75)[0]["box"]
        assert all(0.0 <= v <= 1.0 for v in box)

    def test_a_box_entirely_in_the_padding_is_discarded(self):
        _, pad = letterbox(solid(1000, 250), NET_W, NET_H)
        scores, boxes = synth([([0.2, 0.01, 0.4, 0.05], 0.99)])
        assert decode(scores, boxes, pad, 0.75) == []

    def test_results_are_ordered_strongest_first(self):
        scores, boxes = synth([
            ([0.05, 0.05, 0.15, 0.15], 0.80),
            ([0.50, 0.50, 0.60, 0.60], 0.99),
            ([0.80, 0.10, 0.90, 0.20], 0.90),
        ])
        got = [f["score"] for f in decode(scores, boxes, SQUARE_PAD, 0.75)]
        assert got == sorted(got, reverse=True)


class TestCrop:
    def test_output_is_the_size_the_embedder_wants(self):
        crop = crop_face(solid(800, 600), [0.4, 0.4, 0.6, 0.6], 0.25, 112)
        assert crop.size == (112, 112)

    def test_crop_is_square_even_for_a_tall_box(self):
        img = Image.new("RGB", (400, 400))
        img.paste(Image.new("RGB", (40, 200), (255, 0, 0)), (100, 100))
        crop = crop_face(img, [0.25, 0.25, 0.35, 0.75], 0.0, 64)
        assert crop.size == (64, 64)

    def test_margin_widens_the_crop(self):
        img = Image.new("RGB", (400, 400), (0, 0, 0))
        img.paste(Image.new("RGB", (100, 100), (255, 255, 255)), (150, 150))
        box = [0.375, 0.375, 0.625, 0.625]
        tight = np.asarray(crop_face(img, box, 0.0, 64), dtype=float).mean()
        wide = np.asarray(crop_face(img, box, 0.6, 64), dtype=float).mean()
        assert wide < tight  # more black border pulled in

    def test_a_box_at_the_edge_does_not_raise(self):
        crop = crop_face(solid(200, 200), [0.0, 0.0, 0.1, 0.1], 0.25, 112)
        assert crop.size == (112, 112)

    def test_greyscale_input_becomes_three_channel(self):
        crop = crop_face(Image.new("L", (200, 200), 90), [0.3, 0.3, 0.6, 0.6], 0.25, 112)
        assert np.asarray(crop).shape == (112, 112, 3)


class TestClamp:
    @pytest.mark.parametrize("value,expected", [(-3.0, 0.0), (0.5, 0.5), (7.0, 1.0)])
    def test_range(self, value, expected):
        assert clamp01(value) == expected
