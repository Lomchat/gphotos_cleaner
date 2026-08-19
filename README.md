# GPhotos Cleaner

A Chrome extension that helps you clear out a Google Photos library. It reads
your library, measures every photo **locally**, and gives you a grid built for
one job: deciding what goes.

No account access, no API keys, no server, no build step. No image ever leaves
your browser.

<br>

## What it does

**Lists your library in seconds.** It asks Google Photos through the same
private API its own web app uses — 2,000 photos in about 4.6 seconds, with
dates, dimensions, durations, file names and sizes included.

**Measures every thumbnail, in your browser.** Blur, exposure, near-duplicate
fingerprints, screenshots, documents, and a real face detector. Nothing is
uploaded; the model runs locally.

**Groups your library by person**, so *"every photo without Grandma in it"*
becomes a filter. This needs a 13 MB recognition model, downloaded once.

**Sorts, and then lets you act.** Thirteen criteria you can combine, nine
orders, and a grid that groups photos by person, by day or by lookalike so you
can decide about a whole set at once.

**Removes what you chose**, as a move to Google's bin — recoverable for 60
days, behind a confirmation that states how many photos and how much storage.
Or it just ticks them in Google Photos and leaves the last click to you.

**Remembers what you kept**, so the next run does not offer you the same
eighteen hundred photos you already spared.

<br>

## Install

1. Open `chrome://extensions`, enable **Developer mode**
2. **Load unpacked** → select the `extension/` folder
3. Open [photos.google.com](https://photos.google.com) and reload the tab
4. A **Clean up** badge appears at the top right

Chrome 116 or newer.

<br>

## Using it

### 1 · Analyse

One button. Three things bound it, and a banner says what the next run will do:

- **Only photos older than** — 6 months, 5 years, a date. This is a request
  parameter, not a filter applied afterwards: the listing simply starts there.
  Once a run has happened there is also **Carry on from …**, the oldest photo
  any run has reached. The months are relative to today and drift with it; that
  one is a fact, so it continues the work instead of restarting a window over
  it. It only ever moves further back, and it is the one thing the reset does
  not clear — everything else can be rebuilt by running again.
- **Limit per run** — 2,000 by default. Progress is kept; a rerun resumes.
- **File names and sizes**, and **grouping by person** — both on by default.

Stop halts every stage. It is not instant — each checks between batches — so
the click is acknowledged straight away, and whatever was read is kept.

### 2 · Sort

The work happens in the full-screen view: criteria on the left, orders across
the top, thumbnails filling the rest. Each tile shows when the photo was taken
and what it costs. **Right-click any photo** to see it full size — videos play
— or use the button in its corner. In that view the **wheel zooms towards the
cursor**, dragging moves a zoomed photo, and a double-click fits it again.

With no criterion ticked you are browsing the whole library and nothing is
selected. Tick one and everything it matches is selected for you. The number
beside each criterion is exactly what ticking it would select.

**Orders are a reason to look, not a filter** — they change where a photo sits,
never whether it is selected. Three of them split the grid into blocks you can
select whole:

| Order | One block per |
|---|---|
| Rarest people | person, rarest first |
| Oldest / Newest | day |
| Lookalikes | set of near-identical shots, largest first |

The others — most suspicious, surely nobody, biggest files, blurriest, darkest
— rank photos individually. Anything an order cannot judge always sinks to the
bottom rather than floating to the top where people skim and select.

Click to select, **Shift-click** for a run. The footer shows how many are
selected and **what they weigh**.

### 3 · Remove

**Move to bin** asks first, then moves them to Google's bin, where they stay
recoverable for 60 days. The confirmation states the count, the storage freed,
and what it will skip — photos shared by someone else, and photos listed by a
version too old to hold the key the call needs.

**Tick in Photos** does the older thing: ticks your selection in Google's own
grid and stops, leaving the last click to you.

**Keep the rest** marks everything shown but not selected as decided, so it
stays out of the next run. That is what makes this usable more than once.

<br>

## What it can detect

Visual measurements are taken on the 176px thumbnail. Size and file name come
from Google's own metadata.

| Criterion | How | Reliability |
|---|---|---|
| People present | UltraFace RFB-320 neural detector, in-browser | Good |
| Blurry | Laplacian variance, corrected to spare deliberate background blur | Good |
| Dark / overexposed | Luminance statistics and share of extreme pixels | Good |
| Near-duplicates | dHash + aHash, grouped by Hamming distance in a time window | Good |
| Screenshots | Axis-aligned edges, flat areas, screen aspect ratio, status bar | Fair |
| Documents | Pale desaturated background, bimodal histogram, text lines | Fair |
| Large files / long videos | Google's metadata | Exact |
| A given person | ArcFace `buffalo_s` embeddings, agglomerative grouping | Good |

A photo with no size figure **never** matches "large files" and sinks in the
size order. Unknown is not small.

<br>

## How it works

```
main-world.js   reads the session tokens from the page's own world
      │
content.js ─▶ panel.js ─┬─▶ api-scanner.js ─▶ photos-api.js ─▶ [Google Photos API]
                        ├─▶ analyze-client.js ─▶ offscreen.js ─▶ worker pool
                        ├─▶ people-client.js  ─▶ offscreen.js ─▶ face + recognition pools
                        ├─▶ trash-client.js   ─▶ photos-api.js
                        └─▶ db.js (IndexedDB, on the photos.google.com origin)
```

| Directory | What lives there |
|---|---|
| `src/api/` | The private API: wire format, request shapes, response parsing |
| `src/content/` | Listing, analysis, deletion, the catalogue |
| `src/analysis/` | Vision primitives, face detection, recognition, clustering |
| `src/common/` | Filters, orders, statistics — pure and testable |
| `src/ui/` | The panel, in a Shadow DOM |
| `src/page/` | The one file that runs in the page's own world |

### Decisions worth knowing

**Speed is about requests in flight, not image size.** Measured on a live
library: one thumbnail takes 122 ms alone and 13 ms with sixteen outstanding,
and at that point a 512px rendition costs the same as a 176px one. Throughput
climbs to about 48 concurrent and then flattens near 155 images/s. So the pool
is sized in *photos in flight* rather than worker threads — each worker carries
several — and the analysis and face passes run at the same time, because one is
bound by the link and the other by the CPU.

**Grouping ships at 0.75, outside the measured window.** Same person at worst
0.48, closest strangers 0.63 — but that window was read off studio portraits.
A real library is profiles, sunglasses and twenty years of ageing, where 0.6
scatters one person across six groups. At 0.75 two people will occasionally
share a group; the panel says so at that value, flags wide groups as **mixed?**,
and the slider goes back down to 0.45.

**The extension can only move photos to the bin.** No permanent delete, no
emptying, no restore — Google's own interface does all three. That
reversibility is what makes a delete button acceptable to ship at all, so it is
stated on the confirmation. A local row is dropped only after Google confirms
taking the photo.

**"Not analysed" is never "nobody in it."** A photo the face pass has not read
has no `people` field, and *without selected people* refuses to match it.

**One predicate table.** Filtering, the counters and the statistics all read
`CRITERION_TESTS`, so the number beside a checkbox is exactly what ticking it
selects. A test locks that.

**The recognition model is not bundled.** InsightFace weights are licensed for
non-commercial research use and this repository is MIT, so shipping the file
would redistribute it under terms this repository cannot grant. It is fetched
once, on consent, and cached in the extension's own storage.

<br>

## When something breaks

Two undocumented surfaces, and they fail differently.

**The API** (`src/api/`) fails loudly: the transport names the call and the
kind of failure, and the panel prints it.

| Symptom | Look at |
|---|---|
| "not signed in" on a page where you are | `TOKEN_KEYS` — a renamed key |
| "got a web page instead of data" | the session expired; sign in again |
| "no wrb.fr frame" / "payload was not JSON" | `parseEnvelope` — the envelope changed |
| Items with no date or no size | the indices in `parse.js` |
| Deletions accepted, nothing disappears | `dedupKey` — the trash call takes it, not the media key |

**The DOM** (`src/content/dom-adapter.js`), which now only serves ticking:
`findScroller`, `TILE_SELECTOR`, `CHECKBOX_SELECTOR`. If thumbnails are listed
but never analysed, look at `GOOGLE_IMAGE_HOST` in `src/common/images.js` — and
note that adding an image domain needs a matching `host_permissions` entry,
which a test enforces.

**After reloading the extension, reload the Google Photos tab.** Chrome leaves
the old content script running with a dead `chrome.*` bridge; the panel detects
this and offers a reload rather than failing silently.

<br>

## Development

```bash
cd extension
npm test        # 669 tests, no dependencies
```

No build step. The extension loads as-is.

The tests are the specification, not a safety net. They pin an undocumented
wire format, the rules around the only destructive action, and a number of
decisions that are easy to reverse by accident. Several were written by
reintroducing the bug they describe and watching them fail.

The three read-only API calls were exercised against a live library.
`moveItemsToTrash` was not — verifying it means deleting real photos — so its
shape is pinned by tests, and a refusal is reported rather than counted as
success.

### Vendored

| Path | What | Licence |
|---|---|---|
| `extension/vendor/onnxruntime/` | onnxruntime-web 1.27 (WASM) | MIT |
| `extension/vendor/models/ultraface-rfb320.onnx` | UltraFace RFB-320 | MIT |

The detector has had its weights removed from its graph inputs, which was
blocking constant folding: session creation went from 1207 ms to 100 ms and
inference from 81.7 ms to 53.6 ms, with detections identical to 2.4e-7.
`tests/vendor.test.js` pins the file's hash so a hand re-vendoring cannot
quietly undo it.

<br>

## Thanks

### [Google-Photos-Toolkit](https://github.com/xob0t/Google-Photos-Toolkit) — xob0t

This project would not exist in its current form without it.

Google Photos offers no public API for any of this. Its web app talks to itself
over an endpoint called `batchexecute`: a POST carrying calls named by
obfuscated ids, with arguments as a JSON string nested inside another JSON
string, answered by unnamed positional arrays. None of it is documented
anywhere.

**xob0t worked all of that out.** The wire format, the call ids, the field
mask, and the position of every field in every response — `mediaKey` at 0,
`dedupKey` at 3, a video's duration hidden behind the key `76647426` in a
trailing object. Reverse-engineering that takes patience, a packet capture and
a great deal of guessing, and it is by far the hardest part of what this
extension does.

Before finding the toolkit, this extension listed photos by scrolling the page
and reading the DOM. It was slow, and it was wrong: a real run listed 2,000
photos and could analyse 127 of them, because thumbnails arrive after the tiles
they belong to. The API did not fix that problem — it removed it.

The code here is a port rather than a copy: narrower parsing, separated failure
modes, retries and cancellation this extension needs. But the *knowledge* is
theirs. Google-Photos-Toolkit is MIT licensed, is considerably more capable than
the handful of calls used here, and is worth your attention if you want to do
anything with Google Photos programmatically.

<br>

## Privacy

No image data leaves your browser. The library is listed through Google's own
private API with your existing session; thumbnails are downloaded from Google
and analysed in memory; the catalogue stays in IndexedDB on the
photos.google.com origin. No third-party requests, no telemetry.

The only non-photo download is the recognition model, once, from Hugging Face,
and only if you leave grouping switched on.

Session tokens are read from the page and used only to talk to
photos.google.com. They are posted to our own origin, never broadcast, never
stored.

The **↺** in the panel header resets everything to a fresh install.

<br>

## Known limitations

- Analysis works on 176px thumbnails: very slight blur or very fine text can go
  unnoticed.
- Face detection was validated on public-domain photographs, not a benchmark.
  Small faces in wide scenes are the likeliest misses.
- Photos shared into your library by someone else cannot be binned; the
  confirmation says how many it is leaving alone.
- Person grouping has no landmark alignment, which inflates same-person
  distances — a group flagged **mixed?** deserves a look before you act on it.
- The listing API is private and undocumented. Google can change it without
  notice, and automating a web service sits in a grey area of their terms. The
  extension acts only on your own account; the responsibility is yours.

<br>

## Licence

MIT — see [LICENSE](LICENSE). Vendored dependencies keep their own licences.

Not affiliated with, endorsed by, or connected to Google. "Google Photos" is a
trademark of Google LLC.
