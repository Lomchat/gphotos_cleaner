# GPhotos Cleaner

A Chrome extension that analyses your Google Photos library **locally** and helps
you decide what to delete: photos with no people, screenshots, documents, blurry
or dark shots, near-duplicates, long videos, oversized files, plus statistics by
year, month and day.

It lists your library through the same private API the Google Photos web app
uses on itself — five hundred items per request, with dates, sizes and thumbnail
URLs included. Everything it then does with them happens in your browser: no
account access, no API keys, no server, no build step. A real face-detection
model runs locally; no image is uploaded anywhere.

It also groups your library by person — *"every photo without Grandma in it"*
becomes a filter. That needs a 13 MB recognition model, downloaded once; every
other feature works without it.

**What it can remove.** One thing: a move to the bin, which is the same
operation Google's own "Move to bin" button performs and which Google keeps
recoverable for 60 days. There is no permanent-delete path in the code, and
there is no restore path either — the bin is Google's to manage. Every deletion
goes through a confirmation that states the count, the storage it frees, and
what it will leave alone. If you would rather not hand that over, **Tick in
Photos** still ticks your selection in Google's own grid and stops there.

---

## Repository layout

```
extension/
  src/         source, no bundler
  vendor/      onnxruntime-web + the face detector, both MIT, both committed
  tests/       Node test runner, no dependencies
```

No server, no Python, no build step. Everything runs in the browser.

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

**1 · Analyse.** One action. The extension asks Google Photos for your library a
page at a time and analyses each thumbnail as the pages arrive. Nothing in your
library is modified. Interruptible; progress is kept and a rerun resumes where
it stopped.

Three controls bound the work, and a banner states what the next run will do:

- **Only handle photos older than** 6 months, 12 months, 3 years, 5 years, or a
  date. The useful direction for cleaning: purge the old, never touch the
  recent. This is a request parameter, not a filter applied afterwards — the
  listing simply starts at that date.
- **Limit per run** — 2,000 by default; none, 500, 10,000 or a custom number.
- **Also fetch file names and sizes** — on by default. One extra request per 200
  items, and the only source of a figure the grid never carried. It is what
  makes the size filter, the size order and the "this frees 3.2 GB" line
  possible.

The ring at the top measures the **whole** job, not one stage of it: thumbnails
measured *and* faces read, each weighted by the number of photos it covers. It
cannot show 100% while the face pass still has photos to go, and a library with
nobody in it reaches 100% on measurement alone — there is no identity stage
waiting to run. The badge names every stage at once, so a run reads
`Listing 1,200 · Analysing 900 · Faces 40/300` whether or not the panel is open.

**Stop** halts every stage — listing, analysis and the face pass alike. It is
not instant and cannot be: each stage checks between batches, and the batch
already in flight has to come back first, which at 512px is a few seconds. So
the click is acknowledged straight away in the button and the badge. Whatever
was read before the stop is kept and grouped; a rerun picks up the rest.

**2 · Sort.** The tab itself is a door: a summary and one button. The work
happens in the wide view — criteria on the left, order buttons above, thumbnails
filling the rest. Judging thumbnails is the whole task, and a 440px column shows
sixteen at a time in a strip too narrow to tell a soft face from a sharp one.

With no criterion ticked the grid simply shows the whole library, and nothing is
ticked — browsing, not filtering. Switch a criterion on and everything it
matches is ticked for you; that is the difference between a grid chosen by a
rule and one nobody has judged.

The number beside each criterion is exactly what that criterion alone would
catch. A row of **order** buttons sits above the grid, sticky while it scrolls.
An order never changes *what* is selected, only where it sits — it is a reason to
look, not a filter:

| Order | Puts first |
|---|---|
| Most suspicious | Photos tripping the most criteria at once |
| Surely nobody | Where the detector is most confident no one is there |
| Rarest people | People who barely appear elsewhere; your regulars sink |
| Biggest files | What actually costs you storage |
| Blurriest / Darkest | The worst of each |
| Oldest / Newest | By date taken |

Anything an order cannot judge — a video, an unanalysed photo, an unmeasured
file — always sinks to the bottom rather than floating into the top, where
people skim and tick.

Click a thumbnail to tick it. **Shift-click** takes the whole run between it and
your last click, and while Shift is held that run is outlined in dashed amber so
you see what the click will take before you make it. The run adopts the anchor's
state rather than toggling each tile, so a photo you deliberately spared never
flips into the selection.

**3 · Remove.** Two buttons, deliberately unequal.

**Move to bin** is the primary one. It asks first, in the panel rather than in a
browser dialog — a native `confirm()` inside Google's page blocks everything,
including the progress you are about to want. The confirmation states how many
photos, roughly how much storage that frees and over how many of them that
figure was actually measured, that they stay recoverable for 60 days, and what
it will skip: anything shared into your library by somebody else, and anything
listed by a version of this extension that did not record the key the call
needs. A local catalogue entry is dropped only for the photos Google confirmed
taking.

**Tick in Photos** does what the extension used to do and nothing more: walks
your selection, ticks each item in Google's own grid, and stops. Review and
delete with Google's button. It has to happen in the grid — the checkbox exists
only for tiles Google has rendered — so it is slower, and it is kept for the
case where you would rather see the selection in Photos before parting with it.

**Grouping by person.** One switch in the Analyse tab, **Also group photos by
person**, ticked by default. With it on, each run additionally re-reads photos
containing a face at a larger size, turns each face into an identity vector and
groups them — and the first such run fetches the 13 MB recognition model, once.

The switch *is* the consent, so it says so before anything runs: the size, that
it is the only non-photo download, and that unticking skips it entirely. If the
download fails the run carries on without grouping — the visual analysis behind
it took minutes and is worth keeping.

The people themselves appear in the sorting view, directly under the **With /
Without selected people** criteria they parameterise — tick who you mean, name
them if you like, and the name follows that person across rebuilds. There is no
separate tab: picking who you mean belongs next to the box you just ticked, and
a second pass you have to remember to launch is a second pass that never runs.

---

## What it detects

Visual measurements are taken on the thumbnail, not the original file. Size and
file name come from Google's own metadata.

| Criterion | Method | Reliability |
|---|---|---|
| **People present** | UltraFace RFB-320 neural detector, in-browser | Good |
| **Blurry** | Laplacian variance, contrast-corrected, plus a local quantile that spares deliberate background blur | Good |
| **Dark / overexposed** | Mean and median luminance, quantiles, share of extreme pixels | Good |
| **Near-duplicates** | dHash + aHash fingerprints, grouped by Hamming distance in a time window | Good |
| **Screenshots** | Axis-aligned gradient energy, flat areas, small palette, screen aspect ratio, status bar | Fair |
| **Documents** | Light desaturated background, bimodal histogram, text-line detection | Fair |
| **Large files** | Storage actually used, from Google's metadata | Exact |
| **Long videos** | Duration, from Google's metadata | Exact |
| **A given person** | ArcFace `buffalo_s` embeddings, agglomerative grouping | Good — measured margin +0.34 between same and different people |

An item with no size figure **never** matches "large files" and sinks to the
bottom of the size order. Unknown is not small, and a filter someone reads as
"the big ones" must not quietly include things nobody measured.

### Grouping by person

The People pass re-reads photos at 512px rather than reusing the 176px
thumbnail. Identity needs the pixels — measured on a photo of seven strangers,
the closest different-person pair against the 0.55 grouping threshold:

| Rendition | Face size | Closest stranger | Headroom |
|---|---|---|---|
| 176px | 9–13px | 0.584 | +0.03 |
| 320px | 17–22px | 0.593 | +0.04 |
| **512px** | **28–35px** | **0.627** | **+0.08** |

Below roughly 21px the headroom collapses, so faces narrower than 24 source
pixels are counted and skipped rather than guessed at. Only photos the main
analysis already believes contain a face are re-read; a landscape has no
identity to find.

**How alike is the same person?** The threshold has a slider, because the answer
depends on whose photos these are. The default was read off studio portraits —
worst same-person pair 0.48, closest strangers 0.63 — and a real library of
profiles, sunglasses and twenty years of ageing pushes same-person distances
well past that, scattering one person across several groups. The two failures
are not symmetrical: too strict is untidy, too loose puts two people in one
group and offers up somebody else's photos. Past 0.63 the panel says so.

Grouping is agglomerative, not DBSCAN. DBSCAN needs the pairwise distance
matrix, and 10,000 faces is 100 million pairs — 400 MB to hold, in a content
script, on the user's tab. Each face is compared against the centroids found so
far instead, then a merge pass repairs the order-dependence that introduces.
Measured: 20,000 faces at 512 dimensions in 4.4 seconds.

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
main-world.js  ──▶ (page world: reads WIZ_global_data, posts the session tokens)
      │
      ▼
content.js ──▶ panel.js ──▶ api-scanner.js ──▶ photos-api.js ──▶ batchexecute.js
                  │                                                    │
                  │                                        [Google Photos API]
                  │              └──▶ db.js (IndexedDB)
                  │
                  ├──▶ analyze-client.js ──▶ service-worker.js ──▶ offscreen.js
                  │                                                 │      │
                  │                                       fetch/CV pool   face pool
                  │                                        (8–16)          (2–6)
                  │                                     features.js   face-worker.js
                  │
                  ├──▶ trash-client.js ──▶ photos-api.js ──▶ [move to bin]
                  │
                  ├──▶ actions.js ──▶ dom-adapter.js ──▶ [ticking only]
                  │
                  └──▶ people-client.js ──▶ service-worker.js ──▶ offscreen.js
                                                                    │       │
                                                          face pool   recognition pool
                                                                    └── cluster.js
```

| File | Role |
|---|---|
| `src/page/main-world.js` | The only file running in the page's own world: reads the session tokens and posts them across |
| `src/api/tokens.js` | What those obfuscated keys mean |
| `src/api/batchexecute.js` | The wire format, and telling its failure modes apart |
| `src/api/parse.js` | Google's positional arrays → named fields |
| `src/api/photos-api.js` | The four calls this extension makes |
| `src/content/api-scanner.js` | Paging, the date window, the run limit, the resume cursor |
| `src/content/trash-client.js` | Deciding what can be binned, then binning it |
| `src/content/dom-adapter.js` | **All** remaining coupling to the Google Photos DOM |
| `src/content/analyze-client.js` | Batching and refill loop |
| `src/content/actions.js` | Ticking in Google Photos |
| `src/analysis/features.js` | Classical vision primitives, pure and tested |
| `src/analysis/face-postprocess.js` | Model output decoding, pure and tested |
| `src/analysis/face-pool.js` / `face-worker.js` | Neural detection |
| `src/common/filters.js` | Predicates, duplicate grouping, statistics |
| `src/common/images.js` | Recognising Google image URLs and asking for a size |
| `src/analysis/cluster.js` | Grouping faces into people, pure and tested |
| `src/content/people-client.js` | The People pass: what to read, what to keep |
| `src/ui/panel.js` | Interface, inside a Shadow DOM |

### The API, and what it costs

Google Photos talks to itself over an endpoint called `batchexecute`: a POST
carrying one or more calls, each named by an obfuscated id, with arguments as a
JSON string nested inside another JSON string. It is entirely undocumented. The
wire format, the four call ids and every array index are adapted from
[Google-Photos-Toolkit](https://github.com/xob0t/Google-Photos-Toolkit) (MIT),
which is where they were worked out.

| Call | id | What it gives |
|---|---|---|
| Timeline by date taken | `lcxiM` | 500 items per request: media key, dedup key, capture time, thumbnail URL, dimensions, duration, archived, favourite, ownership |
| Bulk metadata | `EWgK9e` | File name, byte size, storage actually used, original quality |
| Move to bin | `XwAOJf` | The bin, recoverable for 60 days |

**What this bought.** Measured against a live library, not estimated:

| | scroll-and-harvest | API |
|---|---|---|
| 2,000 items | minutes, ~50 stops | **4.6 s, 4 requests** |
| of which had a thumbnail | 164 on the worst run | **2,000** |
| file names and sizes | unavailable | 400 in 1.1 s, 2 requests |
| "only photos before 2025-08-12" | scroll past everything newer | a request parameter; 0 items came back newer |

Every item arrives complete, so the whole class of bug described below
disappeared: nothing is rendered, so nothing can be read too early.

**One thing the size suffix does not do is make a thumbnail public.** Measured
across `=w176-h176`, `-no`, `-k-no`, `=s176` and the bare URL: all of them are
403 without the session cookie and 200 with it. The engine remembers which
hosts refused and sends credentials directly, because retrying every thumbnail
would double the dominant cost of a run.

**What it costs.** An undocumented endpoint is no more stable than an
undocumented DOM — it is the same bet, moved. What makes it a better bet is that
the failure is *loud*: a renamed field throws a shape error naming the call,
where a changed CSS class silently listed zero items. The transport tells four
failures apart — HTTP, expired session, malformed response, network — because
each deserves a different answer, and only one of them is worth retrying.

The session credentials live in `window.WIZ_global_data`, which an isolated
content script cannot see: the object is genuinely not there. So one small file
runs in the page's own world, copies six values and posts them to our own origin
— never to `*`. It interprets nothing, because it shares a global scope with
Google's application. It lives outside `src/content/` precisely so it is not
web-accessible: everything in there is, and the file that reads session tokens
must not be.

### Design decisions worth knowing

**The recognition model is not vendored.** InsightFace weights are licensed for
non-commercial research use and this repository is MIT, so shipping the file
would redistribute it under terms the repository cannot grant. It is fetched
once and cached in the extension's own IndexedDB. No host permission is asked
for: the download answers with permissive CORS headers, and widening
`host_permissions` permanently for a once-per-install need would be a bad trade.

**"Not analysed" is never "nobody in it".** A photo the People pass has not read
has no `people` field, and the *Without selected people* predicate refuses to
match it. Treating the two alike would offer up every unread photo under a
filter the user reads as "definitely without them" — and the criterion is also
force-unticked the moment it becomes unusable, so a box showing "off" can never
still be filtering.

**Deletion is one operation, and it is reversible.** The extension can move
items to the bin. It cannot empty the bin, cannot delete permanently, and cannot
restore — Google's own interface does all three. That reversibility is what
makes shipping a delete button acceptable at all, so it is stated on the
confirmation rather than buried here. A local row is removed only after Google
confirms taking the photo: a catalogue entry deleted for something still in the
library would hide it from every later run, which is the quiet kind of wrong.

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
parallelised across the detector pool. Thumbnail download remains the dominant
cost, and listing is now a rounding error beside it.

Settings that matter (*Settings → Speed*):

| Setting | Effect |
|---|---|
| **Thumbnail size** (176px) | Dominant transfer cost. Tests verify hashes stay comparable at this scale and the sharp/blurry ordering is preserved; face detection was measured to hold up too. |
| **Concurrent batches** (3) | The main lever on a fast connection. |

### Where the analysis time goes

Every run reports its own split, because guessing here has been wrong twice and
the four phases answer to completely different fixes. Measured in Chrome, warm,
16 analysis workers over local images — so the fetch column is a floor, not what
a real network costs:

| Phase | Per photo | Share |
|---|---|---|
| fetch | 14.6 ms | 31% |
| decode | 0.7 ms | 1% |
| measure | 2.0 ms | 4% |
| detect faces | 29.3 ms | 63% |

Detection dominates the CPU side. Widening its pool past five barely moves the
total, though — measured 247 to 265 photos/s going from 5 workers to 12 — so the
queue is not where the time sits either. On a real library the fetch column
grows by an order of magnitude and becomes the answer.

---

## What the DOM scanner taught, before it was deleted

Listing used to work by scrolling the grid and reading tiles. It is preserved at
the tag `dom-scanner-v1` and is worth one section, because the whole class of
failure is instructive and none of it is obvious from the outside.

Google Photos virtualises the grid and fills it in two passes: tile skeletons
first, images second. Harvest between the two and the item is recorded with no
thumbnail — listed, counted, and permanently unanalysable. On a real run that
was **1,836 of 2,000 items**.

Five explanations were wrong before the real one. The stall detector was too
impatient; then coverage counted tiles Google never intended to load; then the
harvest recorded a wider band than it had waited for; then a starvation guard
killed the repair passes. Each fix was reasonable and none of them worked. The
actual cause: coverage measured the *presence* of an `<img>` element, and Google
inserts that with the skeleton and fills it a moment later — so coverage read
100% the instant the tiles appeared and the wait never ran at all. The panel
cheerfully reported "100% of thumbnails ready" beside thousands of items with no
thumbnail.

Two lessons survive into the current design:

- **Two notions of "ready" is how you get a contradiction three times.** The
  check and the thing it guards must ask the identical question.
- **Do not record what you cannot use.** An item without a thumbnail is not
  listed at all. Storing it consumed a slot in the run's limit, counted as
  "known" so nothing looked at it again, and needed a repair mechanism that
  could not reach it — it sat *behind* the resume cursor.

The API removes the premise rather than fixing the mechanism: an item and its
thumbnail URL arrive in the same response, so there is no in-between state to
read too early. `skippedNoThumb` is still counted and reported, and should
always be zero — if it stops being zero, something changed on Google's side and
saying so beats a silent gap.

---

## When the extension is reloaded

Reloading or updating an extension does **not** reload the pages it is already
running on. The old content script keeps going — panel on screen, buttons
responding — with a dead `chrome.*` bridge underneath, and every call across it
throws `Extension context invalidated`.

That throw is *synchronous*, which is what makes it nasty:
`chrome.storage.local.set(...).catch(...)` never reaches its catch, because the
exception happens before the promise exists. Observed exactly that way — an
uncaught error in Google's own console, while the panel carried on looking
healthy and saving nothing.

Every call now goes through `src/content/runtime.js`, which turns a dead bridge
into one rejection carrying the only instruction that helps. The panel says so
once rather than once per write, clears whatever it thought it was doing,
disables the run button, and offers a reload — it does not perform one, because
a run may be half done or a selection half made.

If you are working on the extension: after **Reload** in `chrome://extensions`,
reload the Google Photos tab too.

---

## When Google changes something

There are now two surfaces, and they fail differently.

**The API** (`src/api/`). A change here is loud: the transport reports a shape
error naming the call, and the panel prints it. Recovery is a matter of finding
the new index or call id.

| Symptom | Where to look |
|---|---|
| "not signed in" on a page where you plainly are | `TOKEN_KEYS` in `tokens.js`; the MAIN-world script may be reading a renamed key |
| "got a web page instead of data" | The session expired — sign in again |
| "no wrb.fr frame" / "the payload was not JSON" | `parseEnvelope`; the envelope format changed |
| Items listed with no date, or no size | The indices in `parse.js` |
| Nothing listed at all | The `lcxiM` request shape in `photos-api.js` |
| Deletions accepted but nothing disappears | `dedupKey` — the trash call takes it, not the media key |

**The DOM** (`src/content/dom-adapter.js`), which now only serves ticking:

| Symptom | Where to look |
|---|---|
| "Scroll container not found" | `findScroller` |
| 0 tiles detected | `TILE_SELECTOR` |
| "Checkbox not found" | `CHECKBOX_SELECTOR`, `findCheckbox` |
| Thumbnails listed but 0 analysed | `GOOGLE_IMAGE_HOST` in `src/common/images.js` |

Adding an image domain takes two edits, and **both are required**:
`GOOGLE_IMAGE_HOST`, and `host_permissions` in `manifest.json` so the fetch is
not blocked by CORS. A test verifies every recognised host has a permission.

---

## Development

```bash
cd extension
npm test        # 531 tests, no external dependencies
```

No build step. The extension loads as-is; tests run on Node's built-in runner.

Tests cover the classical vision primitives (deterministic synthetic images),
model output decoding, filtering and grouping, consistency invariants between
counters and filters, the contract between the manifest and the import chain,
and — since the migration — the API wire format itself.

Those last ones are the specification, not a regression net: the request shapes
and array indices are undocumented, so `tests/api-transport.test.js`,
`tests/api-parse.test.js` and `tests/photos-api.test.js` record the exact form
known to work. `tests/tokens.test.js` additionally checks that the two files
which both have to know the token key list still agree — a MAIN-world content
script cannot import, so that list is duplicated, and drift there produces a 400
with no explanation anywhere.

`tests/runtime.test.js` pins what happens when the extension is reloaded while
a page is open — see below — including that the panel reaches `chrome.*` only
through the guard, which is the one line that is easy to write unguarded by
accident.

`tests/trash.test.js` pins the rules around the only destructive action: never
without a dedup key, never a size figure that was not measured, never a
confirmation left standing after the selection changed, and no permanent-delete
call anywhere in the source.

The manifest test deserves a note too: the panel is loaded by dynamic import,
and every module reached that way must appear in `web_accessible_resources`, or
Chrome refuses the import — **silently**. It walks the real import graph and
checks each module is declared, and that the token bridge is *not*.

Model inference itself is validated separately, in a browser, against a real
photograph. Unit tests prove the decoding maths; only a browser proves the model
and runtime actually work under the extension's CSP.

**What the tests cannot prove** is that Google still answers the way the tests
say. The three read-only calls were exercised against a live library while this
was written — 2,000 items over four pages, metadata for 400, the date window
honoured to the day, zero items missing a thumbnail. The **move to bin** call
was not: verifying it means deleting somebody's photos, and the shape it sends
is pinned by tests and taken verbatim from a client known to work. If it ever
stops working, the panel reports what Google refused rather than claiming a
success.

### Vendored dependencies

| Path | What | Licence |
|---|---|---|
| `extension/vendor/onnxruntime/` | onnxruntime-web 1.27 (WASM backend) | MIT |
| `extension/vendor/models/ultraface-rfb320.onnx` | UltraFace RFB-320 | MIT |

The recognition model is deliberately **not** here — see the design note above.
It is fetched on demand and kept in the browser.

The detector has had its weights removed from its graph inputs. The exporter of
its era listed all 245 of them there, which blocks constant folding. Measured in
Chrome, on the same input:

| | as exported | cleaned |
|---|---|---|
| Session creation | 1207 ms | **100 ms** |
| One inference | 81.7 ms | **53.6 ms** |

Detections are identical — scores differ by 2.4e-7, against a 0.75 threshold.
Session creation is paid once per worker, five of them, so that first column was
about five seconds of every startup. `tests/vendor.test.js` pins the file's hash
so a hand re-vendoring cannot quietly undo it.

### Credits

The `batchexecute` wire format, the call ids and the response indices come from
[Google-Photos-Toolkit](https://github.com/xob0t/Google-Photos-Toolkit) by
xob0t, MIT licensed. The files here are a port rather than a copy — the parsing
is narrower, the failure modes are separated, and the calls are wrapped in
retry, chunking and cancellation this extension needs — but the knowledge is
theirs, and it would have taken a long time to work out alone.

---

## Privacy

No image data leaves the browser. The library is listed through Google's own
private API using your existing session, exactly as the page itself would;
thumbnails are downloaded from Google's servers and analysed in memory; the
model runs locally. The catalogue stays in IndexedDB on the photos.google.com
origin. No third-party requests, no telemetry.

The People pass adds exactly one non-photo request, the first time you use it:
the recognition model, from Hugging Face. Face vectors are computed in the
browser and stored in IndexedDB alongside the catalogue; the header **↺** clears
them with everything else.

The session tokens the API needs are read from the page and used only to talk to
photos.google.com. They are posted to our own origin, never broadcast, and never
stored.

The **↺** button in the panel header resets the extension to a fresh-install
state immediately, with no confirmation. It is inert during a run.

---

## Known limitations

- Analysis works on 176px thumbnails: very slight blur or very fine text can go
  unnoticed.
- Face detection was validated on public-domain photographs, not on a benchmark
  suite. Small faces in wide scenes are the likeliest misses.
- Items shared into your library by someone else are listed but cannot be
  binned; the confirmation says how many it is leaving alone.
- Photos listed by a version before the API migration have no dedup key, so they
  cannot be binned either. Listing again through the API gives them one.
- Ticking several thousand items slows the Google Photos interface down. Moving
  to the bin does not — it never touches the grid.
- Person grouping has no landmark alignment, which inflates same-person
  distances. The measured margin is +0.34 rather than the +0.50 a larger model
  reaches, so a group flagged **mixed?** in the panel deserves a look before you
  act on it.
- The recognition weights are licensed for non-commercial research use, which is
  why they are downloaded rather than bundled.
- The listing API is private and undocumented. Google can change it without
  notice, and this extension uses it on your own account only — but automating a
  web service sits in a grey area of Google's terms, and the responsibility is
  yours.

---

## Contributing

Issues and pull requests welcome. Two things to know:

- **`src/api/` is where Google breakage lands now**, with `dom-adapter.js` a
  distant second. Include what the panel reported: the errors name the call.
- **Tests are the specification.** Several encode decisions that are easy to
  reverse by accident — trusted-by-name detection methods, videos exempt from
  quality criteria, counters matching filters exactly, unknown sizes never
  counting as small, no deletion without a confirmation. If a change makes one
  fail, the question is whether the decision should change, not the test.

## Licence

MIT — see [LICENSE](LICENSE). Vendored dependencies keep their own licences,
included alongside them.

Not affiliated with, endorsed by, or connected to Google. "Google Photos" is a
trademark of Google LLC.
