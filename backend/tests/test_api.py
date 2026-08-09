"""HTTP surface, driven with a stub engine so no model is loaded.

The point here is the contract the extension codes against: what comes back,
what is refused, and what the server declines to fetch.
"""

import base64
import io

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend import app as app_module
from backend.app import create_app
from backend.store import Store

TOKEN = "test-token"
AUTH = {"X-Cleaner-Token": TOKEN}


class StubEngine:
    """Returns one face per 100 px of width, on a per-photo direction."""

    emb_dim = 32
    calls = 0

    def analyse(self, image, threshold=0.75):
        StubEngine.calls += 1
        count = max(0, image.size[0] // 100)
        rng = np.random.default_rng(image.size[0])
        out = []
        for i in range(count):
            v = rng.normal(size=self.emb_dim)
            out.append(
                {
                    "box": [0.1 * i, 0.1, 0.1 * i + 0.08, 0.3],
                    "score": 0.9,
                    "embedding": (v / np.linalg.norm(v)).tolist(),
                }
            )
        return out


def jpeg_b64(width=300, height=200):
    buf = io.BytesIO()
    Image.new("RGB", (width, height), (100, 120, 140)).save(buf, "JPEG")
    return base64.b64encode(buf.getvalue()).decode()


@pytest.fixture
def client(tmp_path):
    store = Store(tmp_path / "api.db")
    app = create_app(store=store, engine_factory=StubEngine, token=TOKEN)
    with TestClient(app) as c:
        yield c
    store.close()


class TestHealth:
    def test_is_reachable_without_a_token(self, client):
        assert client.get("/health").status_code == 200

    def test_reports_that_a_token_is_needed(self, client):
        assert client.get("/health").json()["authRequired"] is True

    def test_includes_counts(self, client):
        assert client.get("/health").json()["stats"]["photos"] == 0


class TestAuth:
    def test_analyse_without_a_token_is_refused(self, client):
        assert client.post("/analyse", json={"items": []}).status_code == 401

    def test_a_wrong_token_is_refused(self, client):
        r = client.post("/analyse", json={"items": []},
                        headers={"X-Cleaner-Token": "nope"})
        assert r.status_code == 401

    def test_the_right_token_is_accepted(self, client):
        assert client.post("/analyse", json={"items": []}, headers=AUTH).status_code == 200

    def test_no_auth_mode_lets_everything_through(self, tmp_path):
        store = Store(tmp_path / "open.db")
        with TestClient(create_app(store=store, engine_factory=StubEngine, token="")) as c:
            assert c.post("/analyse", json={"items": []}).status_code == 200
        store.close()


class TestAnalyse:
    def test_returns_faces_for_inline_image_data(self, client):
        r = client.post("/analyse", headers=AUTH,
                        json={"items": [{"photoId": "p1", "data": jpeg_b64(300, 200)}]})
        body = r.json()
        assert body["analysed"][0]["faceCount"] == 3
        assert body["failed"] == []

    def test_accepts_a_data_url_prefix(self, client):
        payload = f"data:image/jpeg;base64,{jpeg_b64(300, 200)}"
        r = client.post("/analyse", headers=AUTH,
                        json={"items": [{"photoId": "p1", "data": payload}]})
        assert r.json()["analysed"][0]["faceCount"] == 3

    def test_result_is_persisted(self, client):
        client.post("/analyse", headers=AUTH,
                    json={"items": [{"photoId": "p1", "data": jpeg_b64()}]})
        assert client.get("/photos/p1", headers=AUTH).json()["faceCount"] == 3

    def test_an_already_analysed_photo_is_skipped(self, client):
        item = {"photoId": "p1", "data": jpeg_b64()}
        client.post("/analyse", headers=AUTH, json={"items": [item]})
        before = StubEngine.calls
        body = client.post("/analyse", headers=AUTH, json={"items": [item]}).json()
        assert body["skipped"] == ["p1"] and StubEngine.calls == before

    def test_force_reanalyses(self, client):
        item = {"photoId": "p1", "data": jpeg_b64()}
        client.post("/analyse", headers=AUTH, json={"items": [item]})
        before = StubEngine.calls
        body = client.post("/analyse", headers=AUTH,
                           json={"items": [item], "force": True}).json()
        assert body["skipped"] == [] and StubEngine.calls == before + 1

    def test_a_broken_item_fails_alone(self, client):
        r = client.post("/analyse", headers=AUTH, json={"items": [
            {"photoId": "good", "data": jpeg_b64()},
            {"photoId": "bad", "data": "!!!not base64!!!"},
        ]})
        body = r.json()
        assert [a["photoId"] for a in body["analysed"]] == ["good"]
        assert [f["photoId"] for f in body["failed"]] == ["bad"]

    def test_an_item_with_neither_url_nor_data_fails_cleanly(self, client):
        body = client.post("/analyse", headers=AUTH,
                           json={"items": [{"photoId": "p1"}]}).json()
        assert "url or data" in body["failed"][0]["error"]

    def test_an_oversized_batch_is_rejected(self, client):
        items = [{"photoId": f"p{i}", "data": jpeg_b64()} for i in range(300)]
        assert client.post("/analyse", headers=AUTH, json={"items": items}).status_code == 422

    def test_an_unknown_photo_is_404(self, client):
        assert client.get("/photos/ghost", headers=AUTH).status_code == 404


class TestKnown:
    def test_lists_only_what_is_analysed(self, client):
        client.post("/analyse", headers=AUTH,
                    json={"items": [{"photoId": "p1", "data": jpeg_b64()}]})
        body = client.post("/known", headers=AUTH,
                           json={"photoIds": ["p1", "p2"]}).json()
        assert body["known"] == ["p1"]


class TestFetchGuard:
    """The URL in a request comes from a web page, so the server must not
    follow it anywhere the user did not intend."""

    @pytest.mark.parametrize("url", [
        "http://lh3.googleusercontent.com/x",       # not https
        "https://evil.example.com/x.jpg",           # not a Google CDN
        "https://127.0.0.1:9000/admin",             # loopback
        "https://googleusercontent.com.evil.io/x",  # suffix lookalike
        "file:///etc/passwd",
    ])
    def test_refused_before_any_request_is_made(self, client, url, monkeypatch):
        def explode(*_a, **_k):
            raise AssertionError(f"server tried to fetch {url}")

        monkeypatch.setattr(app_module.urllib.request, "urlopen", explode)
        body = client.post("/analyse", headers=AUTH,
                           json={"items": [{"photoId": "p1", "url": url}]}).json()
        assert body["failed"], f"{url} should have been refused"

    def test_an_allowed_host_is_fetched(self, client, monkeypatch):
        buf = io.BytesIO()
        Image.new("RGB", (300, 200), (10, 20, 30)).save(buf, "JPEG")
        payload = buf.getvalue()

        class Response:
            def read(self, _n=None):
                return payload

            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

        monkeypatch.setattr(app_module.urllib.request, "urlopen", lambda *_a, **_k: Response())
        body = client.post("/analyse", headers=AUTH, json={
            "items": [{"photoId": "p1", "url": "https://lh3.googleusercontent.com/a=w300"}]
        }).json()
        assert body["analysed"][0]["faceCount"] == 3

    def test_an_oversized_image_is_rejected_not_truncated(self, client, monkeypatch):
        class Response:
            def read(self, n=None):
                return b"\xff" * (n or 1)

            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

        monkeypatch.setattr(app_module.urllib.request, "urlopen", lambda *_a, **_k: Response())
        body = client.post("/analyse", headers=AUTH, json={
            "items": [{"photoId": "p1", "url": "https://lh3.googleusercontent.com/big"}]
        }).json()
        assert "12 MB" in body["failed"][0]["error"]


class TestGroups:
    def _seed(self, client, count=6):
        items = [{"photoId": f"p{i}", "data": jpeg_b64(300 + i, 200)} for i in range(count)]
        client.post("/analyse", headers=AUTH, json={"items": items})

    def test_no_groups_before_clustering(self, client):
        assert client.get("/groups", headers=AUTH).json()["groups"] == []

    def test_clustering_an_empty_library_is_not_an_error(self, client):
        body = client.post("/group", headers=AUTH, json={"incremental": False}).json()
        assert body["groups"] == []

    def test_grouping_produces_groups(self, client):
        self._seed(client)
        # A loose eps, because the stub's embeddings are random directions.
        body = client.post("/group", headers=AUTH,
                           json={"incremental": False, "eps": 1.2}).json()
        assert body["mode"] == "full" and len(body["groups"]) >= 1

    def test_a_group_can_be_named(self, client):
        self._seed(client)
        gid = client.post("/group", headers=AUTH,
                          json={"incremental": False, "eps": 1.2}).json()["groups"][0]["id"]
        client.post(f"/groups/{gid}/name", headers=AUTH, json={"name": "Mum"})
        names = [g["name"] for g in client.get("/groups", headers=AUTH).json()["groups"]]
        assert "Mum" in names

    def test_naming_a_missing_group_is_404(self, client):
        assert client.post("/groups/42/name", headers=AUTH,
                           json={"name": "x"}).status_code == 404

    def test_group_photos_are_listed(self, client):
        self._seed(client)
        gid = client.post("/group", headers=AUTH,
                          json={"incremental": False, "eps": 1.2}).json()["groups"][0]["id"]
        assert client.get(f"/groups/{gid}/photos", headers=AUTH).json()["photoIds"]


class TestReset:
    def test_clears_everything(self, client):
        client.post("/analyse", headers=AUTH,
                    json={"items": [{"photoId": "p1", "data": jpeg_b64()}]})
        body = client.delete("/data", headers=AUTH).json()
        assert body["stats"]["photos"] == 0

    def test_needs_a_token(self, client):
        assert client.delete("/data").status_code == 401


class TestCors:
    def test_google_photos_is_allowed(self, client):
        r = client.options("/health", headers={
            "Origin": "https://photos.google.com",
            "Access-Control-Request-Method": "GET",
        })
        assert r.headers.get("access-control-allow-origin") == "https://photos.google.com"

    def test_an_arbitrary_site_is_not(self, client):
        r = client.options("/health", headers={
            "Origin": "https://evil.example.com",
            "Access-Control-Request-Method": "GET",
        })
        assert "access-control-allow-origin" not in r.headers


class TestModelFailure:
    def test_a_missing_model_reports_service_unavailable(self, tmp_path):
        def broken():
            raise FileNotFoundError("embedding model missing")

        store = Store(tmp_path / "broken.db")
        with TestClient(create_app(store=store, engine_factory=broken, token="")) as c:
            r = c.post("/analyse", json={"items": [{"photoId": "p1", "data": jpeg_b64()}]})
            assert r.status_code == 503
            assert c.get("/health").json()["modelError"]
        store.close()


class TestPrivateNetworkAccess:
    """Chrome sends an extra preflight before a public page may reach
    127.0.0.1. Missing the answer looks exactly like the server being down."""

    def test_the_preflight_is_answered(self, client):
        r = client.options("/health", headers={
            "Origin": "https://photos.google.com",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Private-Network": "true",
        })
        assert r.headers.get("access-control-allow-private-network") == "true"

    def test_the_header_is_not_sent_when_not_asked_for(self, client):
        r = client.get("/health")
        assert "access-control-allow-private-network" not in r.headers


class TestExtraOrigins:
    """A Firefox port or a custom extension id needs an origin the default
    pattern does not cover — but only when asked for by name."""

    def _client(self, tmp_path, extra):
        store = Store(tmp_path / "origins.db")
        app = create_app(store=store, engine_factory=StubEngine, token="", extra_origins=extra)
        return TestClient(app), store

    def _origin_allowed(self, client, origin):
        r = client.options("/health", headers={
            "Origin": origin, "Access-Control-Request-Method": "GET",
        })
        return r.headers.get("access-control-allow-origin") == origin

    def test_a_named_origin_is_allowed(self, tmp_path):
        client, store = self._client(tmp_path, "http://localhost:8080")
        assert self._origin_allowed(client, "http://localhost:8080")
        store.close()

    def test_the_defaults_still_work(self, tmp_path):
        client, store = self._client(tmp_path, "http://localhost:8080")
        assert self._origin_allowed(client, "https://photos.google.com")
        store.close()

    def test_an_unnamed_origin_is_still_refused(self, tmp_path):
        client, store = self._client(tmp_path, "http://localhost:8080")
        assert not self._origin_allowed(client, "http://localhost:9999")
        store.close()

    def test_several_origins_can_be_named(self, tmp_path):
        client, store = self._client(tmp_path, "http://a.test, http://b.test")
        assert self._origin_allowed(client, "http://a.test")
        assert self._origin_allowed(client, "http://b.test")
        store.close()

    def test_regex_characters_in_an_origin_are_taken_literally(self, tmp_path):
        # Without escaping, "http://a.test" would also match "http://aXtest".
        client, store = self._client(tmp_path, "http://a.test")
        assert not self._origin_allowed(client, "http://aXtest")
        store.close()

    def test_no_extra_origins_leaves_the_default_pattern_intact(self, tmp_path):
        client, store = self._client(tmp_path, "")
        assert self._origin_allowed(client, "https://photos.google.com")
        assert not self._origin_allowed(client, "http://localhost:8080")
        store.close()
