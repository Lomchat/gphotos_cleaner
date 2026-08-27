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
- **Look through videos** — off by default, and the only setting here that
  costs real bandwidth. It samples four moments of each video instead of
  judging it by its cover frame. Measured: the video rendition runs at about
  96 KB per second, so the switch states what it would download before you
  press it, capped at the first 45 seconds of each.

Stop halts every stage. It is not instant — each checks between batches — so
the click is acknowledged straight away, and whatever was read is kept.

### 2 · Sort

The work happens in the full-screen view: criteria on the left, orders across
the top, thumbnails filling the rest. Each tile shows when the photo was taken
and what it costs. **Right-click any photo** to see it full size — videos play
— or use the button in its corner. There, **← and →** walk through the grid in
the order it is showing, the **wheel zooms towards the cursor**, dragging moves
a zoomed photo, a double-click fits it again, and **Escape** closes it.

**Everything / Photos / Videos** sits at the head of the column and decides
what the criteria below it are even looking at. It is a lens rather than a
criterion on purpose: criteria combine, and in the default *any* mode they
union — so a "videos" checkbox ticked beside "blurry" would give *videos or
blurry photos*, which is the opposite of what "only videos" means.

**Criteria narrow what is shown; they never select anything.** A criterion is
a guess — the screenshot detector is only "fair", blur has a threshold someone
dragged — and turning a guess into a selection would put a thousand photos one
click from the bin before anyone had looked at one. Selecting is the judgement,
and it stays yours; **Tick all (1,240)** takes a whole answer at once when the
rule really is trusted.

The number beside each criterion is exactly what ticking it would show —
including through the lens, since both read the same pool. A selection survives
a change of order, but never a photo leaving the grid: the count and the weight
beside it always describe something visible.

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

### Protecting a person

Open any photo and the faces found in it appear along the bottom. **Protect**
one and no photo containing that person is ever offered again — they are kept
out of the grid entirely, in this run and every run after it.

A protection stores the **face**, not a group id. Group ids are positional and
rebuilt every time the faces are regrouped, so an id saved today would point at
somebody else tomorrow — shielding the wrong person and exposing the one it was
meant to protect. It matches whole faces rather than groups for the same kind of
reason: a group needs two faces to exist, so a protected person appearing once
in a photo would form none and that photo would slip through.

The identity taken is the centroid of that person's whole group where there is
a usable one — it has averaged away the lighting and angle of any single shot,
so it recognises them in photographs that look nothing like the one in hand.
But a group is only borrowed when it looks like **one** person: a group holding
more faces than photographs has merged two people, and its centroid would
protect them both. On a photo of four friends, protecting one used to protect
all four. Otherwise the face itself is the identity — it generalises less and
is unambiguous, which is the right way round for a decision that hides
photographs.

The **Protected** tab lists everyone, as a face, with how many photos each is
holding back. A protection is invisible by construction — it works by making
photographs not appear — so the only way to check one was meant is to look at
the person it holds.

**The reset does not clear this**, deliberately — a reset that dropped it would
leave the next run offering exactly the photos it was told never to touch. Each
protection has its own ✕, and *Show them anyway* puts the photos back on screen
without lifting anything.

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

Videos are read for faces too. They used to be skipped, on the reasoning that a
video's thumbnail is one arbitrary frame — which is why the *quality* criteria
exempt them, since a frame can be blurred or black while the video is neither.
For recognition the argument inverts: a face legible in that frame is a real
face. Skipping them meant every video of a protected person stayed on offer.

By default a video is judged by its cover frame, which is free and already
fetched. Switch on **Look through videos** and four moments are sampled
instead — bounded, because there is no way to decode a frame without the video
leading up to it. Faces are then deduplicated *within* each video: five frames
of one person are one person, and storing five would inflate their group, skew
the rarest-people order, and break the rule that two faces sharing a photo id
are two different people. Anything that fails to decode falls back to the cover
frame.

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

**Grouping is tuned from a real library, not from portraits.** Two faces in one
photograph are almost never the same person, which gives a stranger baseline
with no labelling at all; each face's nearest neighbour in *another* photograph
stands in for same-person. Measured over 4,582 faces:

| | median | 90th |
|---|---|---|
| same person | 0.41 | 0.61 |
| strangers | 0.86 | — (5th is 0.65) |

The two separate cleanly, so the threshold sits at **0.55**. An earlier build
shipped 0.75 on the argument that a real library is messier than a portrait
set. It is — but the measurement says the opposite of what that argument
predicted, and 0.75 put 16% of stranger pairs inside the threshold.

A stored value above 0.63 is corrected once, because a changed default reaches
only people who have never saved a setting — which is exactly the people it
does not need to reach. The panel says what moved and offers to put it back.

**The merge pass is stricter than the assignment**, at 0.8× the threshold.
Merging is transitive — A joins B, then AB joins C — so the same bar lets a
cluster walk along a library's near-misses until it holds everybody. At 0.75
with an equal bar, one group contained **96% of every face**, and 96% of
multi-face photographs had two of their faces in it. Retuned:

| threshold | merge | groups | biggest group | strangers merged |
|---|---|---|---|---|
| 0.75 | 1.0 | 23 | 96% | 96% |
| 0.55 | 0.8 | 306 | 10% | 7.5% |

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
npm test        # 773 tests, no dependencies
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
- Person grouping has no landmark alignment. ArcFace expects faces rotated to
  canonical eye and mouth positions; UltraFace reports boxes only, so the crops
  are unaligned and same-person distances are wider than they need to be. This
  is the largest remaining lever on recognition quality, and it needs a
  detector that reports landmarks.
- A group flagged **mixed?** still deserves a look before you act on it.
- The listing API is private and undocumented. Google can change it without
  notice, and automating a web service sits in a grey area of their terms. The
  extension acts only on your own account; the responsibility is yours.

<br>

## Licence

MIT — see [LICENSE](LICENSE). Vendored dependencies keep their own licences.

Not affiliated with, endorsed by, or connected to Google. "Google Photos" is a
trademark of Google LLC.
