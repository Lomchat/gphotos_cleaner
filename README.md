# Photo Cleaner for Google Photos

A Chrome extension that analyses your Google Photos library **locally** and helps
you decide what to delete: photos with no people, screenshots, documents, blurry
or dark shots, near-duplicates, long videos, plus statistics by year, month and
day.

**It never deletes anything.** It ticks the items you chose in the Google Photos
interface, then hands control back. You click "Move to bin" yourself, in Google's
own UI, with its own counter and confirmation.

No account access, no API keys, no server, no build step. A real face-detection
model runs in your browser; nothing is uploaded anywhere.

---

## Repository layout

```
extension/     the Chrome extension — works entirely on its own
  src/         source, no bundler
  vendor/      onnxruntime-web + the face model, both MIT, both committed
  tests/       Node test runner, no dependencies
backend/       optional local service for grouping photos by person
```

One repository rather than two: the extension and the backend share an API
contract, and splitting them guarantees version drift and issues filed in the
wrong place. **The extension never requires the backend.**

---

## Install

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. **Load unpacked** and select the `extension/` folder
4. Open [photos.google.com](https://photos.google.com) and sign in
5. A **Clean up** badge appears at the top right

Chrome 116 or newer.

> If a Google Photos tab was already open when you installed, reload it — Chrome
> does not inject content scripts retroactively. Clicking the toolbar icon
> triggers that reload for you.

---

## Usage

**1 · Analyse.** One action. The extension scrolls the grid to list your items
and analyses each thumbnail as it goes. Nothing in Google Photos is modified.
Interruptible; progress is kept and a rerun resumes where it stopped.

Two controls bound the work, and a banner states what the next run will do:

- **Only handle photos older than** 6 months, 12 months, 3 years, 5 years, or a
  date. The useful direction for cleaning: purge the old, never touch the recent.
- **Limit per run** — none, 500, 2,000, 10,000 or a custom number.

**2 · Sort.** Tick criteria and adjust thresholds. The number beside each
criterion is exactly what that criterion alone would catch. **Open full screen**
gives a wide grid with the criteria in a left column.

**3 · Tick.** **Tick in Google Photos** walks your selection and ticks each item.
Then the extension stops. Review, and delete with Google's own button if you want.

---

## What it detects

All measurements are taken on the thumbnail, not the original file.

| Criterion | Method | Reliability |
|---|---|---|
| **People present** | UltraFace RFB-320 neural detector, in-browser | Good |
| **Blurry** | Laplacian variance, contrast-corrected, plus a local quantile that spares deliberate background blur | Good |
| **Dark / overexposed** | Mean and median luminance, quantiles, share of extreme pixels | Good |
| **Near-duplicates** | dHash + aHash fingerprints, grouped by Hamming distance in a time window | Good |
| **Screenshots** | Axis-aligned gradient energy, flat areas, small palette, screen aspect ratio, status bar | Fair |
| **Documents** | Light desaturated background, bimodal histogram, text-line detection | Fair |
| **Long videos** | Duration read from the tile | Good (duration stands in for file size, which Google does not expose) |

### People detection

Chrome exposes no usable face detector — the `FaceDetector` API sits behind an
experimental flag — so the extension ships its own: **UltraFace RFB-320**, a
1.2 MB ONNX model, run through onnxruntime-web. Both are vendored under
`extension/vendor/`, both MIT, and neither is fetched at runtime.

Everything below was measured in Chrome on this machine, not estimated:

| Measurement | Result |
|---|---|
| Detection on a 7-person group photo | 7 of 7, confidence 1.000 |
| Same photo at 176px, 256px, 320px | 7 faces at every size |
| Landscape photo (no people) | 0 false positives |
| Inference, one worker | ~96 ms per image |
| Throughput, 5 workers | ~32 images/s |
| Throughput, 6 workers | ~51 images/s |

The size result is what shaped the design: detection holds up on the 176px
thumbnails the extension already downloads, so no extra bandwidth is needed for
people.

Three tiers run in order, so the extension still works when the model cannot:

1. **UltraFace** — the trained model, used whenever WebAssembly is available.
2. **`FaceDetector`** — if the browser happens to expose it.
3. **Skin-tone heuristic** — colour and shape only. Kept solely as a floor.

The "no people" criterion behaves differently under each. Under the heuristic it
also requires a small skin area, because that heuristic collapses on profiles
while skin area stays high; under a trained detector that guard is dropped.
Methods are **trusted by name**, so an unrecognised method or an entry written by
an older version falls on the cautious side rather than the permissive one.

Face detection requires `'wasm-unsafe-eval'` in the extension CSP. Both the
positive and the negative case were verified: with the directive, WebAssembly
compiles and the pool starts; without it, compilation is refused, the pool
reports zero workers and the pipeline degrades to the heuristic instead of
failing.

---

## How it works

```
content.js ──▶ panel.js ──▶ scanner.js ──▶ dom-adapter.js ──▶ [Google Photos DOM]
                  │              │
                  │              └──▶ db.js (IndexedDB)
                  │
                  ├──▶ analyze-client.js ──▶ service-worker.js ──▶ offscreen.js
                  │                                                 │      │
                  │                                       fetch/CV pool   face pool
                  │                                        (8–16)          (2–6)
                  │                                     features.js   face-worker.js
                  │
                  └──▶ actions.js ──▶ dom-adapter.js ──▶ [ticking only]
```

| File | Role |
|---|---|
| `src/content/dom-adapter.js` | **All** coupling to the Google Photos DOM |
| `src/content/scanner.js` | Scrolling, harvesting, resume cursor, time window |
| `src/content/analyze-client.js` | Batching and refill loop |
| `src/content/actions.js` | Ticking in Google Photos (no deletion) |
| `src/analysis/features.js` | Classical vision primitives, pure and tested |
| `src/analysis/face-postprocess.js` | Model output decoding, pure and tested |
| `src/analysis/face-pool.js` / `face-worker.js` | Neural detection |
| `src/common/filters.js` | Predicates, duplicate grouping, statistics |
| `src/ui/panel.js` | Interface, inside a Shadow DOM |

### Design decisions worth knowing

**The extension cannot delete.** An earlier version could: it found the "Move to
bin" button, handled the confirmation dialog, batched the work, verified a
counter before destroying, and offered a dry-run mode so you could distrust it.
All of it is gone. What remains is one action undone by a single click, and the
counter that matters is Google's, not ours.

**Two pools, deliberately.** Fetching is network-bound and wants many workers;
inference is CPU-bound and each session carries its own WebAssembly heap. One
shared session would have capped the pipeline at ~9 images/s — sixteen minutes
for ten thousand photos. Measured scaling is near-linear (1 → 9.3, 2 → 18.1,
4 → 38.1, 6 → 51 images/s), so the detector pool is sized at roughly a quarter of
the core count, clamped to 2–6.

**Why an offscreen document.** The page CSP may forbid creating workers from a
content script. An offscreen document belongs to the extension: its CSP is ours,
and it keeps `host_permissions`, so thumbnail fetches need no CORS preflight.

**Why IndexedDB.** A catalogue can exceed 50,000 entries with ~20 measurements
each. `chrome.storage` serialises everything on each write and imposes a far too
small quota.

**Why a sliding window for duplicates.** All-pairs comparison is O(n²) — over a
billion comparisons at 50,000 photos. Bursts and copies are almost always
adjacent in time, so sorting by date and comparing inside a window brings it to
O(n·k). Union-find links gradual chains.

**Why one predicate table.** The number beside a checkbox must be exactly what
ticking it would select. Filtering, counting and statistics all read the same
`CRITERION_TESTS` table, and a test locks that invariant.

**Why quality criteria skip videos.** A video thumbnail is one arbitrary frame:
it can be blurry, black or empty while the video is not.

---

## Runtime

Feature extraction costs ~1.5 ms per image; face detection ~96 ms on one worker,
parallelised across the detector pool. Thumbnail download remains a major cost.
By default there is no limit: listing runs to the end of the library.

Settings that matter (*Settings → Speed*):

| Setting | Effect |
|---|---|
| **Thumbnail size** (176px) | Dominant transfer cost. Tests verify hashes stay comparable at this scale and the sharp/blurry ordering is preserved; face detection was measured to hold up too. |
| **Concurrent batches** (3) | The main lever on a fast connection. |
| **Scroll step** (0.82) | Fraction of the viewport per step. |
| **Max render wait** | A ceiling, not a target; the real wait adapts. |

### Two subtleties that caused real bugs

**"Nothing is moving" is ambiguous.** Mid-list it means rendering finished; at
the bottom of an infinite list it means the next page has not loaded. An early
version treated both alike and declared the library exhausted after a few hundred
items. The wait is now *referenced*: after scrolling we wait for the grid
signature to **change**, then settle, with a growing budget.

**Google Photos fills the grid in two passes** — tiles first, images second.
Watching only the structure harvested items whose `<img>` had no source yet. The
signature now counts loaded thumbnails, a dedicated wait targets 90% coverage,
and stragglers are recovered automatically at the end of a run (3 attempts each;
above 500 items a fresh pass is faster and the extension says so).

---

## When Google changes something

The markup is obfuscated and changes without notice. **All knowledge of it lives
in `src/content/dom-adapter.js`.** Diagnostics appear inside the relevant alert
banners, when a problem occurs, rather than in a panel nobody opens in time.

| Symptom | Where to look |
|---|---|
| "Scroll container not found" | `findScroller` |
| 0 tiles detected | `TILE_SELECTOR` |
| **Items listed but 0 analysed** | `GOOGLE_IMAGE_HOST`, or the thumbnail wait is too short |
| Missing thumbnail URLs | `tileThumbUrl` |
| Missing dates | `parseDateFromText`, `HEADER_SELECTOR` |
| "Checkbox not found" | `CHECKBOX_SELECTOR`, `findCheckbox` |

### The "listed but never analysed" trap

The nastiest failure, because it raises no error: listing finds items, the engine
answers, the queue is empty, the counter stays at zero. It happens when Google
changes the host serving thumbnails — the URL stops being recognised, the item is
stored without an image, and `getPending` never sees it.

Two safeguards: a red banner lists the **image hosts actually observed**, and
listing **repairs the catalogue** by re-reading known items that lack a URL.

Adding a domain takes two edits, and **both are required**: `GOOGLE_IMAGE_HOST`
in `dom-adapter.js`, and `host_permissions` in `manifest.json` so the fetch is
not blocked by CORS. A test verifies every recognised host has a permission.

---

## Development

```bash
cd extension
npm test        # 192 tests, no external dependencies
```

No build step. The extension loads as-is; tests run on Node's built-in runner.

Tests cover the classical vision primitives (deterministic synthetic images),
model output decoding, date parsing, filtering and grouping, consistency
invariants between counters and filters, and the contract between the manifest
and the import chain.

That last one deserves a note: the panel is loaded by dynamic import, and every
module reached that way must appear in `web_accessible_resources`, or Chrome
refuses the import — **silently**. `tests/manifest.test.js` walks the real import
graph and checks each module is declared.

Model inference itself is validated separately, in a browser, against a real
photograph. Unit tests prove the decoding maths; only a browser proves the model
and runtime actually work under the extension's CSP.

### Vendored dependencies

| Path | What | Licence |
|---|---|---|
| `extension/vendor/onnxruntime/` | onnxruntime-web 1.27 (WASM backend) | MIT |
| `extension/vendor/models/ultraface-rfb320.onnx` | UltraFace RFB-320 | MIT |

Committed rather than fetched: the extension must install with "Load unpacked"
and no build step, and a model downloaded at runtime would break the promise that
nothing leaves the browser.

---

## Privacy

No data leaves the browser. Thumbnails are downloaded from Google's servers —
exactly as the page itself would — analysed in memory, and the model runs
locally. The catalogue stays in IndexedDB on the photos.google.com origin. No
third-party requests, no telemetry.

The **↺** button in the panel header resets the extension to a fresh-install
state immediately, with no confirmation. It is inert during a run.

---

## Known limitations

- The Google Photos tab must stay in the foreground while listing runs.
- Analysis works on 176px thumbnails: very slight blur or very fine text can go
  unnoticed.
- Face detection was validated on public-domain photographs, not on a benchmark
  suite. Small faces in wide scenes are the likeliest misses.
- Shared albums and archived items are only seen if the current view shows them.
- Ticking several thousand items slows the Google Photos interface down.
- Automating a web interface sits in a grey area of Google's terms of service.
  The extension acts only on your own account and uses no private API — but the
  responsibility is yours.

---

## Contributing

Issues and pull requests welcome. Two things to know:

- **`dom-adapter.js` is where Google breakage lands.** Include what the built-in
  diagnostics reported.
- **Tests are the specification.** Several encode decisions that are easy to
  reverse by accident — trusted-by-name detection methods, videos exempt from
  quality criteria, counters matching filters exactly. If a change makes one
  fail, the question is whether the decision should change, not the test.

## Licence

MIT — see [LICENSE](LICENSE). Vendored dependencies keep their own licences,
included alongside them.

Not affiliated with, endorsed by, or connected to Google. "Google Photos" is a
trademark of Google LLC.
