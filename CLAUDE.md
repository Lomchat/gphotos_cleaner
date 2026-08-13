# GPhotos Cleaner — working notes

A Chrome MV3 extension that analyses a Google Photos library locally and helps
decide what to delete. No bundler, no build step, no runtime dependencies.

## Keep the documentation current

**Every change that alters behaviour updates `README.md` in the same commit,
and this file when it changes how the project is worked on.** Not afterwards,
not "later" — a README describing a version that no longer exists is worse than
no README, because it is believed. The same goes for the test count quoted
under *Development*.

Nothing here is generated. If a paragraph explains machinery that has been
deleted, delete the paragraph.

## What is worth knowing before changing anything

**Tests are the specification.** Several encode decisions that are easy to
reverse by accident: unknown sizes never count as small, videos are exempt from
visual-quality criteria, the number beside a criterion equals what ticking it
selects, no deletion without a confirmation. If a change makes one fail, the
question is whether the decision should change — not whether the test should.

**Two undocumented surfaces.** `src/api/` speaks Google's private
`batchexecute`; `src/content/dom-adapter.js` is what remains of reading the
page, and now serves only ticking. Request shapes and array indices are pinned
by tests because nothing else documents them.

**Repaint, never re-render.** A running job holds references to the nodes it
writes into. Rebuilding a tab replaces them, the job then reports to detached
elements, and the grid scrolls back to the top under whoever was using it. This
has been the cause of four separate bugs. `paintSelection`, `paintProgress` and
`paintActions` exist for it, and `log()` drops a target that has been
disconnected rather than pretending.

**Measure before claiming.** The fetch ceiling was "16 concurrent" until it was
measured warm and turned out to be 48. Numbers in the README are real
measurements; if you cannot measure it, do not put a number on it.

## Commits

Author is the user alone. Never add `Co-Authored-By: Claude`, any other
AI attribution, or Claude as a repository collaborator.

Commit messages explain *why*, in prose, including what was tried and rejected.

## Commands

```bash
cd extension
npm test          # Node's built-in runner, no dependencies
```

Load unpacked from `extension/`. After reloading the extension, reload the
Google Photos tab too — Chrome leaves the old content script running with a
dead `chrome.*`.
