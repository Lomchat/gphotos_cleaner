/**
 * Reading faces out of a video rather than out of one still.
 *
 * A video's thumbnail is a single arbitrary frame. For the quality criteria
 * that is a reason to *exempt* videos — a frame can be blurred or black while
 * the video is neither. For recognition the argument inverts: if a face is
 * legible in that frame it is a real face, and the only thing a single frame
 * costs is everything it happens to miss. Half this library's videos show a
 * face on their poster; the other half may still be full of them.
 *
 * The cost is the whole design problem. Measured against a live library:
 * `=m18` runs at about **96 KB per second of video**, and there is no way to
 * decode a frame without the bytes leading up to it — a partial MP4 with no
 * moov atom decodes to nothing. Sampling every video whole would be 5.3 GB.
 * So every video is capped: short ones arrive complete, long ones give up
 * their opening, and nothing is unbounded.
 *
 * Two rules that are less obvious and matter more:
 *
 * **Faces are deduplicated within a video.** Five frames of one person are
 * five embeddings of one person, and storing them all would inflate that
 * person's group fivefold, skew the "rarest people" order, and — worst —
 * break the invariant that two faces sharing a photo id are two *different*
 * people. Protection leans on that invariant to tell a clean group from a
 * merged one.
 *
 * **Anything that fails falls back to the poster frame**, which is what the
 * pass did before this existed. A video that cannot be decoded is then no
 * worse off than it was.
 */

import { normalise, toVector, distance } from './cluster.js';

/** Bytes fetched per video, at most. About 45 seconds at the measured rate. */
export const BYTE_CAP = 4 * 1024 * 1024;

/** Frames sampled from one video. */
export const FRAME_COUNT = 4;

/** How long to wait for a seek before giving up on a video. */
export const SEEK_TIMEOUT_MS = 6000;

/**
 * Which instants to sample.
 *
 * Never the very start: videos open on a fade, a lens cap, a hand over the
 * camera. Never the very end either, which is usually the phone being lowered.
 * The interior is spread evenly, so a person who appears once anywhere in the
 * middle is caught.
 *
 * `usable` is what can actually be decoded — with a byte cap that is often
 * less than the duration, and seeking past it hangs rather than fails.
 */
export function frameTimes(duration, usable = duration, count = FRAME_COUNT) {
  const end = Math.min(
    Number.isFinite(duration) && duration > 0 ? duration : 0,
    Number.isFinite(usable) && usable > 0 ? usable : 0
  );
  if (!end) return [];
  // Very short clips get one frame from the middle; more would be the same
  // picture several times over.
  if (end < 1.5) return [+(end / 2).toFixed(2)];

  const n = Math.max(1, Math.min(count, Math.round(end)));
  const times = [];
  for (let i = 0; i < n; i++) {
    // Evenly through the interior: for n = 4 that is 10%, 37%, 63%, 90%.
    const frac = n === 1 ? 0.5 : 0.1 + (0.8 * i) / (n - 1);
    times.push(+(end * frac).toFixed(2));
  }
  return [...new Set(times)];
}

/**
 * One face per person, out of everything the frames found.
 *
 * Greedy against what has been kept: a face close to one already held is the
 * same person seen again, and the better of the two is the one the detector
 * was more confident about. Order matters only in that the strongest survives,
 * which is why the list is sorted before the walk.
 */
export function dedupeFaces(faces, eps = 0.55) {
  const kept = [];
  const units = [];
  // Strongest first, so a clean frontal face is the one that represents the
  // person rather than whichever frame happened to be sampled first.
  const ordered = [...faces].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  for (const face of ordered) {
    let unit;
    try {
      unit = normalise(toVector(face.vector));
    } catch {
      continue;
    }
    let seen = false;
    for (const other of units) {
      if (distance(unit, other) <= eps) { seen = true; break; }
    }
    if (seen) continue;
    kept.push(face);
    units.push(unit);
  }
  return kept;
}

/**
 * Pull frames out of a video, as ImageBitmaps.
 *
 * The bytes are fetched rather than handed to a `<video src=…>` because a
 * cross-origin video taints the canvas, and a tainted canvas cannot be read —
 * which is the entire point here. Fetched, they become a blob URL, which is
 * same-origin and readable.
 *
 * Every failure path returns what it has rather than throwing: a video that
 * yields two frames instead of four is still worth those two, and the caller
 * falls back to the poster when it yields none.
 */
export async function grabFrames(url, {
  duration = 0,
  byteCap = BYTE_CAP,
  count = FRAME_COUNT,
  timeoutMs = SEEK_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  documentImpl = globalThis.document
} = {}) {
  if (!documentImpl?.createElement) return { frames: [], reason: 'no document' };

  let blobUrl = null;
  let video = null;
  const frames = [];
  try {
    const res = await fetchImpl(url, {
      credentials: 'include',
      // Capped. Google serves 206 for these, and a short video simply arrives
      // whole.
      headers: { Range: `bytes=0-${byteCap - 1}` }
    });
    if (!res.ok && res.status !== 206) return { frames: [], reason: `HTTP ${res.status}` };
    const blob = await res.blob();
    if (!blob.size) return { frames: [], reason: 'empty' };

    blobUrl = URL.createObjectURL(blob);
    video = documentImpl.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.src = blobUrl;

    await waitFor(video, 'loadedmetadata', timeoutMs);

    // What the capped download can actually reach. Seeking past the buffered
    // end does not fail, it simply never completes.
    const buffered = video.buffered?.length ? video.buffered.end(video.buffered.length - 1) : 0;
    const usable = buffered > 0.2 ? buffered : (video.duration || duration);
    const times = frameTimes(video.duration || duration, usable, count);

    const canvas = new OffscreenCanvas(
      Math.max(1, video.videoWidth || 640),
      Math.max(1, video.videoHeight || 480)
    );
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    for (const t of times) {
      try {
        video.currentTime = t;
        await waitFor(video, 'seeked', timeoutMs);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        frames.push(await createImageBitmap(canvas));
      } catch {
        // One unreachable instant is not a reason to abandon the others.
        break;
      }
    }
    return { frames, reason: frames.length ? null : 'no frame decoded' };
  } catch (err) {
    return { frames, reason: String(err?.message || err) };
  } finally {
    if (video) { video.src = ''; try { video.load(); } catch { /* already gone */ } }
    if (blobUrl) URL.revokeObjectURL(blobUrl);
  }
}

function waitFor(node, event, timeoutMs) {
  return new Promise((resolve, reject) => {
    const done = () => { clean(); resolve(); };
    const failed = () => { clean(); reject(new Error(event)); };
    const timer = setTimeout(failed, timeoutMs);
    const clean = () => {
      clearTimeout(timer);
      node.removeEventListener(event, done);
      node.removeEventListener('error', failed);
    };
    node.addEventListener(event, done, { once: true });
    node.addEventListener('error', failed, { once: true });
  });
}
