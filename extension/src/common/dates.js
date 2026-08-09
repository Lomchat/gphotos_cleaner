/**
 * Date extraction from Google Photos accessibility labels.
 *
 * Google localises its `aria-label` text, so we cannot rely on a single
 * language. This module recognises month names across several locales plus
 * numeric formats, and returns a local timestamp with the precision actually
 * achieved.
 */

const MONTHS = {
  // en
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
  may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
  september: 9, sept: 9, sep: 9, october: 10, oct: 10,
  november: 11, nov: 11, december: 12, dec: 12,
  // fr
  janvier: 1, janv: 1, 'février': 2, fevrier: 2, 'févr': 2, fevr: 2,
  mars: 3, avril: 4, avr: 4, mai: 5, juin: 6, juillet: 7, juil: 7,
  'août': 8, aout: 8, septembre: 9, octobre: 10, novembre: 11,
  'décembre': 12, decembre: 12, 'déc': 12,
  // es / it / pt / de
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7,
  agosto: 8, septiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
  gennaio: 1, febbraio: 2, aprile: 4, maggio: 5, giugno: 6, luglio: 7,
  settembre: 9, ottobre: 10, dicembre: 12,
  janeiro: 1, fevereiro: 2, maio: 5, junho: 6, julho: 7,
  setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
  januar: 1, februar: 2, maerz: 3, 'märz': 3, juli: 7, oktober: 10, dezember: 12
};

const MONTH_KEYS = Object.keys(MONTHS).sort((a, b) => b.length - a.length);
const MONTH_ALT = MONTH_KEYS.map(escapeRe).join('|');

const RE_DMY_TEXT = new RegExp(
  String.raw`\b(\d{1,2})\s*(?:er)?\s+(${MONTH_ALT})\.?\s*,?\s+(\d{4})\b`, 'i');
const RE_MDY_TEXT = new RegExp(
  String.raw`\b(${MONTH_ALT})\.?\s+(\d{1,2})\s*,?\s+(\d{4})\b`, 'i');
const RE_DMY_NUM = /\b(\d{1,2})[./-](\d{1,2})[./-](\d{4})\b/;
const RE_ISO = /\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/;
const RE_COMPACT = /\b(\d{4})(\d{2})(\d{2})\b/;
const RE_MY_TEXT = new RegExp(String.raw`\b(${MONTH_ALT})\.?\s+(\d{4})\b`, 'i');
const RE_Y = /\b(19\d{2}|20\d{2})\b/;

const RE_TIME = /\b(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM|am|pm)?\b/;
const RE_DURATION = /\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b/;

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function monthOf(name) {
  const k = String(name).toLowerCase().replace(/\.$/, '');
  if (MONTHS[k] != null) return MONTHS[k];
  // Locales abbreviate differently; accept a prefix match.
  for (const key of MONTH_KEYS) {
    if (key.startsWith(k) && k.length >= 3) return MONTHS[key];
  }
  return null;
}

function mk(y, m, d, hh, mm, ss) {
  if (!y || y < 1900 || y > 2200) return null;
  const t = new Date(y, Math.min(12, Math.max(1, m || 1)) - 1,
    Math.min(31, Math.max(1, d || 1)), hh || 0, mm || 0, ss || 0, 0);
  return Number.isNaN(t.getTime()) ? null : t.getTime();
}

/**
 * @param {string} text
 * @returns {{ts:number, precision:'day'|'month'|'year'}|null}
 */
export function parseDateFromText(text) {
  if (!text) return null;
  const s = String(text);
  let m;

  if ((m = RE_ISO.exec(s))) {
    const r = mk(+m[1], +m[2], +m[3]);
    if (r != null) return withTime(s, r, 'day');
  }
  if ((m = RE_DMY_TEXT.exec(s))) {
    const mo = monthOf(m[2]);
    const r = mo && mk(+m[3], mo, +m[1]);
    if (r != null) return withTime(s, r, 'day');
  }
  if ((m = RE_MDY_TEXT.exec(s))) {
    const mo = monthOf(m[1]);
    const r = mo && mk(+m[3], mo, +m[2]);
    if (r != null) return withTime(s, r, 'day');
  }
  if ((m = RE_DMY_NUM.exec(s))) {
    // Ambiguous day/month: assume day-first unless impossible.
    let d = +m[1];
    let mo = +m[2];
    if (mo > 12 && d <= 12) [d, mo] = [mo, d];
    const r = mk(+m[3], mo, d);
    if (r != null) return withTime(s, r, 'day');
  }
  if ((m = RE_COMPACT.exec(s))) {
    const r = mk(+m[1], +m[2], +m[3]);
    if (r != null) return withTime(s, r, 'day');
  }
  if ((m = RE_MY_TEXT.exec(s))) {
    const mo = monthOf(m[1]);
    const r = mo && mk(+m[2], mo, 1);
    if (r != null) return { ts: r, precision: 'month' };
  }
  if ((m = RE_Y.exec(s))) {
    const r = mk(+m[1], 1, 1);
    if (r != null) return { ts: r, precision: 'year' };
  }
  return null;
}

/**
 * Only attach a time when it follows a comma or an "at" word — otherwise a
 * video duration at the start of the label would be read as a clock time.
 */
function withTime(s, ts, precision) {
  const ctx = /(?:,\s*|\bà\s+|\bat\s+|\bum\s+)(\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM|am|pm)?)/.exec(s);
  if (!ctx) return { ts, precision };
  const t = RE_TIME.exec(ctx[1]);
  if (!t) return { ts, precision };
  let hh = +t[1];
  const ampm = t[4] && t[4].toLowerCase();
  if (ampm === 'pm' && hh < 12) hh += 12;
  if (ampm === 'am' && hh === 12) hh = 0;
  const d = new Date(ts);
  d.setHours(hh, +t[2], t[3] ? +t[3] : 0, 0);
  return { ts: d.getTime(), precision };
}

/**
 * Video duration from a label ("Video - 0:32").
 * @returns {number|null} seconds
 */
export function parseDurationFromText(text) {
  if (!text) return null;
  const s = String(text);
  const looksVideo = /\bvid[eé]o\b|\bvideo\b|\bdur[ée]e\b|\bduration\b|\blength\b/i.test(s);
  const whole = /^\s*\d{1,2}:\d{2}(?::\d{2})?\s*$/.test(s);
  if (!looksVideo && !whole) return null;
  const m = RE_DURATION.exec(s);
  if (!m) return null;
  const c = m[3] != null ? +m[3] : null;
  return c == null ? +m[1] * 60 + +m[2] : +m[1] * 3600 + +m[2] * 60 + c;
}

export function isVideoLabel(text) {
  return /\bvid[eé]o\b|\bvideo\b|\bfilm\b|\bmovie\b/i.test(String(text || ''));
}

/* Aggregation keys — lexicographic order matches chronological order. */
export function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function monthKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}
export function yearKey(ts) {
  return String(new Date(ts).getFullYear());
}
function pad(n) {
  return n < 10 ? `0${n}` : String(n);
}

/** Fixed en-GB format: day-first is unambiguous and reads well everywhere. */
export function formatDate(ts, precision = 'day') {
  if (ts == null) return 'Unknown date';
  const d = new Date(ts);
  if (precision === 'year') return String(d.getFullYear());
  if (precision === 'month') {
    return d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  }
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
