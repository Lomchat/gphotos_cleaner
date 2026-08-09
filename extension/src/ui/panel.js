/**
 * Cleaning panel.
 *
 * Rendered in a Shadow DOM attached to `documentElement`: Google Photos often
 * replaces the contents of `body`, and a host placed higher survives those
 * rebuilds (a MutationObserver re-inserts it if needed).
 */

import { PANEL_CSS } from './styles.js';
import * as db from '../content/db.js';
import * as dom from '../content/dom-adapter.js';
import {
  Scanner, readCursor, resetCursor,
  repairThumbnails, planThumbRepair, MAX_THUMB_ATTEMPTS
} from '../content/scanner.js';
import { Analyzer } from '../content/analyze-client.js';
import { Selector } from '../content/actions.js';
import {
  DEFAULT_FILTERS, applyFilters, clusterDuplicates, pickKeepers,
  countPerCriterion, computeStats, CRITERION_LABELS
} from '../common/filters.js';
import { formatDate } from '../common/dates.js';

const SETTINGS_KEY = 'gpc:settings';
const FILTERS_KEY = 'gpc:filters';

const DEFAULT_SETTINGS = {
  // 176px: perceptual hashes and the sharp/blurry ordering are stable at this
  // scale (verified by tests) for about half the bytes of 256px — and transfer
  // is the dominant cost.
  thumbSize: 176,
  scanStepRatio: 0.82,
  scanSettleMaxMs: 1200,
  thumbWaitMaxMs: 5000,
  autoRepairThumbs: true,
  autoRepairLimit: 500,
  resumeScan: true,
  // One volume limit per run. A single visible action means a single limit:
  // two separate counters behind one button were impossible to reason about.
  // 0 means no limit.
  maxPerRun: 0,
  analyzeInflight: 3,
  scanOlderThanTs: null  // only handle items older than this date
};

/**
 * Carry settings over from an earlier version.
 *
 * The two pre-merge limits are converted rather than ignored: someone who
 * deliberately bounded their work must not end up with no limit after an
 * update, running an hours-long job they never asked for. We keep the stricter
 * of the two, the only value that carries no risk.
 */
export function migrateSettings(stored) {
  const out = { ...stored };
  if (out.maxPerRun == null) {
    const legacy = [out.scanMaxPerPass, out.analyzeMaxPerPass]
      .filter((v) => Number.isFinite(v) && v > 0);
    if (legacy.length) out.maxPerRun = Math.min(...legacy);
  }
  delete out.scanMaxPerPass;
  delete out.analyzeMaxPerPass;
  // The old time-window key meant the opposite (keep only recent items).
  // Carrying it over would silently invert the scope, so drop it instead.
  delete out.scanSinceTs;
  return out;
}

/**
 * Catalogue size above which duplicate grouping is no longer recomputed while
 * dragging a slider. Measured: 36ms at 5,000 items, 330ms at 50,000 — the
 * latter rules out any fluidity.
 */
const LIVE_CLUSTER_MAX = 6000;

/** Ring instance counter, for unique SVG gradient ids. */
let ringSeq = 0;

function monthsAgo(n) {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export const CRITERIA = [
  {
    key: 'noFace',
    icon: '🌄',
    label: 'No people',
    hint: 'Uses a trained face detector (UltraFace) running locally. Falls back to a skin-tone heuristic if WebAssembly is unavailable, and stays more cautious in that case.',
    controls: [
      { prop: 'noFaceMax', label: 'Max score', min: 0, max: 1, step: 0.05, fmt: pct },
      { prop: 'noFaceMaxSkin', label: 'Max skin', min: 0, max: 0.4, step: 0.01, fmt: pct }
    ]
  },
  {
    key: 'hasFace',
    icon: '🧑',
    label: 'Has people',
    hint: 'Useful to protect these photos: combine with the "all criteria" mode.',
    controls: [{ prop: 'hasFaceMin', label: 'Min score', min: 0, max: 1, step: 0.05, fmt: pct }]
  },
  {
    key: 'screenshot',
    icon: '📱',
    label: 'Screenshots',
    hint: 'Orthogonal geometry, flat colour areas, screen aspect ratio, status bar.',
    controls: [{ prop: 'screenshotMin', label: 'Min score', min: 0, max: 1, step: 0.05, fmt: pct }]
  },
  {
    key: 'document',
    icon: '📄',
    label: 'Documents and text',
    hint: 'Light desaturated background, bimodal histogram, text lines.',
    controls: [{ prop: 'documentMin', label: 'Min score', min: 0, max: 1, step: 0.05, fmt: pct }]
  },
  {
    key: 'blurry',
    icon: '💧',
    label: 'Blurry photos',
    hint: 'Laplacian variance, corrected to spare deliberate background blur.',
    controls: [{ prop: 'blurMin', label: 'Min score', min: 0, max: 1, step: 0.05, fmt: pct }]
  },
  {
    key: 'dark',
    icon: '🌑',
    label: 'Dark photos',
    hint: 'Low mean luminance and a high share of black pixels.',
    controls: [{ prop: 'darkMin', label: 'Min score', min: 0, max: 1, step: 0.05, fmt: pct }]
  },
  {
    key: 'bright',
    icon: '☀️',
    label: 'Overexposed photos',
    hint: 'Blown-out or near-white images.',
    controls: [{ prop: 'brightMin', label: 'Min score', min: 0, max: 1, step: 0.05, fmt: pct }]
  },
  {
    key: 'duplicates',
    icon: '🧬',
    label: 'Near-duplicates',
    hint: 'Bursts and copies. One copy is kept per group; only the others are offered.',
    controls: [
      { prop: 'dupDistance', label: 'Tolerance', min: 0, max: 20, step: 1, fmt: (v) => `${v} bits` },
      { prop: 'dupKeep', label: 'Keep', type: 'select', options: [
        ['sharpest', 'Sharpest'], ['first', 'Oldest'],
        ['last', 'Newest'], ['none', 'None (offer all)']
      ] }
    ]
  },
  {
    key: 'longVideo',
    icon: '🎬',
    label: 'Long videos',
    hint: 'Google Photos does not expose file size in the grid, so duration stands in for it.',
    controls: [{ prop: 'longVideoSec', label: 'Min length', min: 10, max: 1800, step: 10, fmt: dur }]
  },
  {
    key: 'dateRange',
    icon: '📅',
    label: 'Date range',
    hint: 'Restrict to a date interval.',
    controls: [{ prop: 'dateRange', type: 'daterange' }]
  }
];

function pct(v) { return `${Math.round(v * 100)}%`; }
function dur(s) {
  s = Number(s);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return s % 60 ? `${m}m${String(s % 60).padStart(2, '0')}` : `${m} min`;
}
function nf(n) { return Number(n || 0).toLocaleString('en-US'); }

/* --------------------------------------------------------------- helpers */

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in node && k !== 'list') node[k] = v;
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

/* ----------------------------------------------------------------- panel */

export class Panel {
  constructor() {
    this.state = {
      items: [],
      filtered: [],
      selection: new Set(),
      groups: new Map(),
      keepers: new Set(),
      counts: {},
      filters: structuredClone(DEFAULT_FILTERS),
      settings: { ...DEFAULT_SETTINGS },
      tab: 'scan',
      renderLimit: 120,
      busy: null,
      modalOpen: false,
      dupStale: false,
      faceModel: null,
      cursor: null,
      // State shown permanently by the badge, even with the panel closed.
      status: { label: null, ratio: null, tone: null }
    };
    this.statusTimer = null;
    this.scanner = null;
    this.analyzer = null;
    this.selector = null;
    this.dupCache = null;
    this.liveFrame = null;
    this.counterEls = new Map();
  }

  /* ------------------------------------------------------------- montage */

  async mount() {
    this.host = document.createElement('div');
    this.host.id = 'gp-cleaner-root';
    this.host.style.cssText = 'all:initial;position:static';
    this.shadow = this.host.attachShadow({ mode: 'open' });
    this.shadow.append(el('style', { text: PANEL_CSS }));

    this.wrap = el('div', { class: 'wrap' });
    this.shadow.append(this.wrap);
    document.documentElement.append(this.host);

    // Google Photos sometimes rebuilds the tree; re-insert ourselves.
    new MutationObserver(() => {
      if (!this.host.isConnected) document.documentElement.append(this.host);
    }).observe(document.documentElement, { childList: true });

    await this.loadPersisted();
    this.build();
    await this.reload();
    this.renderAll();
  }

  async loadPersisted() {
    try {
      const got = await chrome.storage.local.get([SETTINGS_KEY, FILTERS_KEY]);
      if (got[SETTINGS_KEY]) Object.assign(this.state.settings, migrateSettings(got[SETTINGS_KEY]));
      if (got[FILTERS_KEY]) {
        this.state.filters = {
          ...structuredClone(DEFAULT_FILTERS),
          ...got[FILTERS_KEY],
          enabled: { ...DEFAULT_FILTERS.enabled, ...(got[FILTERS_KEY].enabled || {}) }
        };
      }
    } catch { /* premier lancement */ }
  }

  persist() {
    chrome.storage.local
      .set({ [SETTINGS_KEY]: this.state.settings, [FILTERS_KEY]: this.state.filters })
      .catch(() => {});
  }

  /* -------------------------------------------------------------- squelette */

  build() {
    this.badgeGlyph = el('span', { class: 'glyph idle' });
    this.badgeLabel = el('span', { class: 'label', text: 'Clean up' });
    this.badgeBarFill = el('i');
    this.badgeBar = el('span', { class: 'bar', hidden: true }, this.badgeBarFill);
    this.badge = el(
      'button',
      {
        class: 'badge',
        title: 'Photo Cleaner — open panel',
        onclick: () => this.toggle()
      },
      this.badgeGlyph,
      this.badgeLabel,
      this.badgeBar
    );

    this.panel = el('aside', { class: 'panel', hidden: true });

    this.headerSub = el('span', { class: 'sub' });
    this.headerReset = el('button', {
      class: 'icon-btn danger', text: '↺',
      title: 'Reset everything: catalogue, analyses, settings and filters.\nYour photos are untouched; only the analysis time is lost.',
      onclick: () => this.factoryReset()
    });
    this.panel.append(
      el(
        'header',
        {},
        el('h1', {},
          el('span', { class: 'mark' }, 'Photo'), 'Cleaner',
          this.headerSub),
        this.headerReset,
        el('button', {
          class: 'icon-btn', title: 'Collapse', text: '⤦',
          onclick: () => this.toggle(false)
        })
      )
    );

    this.tabsNav = el('nav', {});
    for (const [key, label] of [
      ['scan', 'Analyse'], ['sort', 'Sort'], ['stats', 'Stats'], ['settings', 'Settings']
    ]) {
      this.tabsNav.append(
        el('button', {
          text: label, 'data-tab': key, role: 'tab',
          onclick: () => { this.state.tab = key; this.renderAll(); }
        })
      );
    }
    this.panel.append(this.tabsNav);

    this.body = el('div', { class: 'body' });
    this.tabs = {
      scan: el('div', { class: 'tab' }),
      sort: el('div', { class: 'tab' }),
      stats: el('div', { class: 'tab' }),
      settings: el('div', { class: 'tab' })
    };
    this.body.append(...Object.values(this.tabs));
    this.panel.append(this.body);

    this.footer = el('footer', {});
    this.panel.append(this.footer);

    this.modal = el('div', { class: 'modal', hidden: true });

    this.wrap.append(this.badge, this.panel, this.modal);

    // Escape closes the modal — the expected reflex for a full-screen view.
    this.wrap.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.modal.hidden) {
        e.stopPropagation();
        this.closeModal();
      }
    });
  }

  openModal() {
    this.state.modalOpen = true;
    this.state.renderLimit = Math.max(this.state.renderLimit, 300);
    this.renderAll();
    this.modal.querySelector('button')?.focus();
  }

  closeModal() {
    this.state.modalOpen = false;
    this.renderAll();
  }

  /**
   * Full-screen sorting view.
   *
   * The side panel is 440px wide, which makes judging hundreds of thumbnails
   * hard — precisely when looking carefully matters most. The modal reuses the
   * same state (same filters, same selection) in a far wider grid.
   */
  renderModal() {
    this.modal.hidden = !this.state.modalOpen;
    if (!this.state.modalOpen) {
      this.modal.replaceChildren();
      return;
    }

    const shown = this.state.filtered.slice(0, this.state.renderLimit);
    const n = this.state.selection.size;

    // Left column: exactly the same controls as the panel. Duplicating their
    // definition would make them diverge on the first addition.
    const side = el('aside', { class: 'side' },
      el('h3', {}, 'Combine'),
      el('div', { class: 'row', style: 'flex-wrap:wrap; gap:6px; margin-bottom:14px' },
        el('button', {
          class: 'chip', 'aria-pressed': String(this.state.filters.mode === 'any'),
          text: 'Any', onclick: () => { this.state.filters.mode = 'any'; this.onFilterChange(); }
        }),
        el('button', {
          class: 'chip', 'aria-pressed': String(this.state.filters.mode === 'all'),
          text: 'All', onclick: () => { this.state.filters.mode = 'all'; this.onFilterChange(); }
        })),
      el('h3', {}, 'Criteria'));
    for (const crit of CRITERIA) side.append(this.buildCriterion(crit));

    const main = el('div', { class: 'main' });
    if (!this.state.filtered.length) {
      main.append(el('div', { class: 'muted' },
        Object.values(this.state.filters.enabled).some(Boolean)
          ? 'Nothing matches the active criteria.'
          : 'Enable at least one criterion on the left.'));
    } else {
      const grid = el('div', { class: 'grid' });
      for (const item of shown) grid.append(this.buildThumb(item));
      main.append(grid);
      if (this.state.filtered.length > shown.length) {
        main.append(el('button', {
          class: 'action wide', style: 'margin-top:12px',
          text: `Show more (${nf(this.state.filtered.length - shown.length)} left)`,
          onclick: () => { this.state.renderLimit += 600; this.renderAll(); }
        }));
      }
    }

    this.modalCount = el('span', { class: 'count' },
      `${nf(this.state.filtered.length)} matching · ${nf(n)} ticked`);

    this.modal.replaceChildren(
      el('header', {},
        el('h2', {}, 'Sort your library'),
        this.modalCount,
        el('span', { class: 'spacer' }),
        el('button', { class: 'action', text: 'Tick all', onclick: () => {
          this.state.selection = new Set(this.state.filtered.map((i) => i.id));
          this.renderAll();
        } }),
        el('button', { class: 'action', text: 'Untick all', onclick: () => {
          this.state.selection = new Set();
          this.renderAll();
        } }),
        el('button', { class: 'icon-btn', text: '✕', title: 'Close (Esc)', onclick: () => this.closeModal() })),
      el('div', { class: 'layout' }, side, main),
      el('footer', {},
        el('div', { class: 'summary' },
          el('b', {}, nf(n)), ' ticked · ',
          el('span', { class: 'muted' }, 'the extension ticks, you decide to delete')),
        el('button', {
          class: 'action primary',
          text: `Tick in Google Photos${n ? ` (${nf(n)})` : ''}`,
          disabled: !!this.state.busy || !n,
          onclick: () => { this.closeModal(); this.startSelect(); }
        }))
    );
  }

  /** Tickable thumbnail, shared by the side preview and the modal. */
  buildThumb(item) {
    const on = this.state.selection.has(item.id);
    return el(
      'div',
      {
        class: `thumb${on ? ' on' : ''}${item.isVideo ? ' video' : ''}`,
        title: `${formatDate(item.ts, item.precision || 'day')}\n${(item.matched || []).map((m) => CRITERION_LABELS[m]).join(', ')}`,
        onclick: () => {
          if (this.state.selection.has(item.id)) this.state.selection.delete(item.id);
          else this.state.selection.add(item.id);
          this.renderAll();
        }
      },
      item.url ? el('img', { src: item.url, loading: 'lazy', referrerPolicy: 'no-referrer' }) : null,
      el('span', { class: 'mark', text: on ? '✓' : '' }),
      // Show the presence score on tiles caught as "no people": it is the
      // least reliable criterion, and seeing it lets you judge on evidence.
      (item.matched || []).includes('noFace') && item.features
        ? el('span', {
            class: 'score',
            title: item.features.faceMethod === 'heuristic'
              ? 'Presence score / skin area (heuristic)'
              : `Best detection confidence (${item.features.faceMethod})`
          },
            item.features.faceMethod === 'heuristic'
              ? `${Math.round(item.features.faceScore * 100)}/${Math.round((item.features.skinFrac || 0) * 100)}%`
              : `${Math.round(item.features.faceScore * 100)}%`)
        : null,
      el('span', { class: 'tags' },
        (item.matched || []).slice(0, 3).map((m) => el('span', { text: CRITERION_LABELS[m] || m })))
    );
  }

  toggle(open) {
    const show = open ?? this.panel.hidden;
    this.panel.hidden = !show;
    // The badge stays visible and shifts: it also closes the panel, and hiding
    // it during a run would remove the only activity indicator available when
    // the panel is shut.
    this.badge.title = show
      ? 'Photo Cleaner — close panel'
      : 'Photo Cleaner — open panel';
    if (show) this.renderAll();
    else this.renderBadge();
  }

  /* ------------------------------------------------------ status display */

  /**
   * Update the indicator without re-rendering the panel. Called on every
   * progress tick, so it must stay very cheap.
   */
  setStatus(patch) {
    clearTimeout(this.statusTimer);
    Object.assign(this.state.status, patch);
    this.renderBadge();
    this.renderHeaderStatus();
  }

  /** Show a transient state (finished, error), then return to idle. */
  flashStatus(label, tone = 'done', ms = 4000) {
    this.setStatus({ label, ratio: null, tone });
    this.statusTimer = setTimeout(() => {
      this.setStatus({ label: null, ratio: null, tone: null });
    }, ms);
  }

  renderBadge() {
    if (!this.badge) return;
    const { label, ratio, tone } = this.state.status;
    const busy = !!this.state.busy;
    const total = this.state.items.length;

    this.badge.classList.toggle('busy', busy);
    this.badge.classList.toggle('panel-open', !this.panel.hidden);
    this.badge.classList.toggle('error', tone === 'error');
    this.badge.classList.toggle('done', tone === 'done' && !busy);

    this.badgeGlyph.className = `glyph ${
      busy ? 'spinner' : tone === 'error' ? 'err' : tone === 'done' ? 'ok' : total ? 'ready' : 'idle'
    }`;

    this.badgeLabel.textContent =
      label || (total ? `${nf(total)} items` : 'Clean up');

    // Indeterminate bar while progress cannot be quantified: continuous motion
    // beats a bar frozen at zero, which reads as a freeze.
    this.badgeBar.hidden = !busy;
    this.badgeBar.classList.toggle('indeterminate', busy && ratio == null);
    if (busy && ratio != null) {
      this.badgeBarFill.style.width = `${Math.max(2, Math.min(100, ratio * 100))}%`;
    } else {
      this.badgeBarFill.style.width = '';
    }
  }

  renderHeaderStatus() {
    if (!this.headerSub) return;
    const { label, tone } = this.state.status;
    const total = this.state.items.length;
    const analyzed = this.state.items.filter((i) => i.analyzed).length;

    this.headerSub.className = `sub${this.state.busy ? ' busy' : tone === 'error' ? ' error' : ''}`;
    this.headerSub.textContent =
      label ||
      (total ? `${nf(total)} items · ${nf(analyzed)} analysed` : 'Nothing yet — run an analysis');
  }

  /* ------------------------------------------------------------------ data */

  async reload() {
    this.state.items = await db.getAll();
    this.state.cursor = await readCursor();
    this.dupCache = null;
    this.recompute();
  }

  /**
   * Memoised duplicate grouping: the only computation whose cost grows faster
   * than linearly, and it would rerun on every slider move if left unguarded.
   */
  duplicateSelection() {
    const f = this.state.filters;
    if (!f.enabled.duplicates) return { selectable: new Set(), groups: new Map(), keepers: new Set() };
    const key = `${f.dupDistance}|${f.dupWindow}|${f.dupKeep}|${this.state.items.length}`;
    if (!this.dupCache || this.dupCache.key !== key) {
      const groups = clusterDuplicates(this.state.items, {
        distance: f.dupDistance, window: f.dupWindow
      });
      const byId = new Map(this.state.items.map((i) => [i.id, i]));
      const keepers = pickKeepers(groups, byId, f.dupKeep);
      const selectable = new Set();
      for (const members of groups.values()) {
        for (const id of members) if (!keepers.has(id)) selectable.add(id);
      }
      this.dupCache = { key, groups, keepers, selectable };
    }
    return this.dupCache;
  }

  recompute() {
    const dup = this.duplicateSelection();
    this.state.counts = countPerCriterion(this.state.items, this.state.filters, dup.selectable);
    const r = applyFilters(this.state.items, this.state.filters, dup);
    this.state.filtered = r.items;
    this.state.groups = r.groups;
    this.state.keepers = r.keepers;
    // Any filter change resets the selection to "everything that matches":
    // keeping a stale partial selection would be a dangerous trap.
    this.state.selection = new Set(r.items.map((i) => i.id));
  }

  /* ---------------------------------------------------------------- rendu */

  renderAll() {
    // Counter references are rebuilt on every render; keeping the old ones
    // would write into detached nodes.
    this.counterEls = new Map();
    this.previewHeading = null;
    this.previewCount = null;
    this.modalCount = null;
    this.footerSummary = null;

    for (const b of this.tabsNav.querySelectorAll('button')) {
      b.setAttribute('aria-selected', String(b.dataset.tab === this.state.tab));
    }
    for (const [k, node] of Object.entries(this.tabs)) node.hidden = k !== this.state.tab;

    this.renderHeaderStatus();
    this.renderBadge();
    if (this.headerReset) this.headerReset.disabled = !!this.state.busy;

    this.renderScan();
    this.renderSort();
    this.renderStats();
    this.renderSettings();
    this.renderFooter();
    this.renderModal();
  }

  /* ------------------------------------------------------------ onglet 1 */

  renderScan() {
    const t = this.tabs.scan;
    t.replaceChildren();

    const total = this.state.items.length;
    const analyzed = this.state.items.filter((i) => i.analyzed).length;
    const failed = this.state.items.filter((i) => i.analysisError).length;
    const noThumb = this.state.items.filter((i) => !i.analyzed && !i.url).length;
    // Must mirror exactly what `getPending` returns: a failed item is still
    // pending (network errors are often transient), an item with no thumbnail
    // never will be. Counting otherwise shows work that does not exist, or
    // disables the button while work remains.
    const pending = this.state.items.filter((i) => !i.analyzed && i.url).length;

    t.append(
      this.buildHero(total, analyzed, pending),
      this.buildModelNote(),
      el(
        'section',
        {},
        el('h2', {}, 'Status'),
        el(
          'div',
          { class: 'kpis' },
          kpi(nf(total), 'found'),
          kpi(nf(analyzed), 'analysed', analyzed && !pending ? 'good' : ''),
          kpi(nf(pending), 'pending', pending ? 'warn' : ''),
        ),
        failed
          ? el('div', { class: 'muted', style: 'margin-top:8px' },
              `${nf(failed)} thumbnail(s) failed, usually expired URLs. They are retried on the next run.`)
          : null,
        this.buildNoThumbAlert(total, analyzed, pending, noThumb)
      )
    );

    const running = this.state.busy === 'full';

    this.scanBar = el('i');
    this.scanLog = el('div', { class: 'log' });
    this.analyzeBar = el('i');
    this.analyzeLog = el('div', { class: 'log' });

    t.append(
      el(
        'section',
        {},
        el('h2', {}, 'Analyse your library'),
        el(
          'div',
          { class: 'card' },
          el('div', { class: 'muted' },
            `Scrolls the grid to list your items and analyses each thumbnail at ${this.state.settings.thumbSize}px as it goes: sharpness, brightness, perceptual hash, human presence, image type. Nothing in Google Photos is modified. Interruptible at any time — progress is kept.`),
          el('div', { class: 'muted', style: 'margin-top:6px' },
            'Keep this tab in the foreground: Google Photos suspends rendering in hidden tabs.'),

          this.buildSinceControl(),
          this.buildLimitControl(),
          this.buildPlanNote(pending),
          this.buildResumeNote(),

          el(
            'div',
            { class: 'row', style: 'margin-top:12px' },
            el('button', {
              class: 'action primary',
              text: running ? 'Stop' : this.runLabel(pending),
              disabled: !!this.state.busy && !running,
              onclick: () => (running ? this.abortAll() : this.startFullRun())
            }),
            el('span', { class: 'spacer' }),
            this.state.cursor && !running
              ? el('button', {
                  class: 'action', text: 'Start over',
                  title: 'Forget the saved position and walk the whole library again',
                  disabled: !!this.state.busy,
                  onclick: async () => {
                    await resetCursor();
                    await this.reload();
                    this.renderAll();
                  }
                })
              : null
          ),
          el('div', { class: 'muted', style: 'margin-top:10px; font-size:11px' }, 'Listing'),
          el('div', { class: 'progress' }, this.scanBar),
          this.scanLog,
          el('div', { class: 'muted', style: 'margin-top:10px; font-size:11px' }, 'Analysis'),
          el('div', { class: 'progress' }, this.analyzeBar),
          this.analyzeLog
        )
      )
    );
  }

  /**
   * Says which people detector is in use.
   *
   * The difference matters to the user: the trained model is reliable, the
   * heuristic is not, and the "no people" criterion behaves differently under
   * each. Hiding that would let someone bulk-select on a guess.
   */
  buildModelNote() {
    const fm = this.state.faceModel;
    if (!fm) return null;
    if (fm.error) {
      return el('div', { class: 'banner warn', style: 'margin-top:14px' },
        el('b', {}, 'People detection is running on the fallback heuristic. '),
        'WebAssembly appears to be blocked, so the bundled model could not start. ',
        'The "no people" criterion stays deliberately cautious in this mode.');
    }
    return el('div', { class: 'banner info', style: 'margin-top:14px' },
      el('b', {}, `People detection: ${fm.model}. `),
      `Runs locally on ${fm.size} worker(s); no image leaves the browser.`);
  }

  /**
   * Header block: progress ring and unlocked milestones.
   *
   * Sorting a library is a chore with no visible end. A gauge that fills and
   * milestones that light up give a handle on progress — without inventing
   * anything: every number shown is a real count from the catalogue.
   */
  buildHero(total, analyzed, pending) {
    const ratio = total ? analyzed / total : 0;
    const complet = total > 0 && pending === 0;

    let titre;
    let sous;
    if (!total) {
      titre = 'Ready to explore';
      sous = 'Run the analysis: the extension walks your library and measures every thumbnail. Nothing is modified.';
    } else if (pending) {
      titre = `${nf(pending)} pending`;
      sous = `${nf(analyzed)} of ${nf(total)} thumbnails measured. Run again to carry on where you left off.`;
    } else {
      titre = 'Library analysed';
      sous = `${nf(total)} items measured. Head to the Sort tab to clean up.`;
    }

    return el('div', { class: 'hero' },
      this.buildRing(ratio, complet),
      el('div', { class: 'hero-side' },
        el('div', { class: 'hero-title' }, titre),
        el('div', { class: 'hero-sub' }, sous),
        this.buildMilestones(total, analyzed, complet)));
  }

  /**
   * Progress ring.
   *
   * The gradient id is unique per call: tabs are hidden, not destroyed, so
   * several rings coexist in the same tree. A shared id would make `url(#...)`
   * resolve to the first definition and every ring would borrow its colours.
   */
  buildRing(ratio, complet) {
    const R = 41;
    const C = 2 * Math.PI * R;
    const gradId = `gpcGrad${++ringSeq}`;
    const de = complet ? '#5ee0a5' : '#ffc14d';
    const vers = complet ? '#6bc7ff' : '#ff7a5e';

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 96 96');
    svg.innerHTML =
      `<defs><linearGradient id="${gradId}" x1="0" y1="0" x2="1" y2="1">` +
      `<stop offset="0%" stop-color="${de}"/><stop offset="100%" stop-color="${vers}"/>` +
      `</linearGradient></defs>` +
      `<circle class="track" cx="48" cy="48" r="${R}"/>` +
      `<circle class="fill" cx="48" cy="48" r="${R}" stroke="url(#${gradId})" ` +
      `stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${(C * (1 - ratio)).toFixed(1)}"/>`;

    return el('div', { class: 'ring' },
      svg,
      el('div', { class: 'center' },
        el('div', { class: 'ring-value' }, `${Math.round(ratio * 100)}%`),
        el('div', { class: 'ring-label' }, complet ? 'done' : 'analysed')));
  }

  /**
   * Milestones, deliberately based on real counts and nothing else: a reward
   * matching no measured fact is spotted instantly and discredits the rest of
   * the interface.
   */
  buildMilestones(total, analyzed, complet) {
    const paliers = [
      { key: 'start', label: 'Explored', on: total > 0 },
      { key: 'k1', label: '1 000', on: analyzed >= 1000 },
      { key: 'k10', label: '10 000', on: analyzed >= 10000 },
      { key: 'full', label: 'Complete', on: complet }
    ];
    const atteints = paliers.filter((p) => p.on).map((p) => p.key).join(',');
    const nouveaux = this.lastMilestones != null && atteints !== this.lastMilestones;
    const avant = this.lastMilestones ? this.lastMilestones.split(',') : [];
    this.lastMilestones = atteints;

    return el('div', { class: 'milestones' },
      paliers.map((p) => el('div', {
        class: `ms${p.on ? ' on' : ''}${nouveaux && p.on && !avant.includes(p.key) ? ' fresh' : ''}`,
        title: p.on ? 'Unlocked' : 'Locked'
      },
        el('span', { class: 'dot' }, p.on ? '★' : '·'),
        p.label)));
  }

  /**
   * Loudly flag "items listed, but nothing to analyse".
   *
   * This is the extension's most treacherous failure: no error is raised, the
   * engine answers normally, the queue is simply empty — and analysis stays at
   * zero with no explanation. It typically happens when Google changes the host
   * serving thumbnails, which the observed-hosts report answers directly.
   */
  buildNoThumbAlert(total, analyzed, pending, noThumb) {
    if (!total || !noThumb) return null;
    const bloquant = pending === 0 && analyzed === 0;

    const box = el('div', { class: `banner ${bloquant ? 'danger' : 'warn'}`, style: 'margin-top:10px' });
    box.append(
      el('b', {}, bloquant
        ? 'No usable thumbnails: analysis has nothing to work on.'
        : `${nf(noThumb)} item(s) listed before their thumbnail arrived.`),
      el('br'),
      bloquant
        ? 'Items were listed, but no image URL could be extracted. Either scrolling outran image loading, or Google changed the host serving them.'
        : 'Google Photos fills the grid in two passes: tiles first, images second. These items were seen in between.'
    );

    // Separate what will be retried automatically from what is permanently
    // lost: promising a recovery that will not happen is worse than silence.
    const reprenables = this.state.items.filter(
      (i) => !i.analyzed && !i.url && (i.thumbAttempts || 0) < MAX_THUMB_ATTEMPTS
    ).length;
    const abandonnes = noThumb - reprenables;

    if (reprenables) {
      const auto = this.state.settings.autoRepairThumbs;
      const limite = this.state.settings.autoRepairLimit || 500;
      box.append(el('div', { style: 'margin-top:8px' },
        auto && reprenables <= limite
          ? [el('b', {}, `${nf(reprenables)} will be retried automatically`),
             ' at the end of the next run: each is brought back on screen, its image awaited, then analysed.']
          : [el('b', {}, `${nf(reprenables)} to recover`),
             ' — too many for one-by-one recovery. Run again: a fresh pass over the grid picks them up along the way.']));
    }

    if (abandonnes > 0) {
      box.append(el('div', { class: 'muted', style: 'margin-top:6px' },
        `${nf(abandonnes)} item(s) still have no preview after ${MAX_THUMB_ATTEMPTS} attempts and will not be retried — usually videos still processing at Google.`));
    }

    box.append(el('div', { class: 'muted', style: 'margin-top:6px' },
      'If this repeats on every run, raise ',
      el('b', {}, 'Thumbnail wait'),
      ' in Settings → Speed, or reduce the scroll step.'));

    // The image-host report only makes sense in this exact case, so it is
    // measured on demand here rather than in a permanent diagnostics panel
    // nobody opens at the right moment.
    if (bloquant) {
      const hosts = dom.observedThumbHosts();
      const entrees = Object.entries(hosts);
      if (entrees.length) {
        box.append(
          el('div', { style: 'margin-top:8px' }, 'Hosts observed on tiles:'),
          el('div', { style: 'margin-top:3px' },
            entrees.map(([h, n]) => el('div', {}, el('code', {}, `${h} × ${n}`))))
        );
      }
    }
    return box;
  }

  runLabel(pending) {
    const limit = this.state.settings.maxPerRun || 0;
    const suffix = limit ? ` (${nf(limit)} max)` : '';
    if (!this.state.settings.resumeScan || !this.state.cursor) return `Analyse my library${suffix}`;
    if (this.state.cursor.reachedEnd) {
      return pending ? `Resume · ${nf(pending)} pending` : `Check for new photos${suffix}`;
    }
    return `Resume${pending ? ` · ${nf(pending)} pending` : suffix}`;
  }

  /**
   * Per-run volume limit.
   *
   * With no limit the extension goes to the end of the library, which is the
   * correct default. The limit is there to slice the work up — run, look, run
   * again. It sits here rather than in settings because you decide it as you
   * launch.
   */
  buildLimitControl() {
    const s = this.state.settings;
    const presets = [['None', 0], ['500', 500], ['2,000', 2000], ['10,000', 10000]];

    const row = el('div', { class: 'row', style: 'flex-wrap:wrap; gap:6px' });
    for (const [label, value] of presets) {
      row.append(el('button', {
        class: 'chip', text: label, 'aria-pressed': String((s.maxPerRun || 0) === value),
        disabled: !!this.state.busy,
        onclick: () => { s.maxPerRun = value; this.persist(); this.renderAll(); }
      }));
    }

    return el('div', { style: 'margin-top:14px' },
      el('div', { class: 'muted', style: 'margin-bottom:6px' }, 'Limit per run:'),
      row,
      el('div', { class: 'slider', style: 'margin-top:8px' },
        el('label', {}, 'Custom'),
        el('input', {
          type: 'number', min: 0, max: 500000, step: 100, value: s.maxPerRun || 0,
          disabled: !!this.state.busy,
          onchange: (e) => {
            s.maxPerRun = Math.max(0, Math.floor(+e.target.value || 0));
            this.persist();
            this.renderAll();
          }
        }),
        el('span', { class: 'muted', style: 'font-size:11px' }, '0 = none')));
  }

  /**
   * State exactly what the next run will do.
   *
   * "How many photos?" is the first question anyone asks of a button that may
   * work for an hour. The answer depends on three combined settings, so it is
   * spelled out rather than left to be inferred.
   */
  buildPlanNote(pending) {
    const s = this.state.settings;
    const limit = s.maxPerRun || 0;
    const parts = [];

    parts.push(limit
      ? `will list at most ${nf(limit)} new photos`
      : 'will list your whole library');
    if (s.scanOlderThanTs) {
      parts.push(`skipping anything newer than ${formatDate(s.scanOlderThanTs)}`);
    }
    parts.push(limit
      ? `then analyse at most ${nf(limit)} thumbnails${pending ? ` (${nf(pending)} already pending)` : ''}`
      : `then analyse everything pending${pending ? ` (${nf(pending)} so far)` : ''}`);

    return el('div', { class: 'banner info', style: 'margin-top:12px' },
      el('b', {}, 'This run '),
      parts.join(', '),
      '.',
      limit
        ? el('div', { class: 'muted', style: 'margin-top:5px' },
            'Run again to continue: the position reached is remembered.')
        : null);
  }

  /**
   * Time window for the run.
   *
   * Placed here rather than in settings: it is the most effective lever on a
   * large library and only makes sense as you launch. It bounds by age, not by
   * recency — what you clean is the old, and recent photos are exactly the ones
   * you want to protect.
   */
  buildSinceControl() {
    const s = this.state.settings;
    const wrap = el('div', { style: 'margin-top:12px' });

    const presets = [
      ['All', null],
      ['6 months', 6],
      ['12 months', 12],
      ['3 years', 36],
      ['5 years', 60]
    ];
    const row = el('div', { class: 'row', style: 'flex-wrap:wrap; gap:6px' });
    for (const [label, months] of presets) {
      const target = months == null ? null : monthsAgo(months);
      const active = months == null
        ? !s.scanOlderThanTs
        : !!s.scanOlderThanTs && Math.abs(s.scanOlderThanTs - target) < 36e5 * 24 * 20;
      row.append(el('button', {
        class: 'chip', text: label, 'aria-pressed': String(active),
        disabled: !!this.state.busy,
        onclick: () => {
          s.scanOlderThanTs = target;
          this.persist();
          this.renderAll();
        }
      }));
    }

    wrap.append(
      el('div', { class: 'muted', style: 'margin-bottom:6px' },
        'Only handle photos older than:'),
      row,
      el('div', { class: 'slider', style: 'margin-top:8px' },
        el('label', {}, 'Before'),
        el('input', {
          type: 'date',
          value: s.scanOlderThanTs ? toDateInput(s.scanOlderThanTs) : '',
          disabled: !!this.state.busy,
          onchange: (e) => {
            s.scanOlderThanTs = e.target.value ? new Date(`${e.target.value}T00:00:00`).getTime() : null;
            this.persist();
            this.renderAll();
          }
        }))
    );

    if (s.scanOlderThanTs) {
      wrap.append(el('div', { class: 'muted', style: 'margin-top:6px' },
        `Only photos before ${formatDate(s.scanOlderThanTs)} are listed and analysed. Newer ones are skipped — the grid runs newest to oldest, so they are crossed in long strides at the start.`));
    }
    return wrap;
  }

  /** Explain where the next scan will resume, and why. */
  buildResumeNote() {
    const c = this.state.cursor;
    if (!this.state.settings.resumeScan) {
      return el('div', { class: 'banner info', style: 'margin:10px 0 0' },
        'Resume is off: every scan restarts from the top of the library.');
    }
    if (!c) return null;

    if (c.reachedEnd) {
      return el('div', { class: 'banner info', style: 'margin:10px 0 0' },
        el('b', {}, 'Whole library walked. '),
        'The next run restarts from the top to pick up recent additions — Google Photos puts new photos at the head of the grid.');
    }

    const pos = c.scrollHeight ? Math.round((c.scrollTop / c.scrollHeight) * 100) : null;
    return el('div', { class: 'banner info', style: 'margin:10px 0 0' },
      el('b', {}, `Resuming${pos != null ? ` around ${pos}%` : ''} through the library. `),
      `${nf(c.known || 0)} items already known; they will not be counted again. `,
      el('span', { class: 'muted' },
        'The grid reflows with window size, so resuming starts one screen earlier and duplicates are absorbed by id.'));
  }


  /* ------------------------------------------------------------ onglet 2 */

  renderSort() {
    const t = this.tabs.sort;
    t.replaceChildren();
    const f = this.state.filters;
    const analyzed = this.state.items.filter((i) => i.analyzed).length;

    if (!analyzed) {
      t.append(el('div', { class: 'banner warn' }, 'No thumbnails analysed yet. Start with the ', el('b', {}, 'Analyse'), ' tab — without it, only the date range and video length criteria work.'));
    }

    const modeRow = el(
      'div',
      { class: 'row' },
      el('label', { class: 'switch' },
        el('input', {
          type: 'radio', name: 'mode', checked: f.mode === 'any',
          onchange: () => { f.mode = 'any'; this.onFilterChange(); }
        }), 'Any criterion'),
      el('label', { class: 'switch' },
        el('input', {
          type: 'radio', name: 'mode', checked: f.mode === 'all',
          onchange: () => { f.mode = 'all'; this.onFilterChange(); }
        }), 'All criteria')
    );

    const list = el('div', { class: 'card' });
    for (const crit of CRITERIA) list.append(this.buildCriterion(crit));

    this.previewHeading = el('h2', {}, `Preview — ${nf(this.state.filtered.length)} item(s)`);

    t.append(
      this.buildCleanupScore(),
      el('button', {
        class: 'action primary wide', text: '⤢  Open full screen',
        style: 'margin-bottom:16px',
        title: 'Wide view: criteria left, thumbnails centre',
        onclick: () => this.openModal()
      }),
      el('section', {}, el('h2', {}, 'Combine'), modeRow),
      el('section', {}, el('h2', {}, 'Criteria'), list),
      el('section', {}, this.previewHeading, this.buildPreview())
    );
  }

  /**
   * Cleanup potential: the share of the library the criteria catch.
   *
   * A proportion speaks better than a raw number — "8%" frames the effort,
   * "1,240" says nothing without the total. The wording only makes the figure
   * readable at a glance, never to push anyone into deleting.
   */
  buildCleanupScore() {
    const total = this.state.items.length;
    const retenus = this.state.filtered.length;
    if (!total) return null;

    const pourcent = (retenus / total) * 100;
    let verdict = 'Library already tidy';
    let ton = 'good';
    if (!retenus) {
      verdict = Object.values(this.state.filters.enabled).some(Boolean)
        ? 'No matches'
        : 'Enable a criterion to begin';
      ton = '';
    } else if (pourcent >= 25) { verdict = 'Big clean-up ahead'; ton = 'danger'; }
    else if (pourcent >= 8) { verdict = 'Good potential'; ton = 'warn'; }
    else { verdict = 'A few catches'; ton = 'warn'; }

    const ring = this.buildRing(Math.min(1, retenus / total), false);
    ring.querySelector('.ring-value').textContent =
      pourcent > 0 && pourcent < 1 ? '<1%' : `${Math.round(pourcent)}%`;
    ring.querySelector('.ring-label').textContent = 'caught';

    return el('div', { class: 'hero', style: 'margin-bottom:16px' },
      ring,
      el('div', { class: 'hero-side' },
        el('div', { class: 'hero-title' }, verdict),
        el('div', { class: 'hero-sub' },
          retenus
            ? `${nf(retenus)} of ${nf(total)} items match the active criteria.`
            : `${nf(total)} items in the catalogue.`),
        el('div', { class: 'kpis', style: 'margin-top:12px; grid-template-columns:repeat(2,1fr)' },
          kpi(nf(this.state.selection.size), 'ticked', ton),
          kpi(nf(total - retenus), 'kept', 'good'))));
  }

  /** Reset-to-default button, inert while already at the default. */
  resetButton(props, isDefault, label) {
    return el('button', {
      class: 'reset', text: '↺',
      title: isDefault ? 'Already at the default' : `Restore the default${label ? ` (${label})` : ''}`,
      disabled: isDefault,
      onclick: () => {
        for (const p of props) this.state.filters[p] = structuredClone(DEFAULT_FILTERS[p]);
        this.onFilterChange();
      }
    });
  }

  buildCriterion(crit) {
    const f = this.state.filters;
    const on = !!f.enabled[crit.key];
    const controls = el('div', { class: 'controls', hidden: !on });

    for (const c of crit.controls || []) {
      if (c.type === 'select') {
        controls.append(
          el('div', { class: 'slider' },
            el('label', {}, c.label),
            el('select', {
              onchange: (e) => { f[c.prop] = e.target.value; this.onFilterChange(); }
            }, c.options.map(([v, l]) => el('option', { value: v, text: l, selected: f[c.prop] === v }))),
            this.resetButton([c.prop], f[c.prop] === DEFAULT_FILTERS[c.prop]))
        );
      } else if (c.type === 'daterange') {
        const auDefaut = f.from === DEFAULT_FILTERS.from && f.to === DEFAULT_FILTERS.to;
        controls.append(
          el('div', { class: 'slider' },
            el('label', {}, 'From'),
            el('input', {
              type: 'date', value: f.from ? toDateInput(f.from) : '',
              onchange: (e) => { f.from = e.target.value ? new Date(`${e.target.value}T00:00:00`).getTime() : null; this.onFilterChange(); }
            }),
            this.resetButton(['from', 'to'], auDefaut, 'no bounds')),
          el('div', { class: 'slider', style: 'margin-top:6px' },
            el('label', {}, 'To'),
            el('input', {
              type: 'date', value: f.to ? toDateInput(f.to) : '',
              onchange: (e) => { f.to = e.target.value ? new Date(`${e.target.value}T23:59:59`).getTime() : null; this.onFilterChange(); }
            }))
        );
      } else {
        const defaut = DEFAULT_FILTERS[c.prop];
        const fmt = c.fmt || String;
        const out = el('output', { text: fmt(f[c.prop]) });
        const reset = this.resetButton([c.prop], f[c.prop] === defaut, fmt(defaut));
        controls.append(
          el('div', { class: 'slider' },
            el('label', {}, c.label),
            el('input', {
              type: 'range', min: c.min, max: c.max, step: c.step, value: f[c.prop],
              // `input` fires on every slider move, so counts follow live
              // without waiting for release.
              oninput: (e) => {
                f[c.prop] = +e.target.value;
                out.textContent = fmt(f[c.prop]);
                reset.disabled = f[c.prop] === defaut;
                this.scheduleLiveUpdate();
              },
              // `change` marks the end of the gesture: that is where we pay
              // for the full render and, if needed, duplicate grouping.
              onchange: () => this.onFilterChange()
            }),
            out,
            reset)
        );
      }
    }

    const counter = el('span', { class: 'count', text: nf(this.state.counts[crit.key] ?? 0) });
    // The same criterion is rendered twice (panel and modal), so counters are
    // collected in a list and refreshed together.
    if (!this.counterEls.has(crit.key)) this.counterEls.set(crit.key, []);
    this.counterEls.get(crit.key).push(counter);

    return el(
      'div',
      { class: 'filter' },
      el('label', {},
        el('input', {
          type: 'checkbox', checked: on,
          onchange: (e) => { f.enabled[crit.key] = e.target.checked; this.onFilterChange(); }
        }),
        el('span', { class: 'icon' }, crit.icon || ''),
        crit.label,
        counter),
      el('div', { class: 'hint' }, crit.hint),
      controls
    );
  }

  /**
   * Recompute while a slider is being dragged, paced to the screen refresh:
   * `input` events arrive far faster, and stacking them would pile up work that
   * is already stale.
   */
  scheduleLiveUpdate() {
    if (this.liveFrame) return;
    this.liveFrame = requestAnimationFrame(() => {
      this.liveFrame = null;
      this.liveUpdate();
    });
  }

  liveUpdate() {
    // Measured: counting costs ~10ms at 50,000 items, but duplicate grouping
    // costs 330 — impossible every frame. Above the threshold we keep the
    // previous grouping and mark that counter stale, rather than freeze the UI
    // or show a wrong number without saying so.
    const differe = this.state.filters.enabled.duplicates &&
      this.state.items.length > LIVE_CLUSTER_MAX;
    const dup = differe
      ? (this.dupCache || { selectable: new Set(), groups: new Map(), keepers: new Set() })
      : this.duplicateSelection();

    this.state.counts = countPerCriterion(this.state.items, this.state.filters, dup.selectable);
    const r = applyFilters(this.state.items, this.state.filters, dup);
    this.state.filtered = r.items;
    this.state.groups = r.groups;
    this.state.keepers = r.keepers;
    this.state.selection = new Set(r.items.map((i) => i.id));
    this.state.dupStale = differe;
    this.refreshCounters();
  }

  /**
   * Update only the numbers on screen. Rebuilding the thumbnail grid every
   * frame would be the real cost; the figures are a few text nodes.
   */
  refreshCounters() {
    for (const [key, nodes] of this.counterEls) {
      const stale = this.state.dupStale && key === 'duplicates';
      for (const node of nodes) {
        node.textContent = nf(this.state.counts[key] ?? 0);
        node.classList.toggle('stale', stale);
        node.title = stale ? 'Recomputed when you release the slider' : '';
      }
    }
    const total = nf(this.state.filtered.length);
    const coches = nf(this.state.selection.size);
    if (this.previewHeading) this.previewHeading.textContent = `Preview — ${total} item(s)`;
    if (this.previewCount) this.previewCount.textContent = `${coches} ticked`;
    if (this.modalCount) this.modalCount.textContent = `${total} matching · ${coches} ticked`;
    if (this.footerSummary) this.footerSummary.replaceChildren(el('b', {}, coches), ' item(s) ticked');
  }

  buildPreview() {
    const box = el('div', {});
    const shown = this.state.filtered.slice(0, this.state.renderLimit);

    if (!this.state.filtered.length) {
      box.append(el('div', { class: 'muted' },
        Object.values(this.state.filters.enabled).some(Boolean)
          ? 'Nothing matches.'
          : 'Enable at least one criterion.'));
      return box;
    }

    this.previewCount = el('span', { class: 'muted', text: `${nf(this.state.selection.size)} ticked` });
    box.append(
      el('div', { class: 'row' },
        el('button', {
          class: 'action', text: 'Tick all',
          onclick: () => { this.state.selection = new Set(this.state.filtered.map((i) => i.id)); this.renderAll(); }
        }),
        el('button', {
          class: 'action', text: 'Untick all',
          onclick: () => { this.state.selection = new Set(); this.renderAll(); }
        }),
        el('span', { class: 'spacer' }),
        this.previewCount)
    );

    const grid = el('div', { class: 'grid' });
    for (const item of shown) grid.append(this.buildThumb(item));
    box.append(grid);

    if (this.state.filtered.length > shown.length) {
      box.append(el('button', {
        class: 'action wide', style: 'margin-top:8px',
        text: `Show more (${nf(this.state.filtered.length - shown.length)} left)`,
        onclick: () => { this.state.renderLimit += 240; this.renderAll(); }
      }));
    }
    return box;
  }

  onFilterChange() {
    // A full recompute is under way, so the light update queued for the next
    // frame would be redundant.
    if (this.liveFrame) {
      cancelAnimationFrame(this.liveFrame);
      this.liveFrame = null;
    }
    this.state.renderLimit = this.state.modalOpen ? 300 : 120;
    this.state.dupStale = false;
    this.recompute();
    this.persist();
    this.renderAll();
  }

  /* ------------------------------------------------------------ onglet 3 */

  renderStats() {
    const t = this.tabs.stats;
    t.replaceChildren();
    const s = computeStats(this.state.items);

    if (!s.total) {
      t.append(el('div', { class: 'muted' }, 'Nothing to show yet — run an analysis.'));
      return;
    }

    t.append(
      el('section', {}, el('h2', {}, 'Overview'),
        el('div', { class: 'kpis' },
          kpi(nf(s.total), 'items'),
          kpi(nf(s.videos), 'videos'),
          kpi(dur(Math.round(s.videoSeconds)), 'of footage'))),
      this.buildNoDateNote(s),
      el('section', {}, el('h2', {}, 'By year'), chart(s.byYear)),
      el('section', {}, el('h2', {}, 'By month (last 24)'), chart(s.byMonth.slice(-24))),
      el('section', {}, el('h2', {}, 'Busiest days'),
        chart([...s.byDay].sort((a, b) => b[1] - a[1]).slice(0, 12)
          .map(([k, v]) => [formatDate(new Date(`${k}T12:00:00`).getTime()), v]))),
      el('section', {}, el('h2', {}, 'By weekday'),
        chart(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => [d, s.byWeekday[i]]))),
      el('section', {}, el('h2', {}, 'By hour'),
        chart(s.byHour.map((v, i) => [`${String(i).padStart(2, '0')}h`, v]))),
      el('section', {}, el('h2', {}, 'Detected traits'),
        s.analyzed
          ? chart(Object.entries(s.traits).map(([k, v]) => [CRITERION_LABELS[k] || k, v]))
          : el('div', { class: 'muted' }, 'Analyse your thumbnails to fill this section.'))
    );
  }

  /**
   * Explain missing dates instead of merely counting them.
   *
   * Every photo has a date: if the extension cannot read it, that is a defect
   * in the extension, not a property of the library. Saying so plainly, and
   * saying what to do, beats a dead-end observation.
   */
  buildNoDateNote(s) {
    if (!s.noDate) return null;
    const carried = this.state.items.filter((i) => i.dateSource === 'carried').length;

    return el('div', { class: 'banner warn' },
      el('b', {}, `${nf(s.noDate)} item(s) with no usable date`),
      ' — they are excluded from the time histograms.',
      el('br'),
      'Every photo does carry a date; the extension just did not find it. The grid is virtualised, so the group date header is sometimes recycled out of the page when the tile is read.',
      carried
        ? el('div', { class: 'muted', style: 'margin-top:6px' },
            `${nf(carried)} other item(s) inherited their date from the neighbouring tile — the grid is chronological, so this is accurate to the day.`)
        : null,
      el('div', { style: 'margin-top:7px' },
        el('b', {}, 'Run the analysis again'),
        ': neighbour carry-over and header continuity between passes recover most of them.'),
      // On-demand report: the only information that lets us fix the parser if
      // Google changed its label format.
      el('div', { class: 'row', style: 'margin-top:8px' },
        el('button', {
          class: 'action', text: 'Show unreadable labels',
          onclick: (e) => {
            const d = dom.diagnose();
            const zone = el('div', { style: 'margin-top:8px' },
              d.labelsSansDate?.length
                ? [el('div', { class: 'muted' }, 'Labels whose date could not be read:'),
                   ...d.labelsSansDate.map((t) => el('div', { style: 'margin-top:2px' }, el('code', {}, t)))]
                : el('div', { class: 'muted' }, 'Every tile currently on screen has a readable date — the affected items are elsewhere in the grid.'));
            e.target.replaceWith(zone);
          }
        })));
  }

  /* ------------------------------------------------------------ onglet 4 */

  renderSettings() {
    const t = this.tabs.settings;
    t.replaceChildren();
    const s = this.state.settings;

    const num = (prop, label, min, max, step, hint) =>
      el('div', { class: 'filter' },
        el('div', { class: 'slider' },
          el('label', {}, label),
          el('input', {
            type: 'number', min, max, step, value: s[prop],
            onchange: (e) => { s[prop] = +e.target.value; this.persist(); this.renderAll(); }
          })),
        hint ? el('div', { class: 'hint', style: 'margin-left:0' }, hint) : null);

    t.append(
      el('section', {}, el('h2', {}, 'Resume'),
        el('div', { class: 'card' },
          el('div', { class: 'muted' }, 'On a large library, bounding each run lets you work in slices without ever starting over: the position reached is remembered.'),
          el('label', { class: 'switch', style: 'margin-top:10px' },
            el('input', {
              type: 'checkbox', checked: s.resumeScan,
              onchange: (e) => { s.resumeScan = e.target.checked; this.persist(); this.renderAll(); }
            }),
            el('span', {}, 'Resume where listing stopped',
              el('br'),
              el('small', {}, 'Untick to always restart from the top.'))),
          el('div', { class: 'muted', style: 'margin-top:10px' },
            'The volume limit and time window are set on the ',
            el('b', {}, 'Analyse'), ' tab: they are decided as you launch.'))),

      el('section', {}, el('h2', {}, 'Speed'),
        el('div', { class: 'card' },
          num('thumbSize', 'Thumbnail size', 96, 512, 16,
            'The dominant cost is transfer. 176px is enough — hashes and the sharp/blurry ordering are stable there. Beyond that you pay bytes without gaining discernment.'),
          num('analyzeInflight', 'Concurrent batches', 1, 8, 1,
            'Analysis requests run in parallel. Raise it on a fast connection; lower it to ease a modest machine.'),
          num('scanStepRatio', 'Scroll step', 0.4, 0.95, 0.01,
            'Fraction of the viewport crossed per step. Higher is faster, but risks missing items if rendering lags.'),
          num('scanSettleMaxMs', 'Max render wait (ms)', 200, 3000, 50,
            'A ceiling only: the actual wait adapts to render time. Raise it if listing misses items.'),
          num('thumbWaitMaxMs', 'Thumbnail wait (ms)', 0, 15000, 500,
            'Google Photos shows tiles before their images. Without this wait, listing records items with no thumbnail, which can never be analysed. 0 disables it — not recommended.'),
          el('div', { class: 'filter' },
            el('label', { class: 'switch' },
              el('input', {
                type: 'checkbox', checked: s.autoRepairThumbs,
                onchange: (e) => { s.autoRepairThumbs = e.target.checked; this.persist(); this.renderAll(); }
              }),
              el('span', {}, 'Recover missing thumbnails',
                el('br'),
                el('small', {}, `At the end of a run, brings items left without an image back on screen, then analyses them. Given up after ${MAX_THUMB_ATTEMPTS} attempts each.`))),
            num('autoRepairLimit', 'Recovery threshold', 0, 5000, 50,
              'Above this many items, one-by-one recovery is slower than a fresh pass over the grid, so the extension says so instead of attempting it.')))),

      el('section', {}, el('h2', {}, 'Local data'),
        el('div', { class: 'card' },
          el('div', { class: 'muted' },
            `${nf(this.state.items.length)} entries in IndexedDB, on the photos.google.com origin.`,
            this.state.cursor ? ' A resume position is stored.' : ''),
          el('div', { class: 'row', style: 'margin-top:10px' },
            el('button', { class: 'action', text: 'Export (JSON)', onclick: () => this.exportJson() }),
            el('span', { class: 'spacer' }),
            el('button', {
              class: 'action', text: 'Clear catalogue',
              title: 'Removes listed items and analyses, but keeps your settings and filters',
              disabled: !!this.state.busy,
              onclick: async () => {
                await db.clearAll();
                await this.reload();
                this.flashStatus('Catalogue cleared');
                this.renderAll();
              }
            }),
            el('span', { class: 'spacer' }),
            el('button', {
              class: 'action danger', text: 'Reset everything',
              title: 'Catalogue, analyses, settings and filters. Your photos are untouched.',
              disabled: !!this.state.busy,
              onclick: () => this.factoryReset()
            })))),

      el('section', {}, el('h2', {}, 'About'),
        el('div', { class: 'card' },
          el('div', { class: 'muted' },
            'All analysis is local. Thumbnails are downloaded from Google, exactly as the page would, then processed in memory. Nothing is sent to a third party.')))
    );
  }

  /**
   * Full reset, without confirmation: catalogue, analyses, settings, filters
   * and resume position. Photos are untouched — only the extension's local data
   * goes, and the only real cost is redoing the analysis.
   *
   * Refused while a run is in progress: wiping the database from under the
   * scanner would leave a half-rewritten catalogue.
   */
  async factoryReset() {
    if (this.state.busy) {
      this.flashStatus('Stop the current run first', 'error', 5000);
      return;
    }
    try {
      await db.clearAll();
      await chrome.storage.local.remove([SETTINGS_KEY, FILTERS_KEY]);
    } catch (err) {
      this.flashStatus(`Reset failed: ${err.message}`, 'error', 8000);
      this.renderAll();
      return;
    }

    this.state.settings = { ...DEFAULT_SETTINGS };
    this.state.filters = structuredClone(DEFAULT_FILTERS);
    this.state.selection = new Set();
    this.state.renderLimit = 120;
    this.state.tab = 'scan';
    this.dupCache = null;

    await this.reload();
    this.flashStatus('Extension reset');
    this.renderAll();
  }

  async exportJson() {
    const payload = {
      exportedAt: new Date().toISOString(),
      settings: this.state.settings,
      filters: this.state.filters,
      items: this.state.items
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: `gp-cleaner-${Date.now()}.json` });
    this.shadow.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  /* ------------------------------------------------------------------ footer */

  renderFooter() {
    this.footer.replaceChildren();
    const n = this.state.selection.size;
    const busy = this.state.busy === 'select';

    if (this.state.tab !== 'sort') {
      this.footer.append(el('div', { class: 'muted' },
        this.state.busy
          ? 'Working…'
          : 'Use the Sort tab to choose what to tick.'));
      return;
    }

    this.footerSummary = el('div', { class: 'summary' },
      el('b', {}, nf(n)), ' item(s) ticked');
    this.footer.append(
      this.footerSummary,
      el('div', { class: 'buttons' },
        el('button', {
          class: busy ? 'action' : 'action primary',
          text: busy ? 'Stop' : `Tick in Google Photos${n ? ` (${nf(n)})` : ''}`,
          disabled: (!!this.state.busy && !busy) || (!n && !busy),
          onclick: () => (busy ? this.selector?.abort() : this.startSelect())
        })),
      el('div', { class: 'muted', style: 'margin-top:7px; font-size:11px' },
        'Deleting stays in your hands: the extension ticks, you decide.'),
      (this.selectLog = el('div', { class: 'log' }))
    );
  }

  /* ------------------------------------------------------------------ actions */

  log(target, message, cls = '') {
    if (!target) return;
    target.prepend(el('div', { class: cls, text: message }));
    while (target.childElementCount > 40) target.lastElementChild.remove();
  }

  /**
   * Listing and analysis run together.
   *
   * The raw time saved is modest — listing is only a fraction of the total —
   * but analysis starts on the first items found, so results fill in
   * continuously instead of arriving after a long silence.
   *
   * Analysis is throttled while listing runs: both compete for the same link to
   * Google, and starving the grid would slow listing down — the one stage that
   * cannot be parallelised.
   */
  async startFullRun() {
    if (this.state.busy) return;
    this.state.busy = 'full';
    this.aborting = false;
    this.setStatus({ label: 'Starting engine…', ratio: null, tone: null });
    this.renderAll();

    const scanBar = this.scanBar;
    const scanLog = this.scanLog;
    const anaBar = this.analyzeBar;
    const anaLog = this.analyzeLog;

    const s = this.state.settings;
    this.scanner = new Scanner({
      stepRatio: s.scanStepRatio,
      settleMaxMs: s.scanSettleMaxMs,
      thumbSize: s.thumbSize,
      resume: s.resumeScan,
      maxNewItems: s.maxPerRun || Infinity,
      olderThanTs: s.scanOlderThanTs || null,
      waitForThumbs: (s.thumbWaitMaxMs ?? 5000) > 0,
      thumbWaitMaxMs: s.thumbWaitMaxMs ?? 5000
    });
    this.analyzer = new Analyzer({
      inflightBatches: Math.max(1, Math.round(s.analyzeInflight / 3)),
      maxPerPass: s.maxPerRun || Infinity
    });

    let scanDone = false;
    let scanStats = { discovered: 0, known: 0 };
    let anaStats = { done: 0, failed: 0, total: 0 };

    const refreshBadge = () => {
      this.setStatus({
        label: scanStats.seeking
          ? `Seeking older photos… ${nf(scanStats.skippedRecent || 0)} skipped`
          : `Listing ${nf(scanStats.discovered)} · Analysing ${nf(anaStats.done)}`,
        // While listing runs the denominator moves, and a bar that went
        // backwards would read as a regression. Only quantify it once the
        // total is known.
        ratio: scanDone && anaStats.total ? (anaStats.done + anaStats.failed) / anaStats.total : null
      });
    };

    try {
      const engine = await this.analyzer.engineStatus();
      this.log(anaLog, engine?.ok ? `Engine ready (${engine.pool} workers).` : `Engine unavailable: ${engine?.error || 'unknown'}`, engine?.ok ? '' : 'err');
      const fm = engine?.faceModel;
      if (fm) {
        this.state.faceModel = fm;
        this.log(anaLog, fm.error
          ? `People detection: heuristic fallback — ${fm.error}`
          : `People detection: ${fm.model}, ${fm.size} worker(s).`, fm.error ? 'err' : 'ok');
      }
      if (!engine?.ok) {
        this.state.busy = null;
        this.flashStatus('Analysis engine unavailable', 'error', 8000);
        return;
      }

      this.log(scanLog, 'Listing and analysis started together.');

      let scanResult = null;
      let scanError = null;
      const scanTask = this.scanner
        .run((st) => {
          scanStats = st;
          if (st.scrollHeight) {
            scanBar.style.width = `${Math.min(1, (st.scrollTop + st.clientHeight) / st.scrollHeight) * 100}%`;
          }
          scanLog.firstElementChild?.remove();
          const cov = Math.round((st.thumbRatio ?? 1) * 100);
          this.log(scanLog, st.seeking
            ? `Crossing recent photos… ${nf(st.skippedRecent)} skipped`
            : `${nf(st.discovered)} items · round ${st.rounds} · ${cov}% thumbnails ready`);
          refreshBadge();
        })
        .then((r) => { scanResult = r; })
        .catch((err) => { scanError = err; })
        .finally(() => {
          // Must be in `finally`: if listing fails and this flag stays false,
          // analysis waits forever for items that will never come.
          scanDone = true;
          scanBar.style.width = '100%';
          this.analyzer.setInflight(s.analyzeInflight);
        });

      const analyzeTask = this.analyzer
        .run((st) => {
          anaStats = st;
          if (scanDone && st.total) anaBar.style.width = `${((st.done + st.failed) / st.total) * 100}%`;
          anaLog.firstElementChild?.remove();
          this.log(anaLog, `${nf(st.done)} analysed${st.failed ? ` · ${nf(st.failed)} failed` : ''}`);
          refreshBadge();
        }, { waitForMore: () => !scanDone });

      const [, analyzeOutcome] = await Promise.allSettled([scanTask, analyzeTask]);

      if (scanError) this.log(scanLog, `Listing error: ${scanError.message}`, 'err');
      else if (scanResult) {
        this.log(scanLog, scanResult.limitReached
          ? `Run limit reached — ${nf(scanResult.discovered)} new items.`
          : scanResult.reachedBottom
            ? `End of library reached — ${nf(scanResult.discovered)} new items.`
            : `Listing stopped — ${nf(scanResult.discovered)} new items.`, 'ok');
        if (scanResult.skippedRecent) {
          this.log(scanLog, `${nf(scanResult.skippedRecent)} item(s) skipped as too recent.`);
        }
        if (scanResult.stillSeeking) {
          this.log(scanLog, 'No photo old enough was reached — the window may be too wide for this library.', 'err');
        }
        if (scanResult.repaired) {
          this.log(scanLog, `${nf(scanResult.repaired)} item(s) recovered their thumbnail and can now be analysed.`, 'ok');
        }
        if (scanResult.noUrl) {
          this.log(scanLog, `${nf(scanResult.noUrl)} item(s) seen before their thumbnail arrived — run again to recover them.`, 'err');
        }
      }

      if (analyzeOutcome.status === 'rejected') {
        this.log(anaLog, `Analysis error: ${analyzeOutcome.reason?.message || analyzeOutcome.reason}`, 'err');
        this.state.busy = null;
        this.flashStatus('Analysis failed', 'error', 8000);
        return;
      }

      this.log(anaLog, `Analysis done: ${nf(anaStats.done)} succeeded, ${nf(anaStats.failed)} failed.`, 'ok');

      // Recover thumbnails that arrived late, then analyse what was just
      // recovered: finishing the job is the machine's part, not the user's.
      const rattrapees = await this.autoRepair(scanLog, anaLog, refreshBadge);
      if (rattrapees) {
        this.analyzer.setInflight(s.analyzeInflight);
        const res2 = await this.analyzer.run((st) => {
          anaStats = st;
          anaLog.firstElementChild?.remove();
          this.log(anaLog, `Recovery · ${nf(st.done)} analysed`);
          refreshBadge();
        });
        this.log(anaLog, `Recovery done: ${nf(res2.done)} more images analysed.`, 'ok');
      }

      this.state.busy = null;
      this.flashStatus(`Done · ${nf(anaStats.done)} images analysed`);
    } catch (err) {
      this.log(scanLog, `Error: ${err.message}`, 'err');
      this.state.busy = null;
      this.flashStatus('Run failed', 'error', 8000);
    } finally {
      this.state.busy = null;
      await this.reload();
      this.renderAll();
    }
  }

  /**
   * Recover thumbnails that arrived after listing passed by.
   *
   * In practice a handful remain. Bringing each back on screen costs a second
   * or two — negligible for ten items, unreasonable for thousands. Above a
   * threshold a fresh pass over the grid is far faster, and we say so rather
   * than start it unannounced.
   *
   * @returns {Promise<number>} items recovered
   */
  async autoRepair(scanLog, anaLog, refreshBadge) {
    if (!this.state.settings.autoRepairThumbs) return 0;

    const targets = await db.getItemsMissingThumb(MAX_THUMB_ATTEMPTS);
    const plan = planThumbRepair({
      missing: targets.length,
      enabled: true,
      targetedLimit: this.state.settings.autoRepairLimit || 500
    });

    if (plan.mode === 'none') return 0;
    if (plan.mode === 'rescan') {
      this.log(scanLog,
        `${nf(plan.count)} thumbnails still missing: too many for one-by-one recovery. Run again — a fresh pass picks them up along the way.`,
        'err');
      return 0;
    }

    this.log(scanLog, `Recovering ${nf(plan.count)} late thumbnail(s)…`);
    this.setStatus({ label: `Recovery · 0/${nf(plan.count)}`, ratio: 0 });

    const res = await repairThumbnails(targets, {
      thumbSize: this.state.settings.thumbSize,
      shouldStop: () => this.aborting,
      onProgress: (p) => {
        this.setStatus({
          label: `Recovery · ${nf(p.done)}/${nf(p.total)}`,
          ratio: p.total ? p.done / p.total : null
        });
        scanLog.firstElementChild?.remove();
        this.log(scanLog, `Recovery ${nf(p.done)}/${nf(p.total)} · ${nf(p.repaired)} recovered`);
      }
    });

    this.log(scanLog,
      res.repaired
        ? `${nf(res.repaired)} thumbnail(s) recovered.`
        : 'No further thumbnails could be recovered.',
      res.repaired ? 'ok' : '');
    if (res.failed) {
      this.log(scanLog, `${nf(res.failed)} item(s) still have no preview — often videos still processing.`);
    }
    return res.repaired;
  }

  abortAll() {
    this.aborting = true;
    this.scanner?.abort();
    this.analyzer?.abort();
  }

  /**
   * Tick the selection in Google Photos, then hand control back.
   *
   * The extension stops here: you click "Move to bin" in Google's own UI, with
   * its own counter and confirmation. No execution path in this extension can
   * destroy a photo.
   */
  async startSelect() {
    if (this.state.busy) return;
    const ids = new Set(this.state.selection);
    const items = this.state.filtered.filter((i) => ids.has(i.id));
    if (!items.length) return;

    this.state.busy = 'select';
    this.setStatus({ label: 'Preparing…', ratio: null, tone: null });
    this.renderAll();
    const logBox = this.selectLog;

    this.selector = new Selector();

    try {
      this.log(logBox, `Ticking ${nf(items.length)} item(s) in Google Photos…`);
      const report = await this.selector.run(items, (e) => {
        this.setStatus({
          label: `Ticking · ${nf(e.done)}/${nf(e.total)}`,
          ratio: e.total ? e.done / e.total : null
        });
        logBox.firstElementChild?.remove();
        this.log(logBox, `${nf(e.selected)} ticked of ${nf(e.done)} processed`);
      });

      this.log(logBox, `Ticked: ${nf(report.selected.length)}/${nf(report.requested)}`);
      if (report.reported != null && report.reported !== report.selected.length) {
        this.log(logBox, `Google Photos reports ${nf(report.reported)} — the gap comes from checkboxes that did not take.`, 'err');
      }
      if (report.failed.length) {
        const reasons = new Map();
        for (const f of report.failed) reasons.set(f.reason, (reasons.get(f.reason) || 0) + 1);
        for (const [reason, count] of reasons) this.log(logBox, `${count}x failed: ${reason}`, 'err');
      }

      this.state.busy = null;
      if (report.aborted) {
        this.flashStatus('Ticking stopped', null, 5000);
      } else if (report.selected.length) {
        this.log(logBox, 'Over to you: check the selection in Google Photos, then use its own "Move to bin" button.', 'ok');
        this.flashStatus(`${nf(report.selected.length)} ticked in Photos`, 'done', 8000);
      } else {
        this.flashStatus('Nothing could be ticked', 'error', 8000);
      }
    } catch (err) {
      this.log(logBox, `Error: ${err.message}`, 'err');
      this.state.busy = null;
      this.flashStatus('Ticking failed', 'error', 8000);
    } finally {
      this.state.busy = null;
      await this.reload();
      this.renderAll();
    }
  }
}

/* ------------------------------------------------------------- fragments */

function kpi(value, label, cls = '') {
  return el('div', { class: `kpi ${cls}` }, el('b', {}, value), el('span', {}, label));
}

function chart(entries) {
  const max = Math.max(1, ...entries.map(([, v]) => v));
  return el('div', { class: 'chart' },
    entries.map(([label, value]) =>
      el('div', { class: 'bar' },
        el('span', {}, label),
        el('i', { style: `width:${(value / max) * 100}%` }),
        el('b', {}, nf(value)))));
}

function toDateInput(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
