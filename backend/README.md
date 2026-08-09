# Local backend — grouping photos by person

**Optional.** The extension is fully usable without it. Everything it adds is
the one thing a thumbnail cannot give you: *identity*.

The extension can tell you a photo contains a face. It cannot tell you whose.
This backend embeds every detected face and clusters the library by person, so
*"every photo without Grandma in it"* becomes a filter you can act on.

It listens on `127.0.0.1` only. Nothing leaves the machine.

---

## Setup

```bash
pip install -r backend/requirements.txt
python -m backend.download_models      # 166 MB, once
python -m backend.app                  # http://127.0.0.1:8765
```

The server prints a token on startup:

```
  Photo Cleaner backend
  http://127.0.0.1:8765
  token: 8Kd2-vQ...
  paste it into the extension panel, People tab
```

In the extension: **People** tab → tick *Use a local backend* → paste the token
→ *Test connection* → *Analyse faces*.

The token is also in `backend/data/token`. Use `--no-auth` to switch it off —
only sensible if nothing else runs in your browser, because without it any page
you visit could POST to the server and wipe your named groups.

---

## What it does

| Stage | Model | Notes |
|---|---|---|
| Detection | UltraFace RFB-320 (1.2 MB) | the very file the extension ships, so both sides agree on what a face is |
| Embedding | ArcFace `buffalo_l` r50 (166 MB) | 512-d identity vector per face |
| Grouping | DBSCAN, cosine, `eps=0.55` | number of people unknown; strangers must be allowed to stay ungrouped |

### Why these choices

**DBSCAN rather than k-means.** The number of people is unknown, groups are
wildly unbalanced (hundreds of photos of a partner, one of a stranger at a
party), and a face matching nobody has to be allowed to stay ungrouped instead
of being forced into the nearest cluster.

**`eps = 0.55`.** Measured on labelled photographs (`tests/test_identity.py`):

```
same person       min 0.030   max 0.426   mean 0.288
different people  min 0.951   max 0.997   mean 0.979
separation margin +0.525
```

`0.55` sits in the middle of that gap. Lower splits one person into several
groups; higher starts merging different people — the failure that matters,
because a merged group invites deleting the wrong person's photos.

**Detection threshold `0.75`.** At `0.6`, a collar in one test photo scores
`0.625` and becomes a "face"; every real face there scores `1.000`. From `0.70`
up the labelled set gives 13/13 real faces and no extras. A false positive is
worse than a miss here: it seeds a junk person group.

**No landmark alignment.** ArcFace is normally fed a 5-point aligned crop. A
landmark model is another large download, and without it the same-person
distances are inflated (≈0.40 rather than ≈0.25) — still separated by half a
unit from the different-person distances, so the grouping is unaffected. If you
ever see a group mixing two people, this is the first thing to add.

---

## Performance

Measured on 20 cores, 512 px thumbnails, detection + embedding:

| Setup | Throughput |
|---|---|
| default intra-op threads, 1 request at a time | 10.1 img/s |
| default intra-op threads, 2 concurrent | 6.2 img/s (cores fight) |
| `intra_op=1`, 16 concurrent | **32.5 img/s** |
| the same, end to end over HTTP | 26.6 img/s |

So sessions run single-threaded and parallelism comes from running many photos
at once. One session is shared across all worker threads — sixteen copies of a
166 MB model would cost 2.6 GB for no extra speed.

A 10,000-photo library takes roughly six minutes. Photos already analysed are
skipped, so a second run costs nothing.

---

## API

All endpoints except `/health` require `X-Cleaner-Token`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | reachability, model state, counts — no token needed |
| `POST` | `/known` | which photo ids are already analysed |
| `POST` | `/analyse` | `{items: [{photoId, url \| data}]}`, ≤256 per call |
| `GET` | `/photos/{id}` | stored faces for one photo |
| `POST` | `/group` | cluster; `incremental` attaches new faces to existing people |
| `GET` | `/groups` | groups with size, spread and cover photo ids |
| `GET` | `/groups/{id}/photos` | photo ids in a group |
| `POST` | `/groups/{id}/name` | rename (names survive re-clustering) |
| `DELETE` | `/data` | wipe everything |

`spread` is the mean distance to the group centroid. A high value on a large
group is the signature of a merge — two people pulled together — and is the
number to look at before trusting a group. The panel flags groups above 0.3.

### Sending photos

Items carry either a `url` (the backend fetches it) or `data` (base64, sent by
the extension). URLs are preferred: a batch of 200 addresses is a few kilobytes
against ~5 MB of base64. Only Google's photo CDNs are fetched — the URL comes
from a web page, so the server must not be usable to probe anything else on the
network. When a fetch is refused, the extension resends those photos as bytes.

---

## Storage

One SQLite file, `backend/data/cleaner.db`. Deleting your data is
`rm -r backend/data`. Embeddings are stored as raw float32 blobs: 512 floats is
2 KB packed against ~10 KB as JSON, which on 50k faces is 100 MB rather than
500 MB.

---

## Tests

```bash
python -m pytest backend/tests -q
```

128 tests. Three levels:

- **Pure** — clustering and detection geometry on synthetic input, where the
  right answer is known by construction. No model, no network.
- **API** — the whole HTTP surface against a stub engine: auth, batching, the
  SSRF guard, CORS, the Private Network Access preflight.
- **Ground truth** (`test_identity.py`) — the real models on photographs whose
  subjects are documented. Everything else proves the code does what it was
  written to do; only labelled photographs prove the models are wired up
  correctly. A transposed tensor or a crop off by a quarter still produces
  plausible-looking numbers.

The ground-truth fixtures are downloaded on first run and are **not** committed:
photographs of real people do not belong in this repository. Those 11 tests skip
cleanly when the model or the network is unavailable, so a plain checkout still
runs green (117 passed, 11 skipped).

---

## Licences

- UltraFace RFB-320 — MIT, vendored under `extension/vendor/models/`
- ArcFace `buffalo_l` — downloaded from the [immich-app mirror](https://huggingface.co/immich-app/buffalo_l);
  InsightFace model weights are for **non-commercial research use**
- Test fixtures — from the [`face_recognition`](https://github.com/ageitgey/face_recognition)
  examples, downloaded at test time, never redistributed here
