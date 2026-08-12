/**
 * Turning Google's positional arrays into items this extension understands.
 *
 * The responses are arrays indexed by position, with optional fields hidden
 * behind large numeric keys in a trailing object. Nothing is named. So the
 * indices are written down once, here, with what they mean — and every field is
 * read defensively, because a shorter array from a future release must produce
 * a missing value rather than an exception that kills a whole page.
 *
 * Adapted from Google-Photos-Toolkit (xob0t), MIT.
 */

import { withThumbSize } from '../common/images.js';

/** Keys inside the trailing options object of a library item. */
const OPT = {
  duration: 76647426,
  favourite: 163238866,
  description: 396644657,
  livePhoto: 146008172,
  location: 129168200
};

const at = (arr, i) => (Array.isArray(arr) ? arr[i] : undefined);
const last = (arr) => (Array.isArray(arr) && arr.length ? arr[arr.length - 1] : undefined);

/**
 * One media item from a timeline page.
 *
 * `mediaKey` is the same identifier that appears in a photo's URL, which is
 * what lets a catalogue built by scrolling and one built from the API refer to
 * the same photos.
 */
export function parseItem(raw) {
  if (!Array.isArray(raw) || !raw[0]) return null;
  const opts = last(raw);
  const options = opts && typeof opts === 'object' && !Array.isArray(opts) ? opts : {};
  const thumb = at(raw, 1);
  const duration = at(options[OPT.duration], 0);

  return {
    mediaKey: raw[0],
    // Base URL with no size suffix: callers add their own.
    thumb: at(thumb, 0) || null,
    width: at(thumb, 1) ?? null,
    height: at(thumb, 2) ?? null,
    // Milliseconds since the epoch, as a number or a numeric string.
    timestamp: toNumber(at(raw, 2)),
    timezoneOffset: toNumber(at(raw, 4)),
    creationTimestamp: toNumber(at(raw, 5)),
    // Google's own duplicate identity. Also what the trash call takes.
    dedupKey: at(raw, 3) ?? null,
    isArchived: !!at(raw, 13),
    isFavourite: !!at(options[OPT.favourite], 0),
    // Only videos carry a duration, which is how a video is recognised: there
    // is no explicit flag in this response.
    duration: duration == null ? null : Math.round(toNumber(duration) / 1000),
    isVideo: duration != null,
    isLivePhoto: !!options[OPT.livePhoto],
    description: at(options[OPT.description], 0) || null,
    // A shared item someone else owns: deleting it would not free any space.
    isOwned: !(at(raw, 7) || []).some?.((entry) => Array.isArray(entry) && entry.includes(27))
  };
}

/** A page of the timeline: the items, and how to ask for the next one. */
export function parseTimelinePage(payload) {
  const items = (at(payload, 0) || []).map(parseItem).filter(Boolean);
  return {
    items,
    nextPageId: at(payload, 1) || null,
    lastTimestamp: toNumber(at(payload, 2))
  };
}

/**
 * Bulk metadata: the file name and the bytes it occupies.
 *
 * Neither is in the timeline response, and neither can be had from a thumbnail
 * at all — this is the part the DOM could never provide.
 */
export function parseMediaInfo(raw) {
  if (!Array.isArray(raw) || !raw[0]) return null;
  const info = at(raw, 1);
  const tail = last(info);
  return {
    mediaKey: raw[0],
    fileName: at(info, 3) || null,
    timestamp: toNumber(at(info, 6)),
    size: toNumber(at(info, 9)),
    // Whether it counts against the storage quota, and how much. An item in
    // "storage saver" may take less space than its own size.
    takesUpSpace: at(tail, 0) === undefined ? null : at(tail, 0) === 1,
    spaceTaken: toNumber(at(tail, 1)),
    isOriginalQuality: at(tail, 2) === undefined ? null : at(tail, 2) === 2
  };
}

/**
 * The metadata response wraps its list two levels deep: `payload[0][1]`.
 *
 * Written down because there is nothing to read it off — one wrong index here
 * returns an empty array rather than an error, and the only symptom is a
 * library where nothing has a size.
 */
export function parseMediaInfoPage(payload) {
  const rows = at(at(payload, 0), 1);
  return (Array.isArray(rows) ? rows : []).map(parseMediaInfo).filter(Boolean);
}

function toNumber(value) {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Add a size to a thumbnail base URL.
 *
 * The base carries none, and asking for one is how the cost of a run is
 * controlled: the analysis wants 176px, identity wants 512px. `authUser`
 * carries the account through on a multi-account session, where the bare URL
 * can be refused — the caller keeps the unsized original as a fallback either
 * way.
 */
export function thumbUrl(base, size, { authUser = null } = {}) {
  if (!base) return null;
  const sized = withThumbSize(base, size);
  if (authUser == null || sized.includes('?')) return sized;
  return `${sized}?authuser=${authUser}`;
}
