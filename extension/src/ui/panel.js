/**
 * Cleaning panel.
 *
 * Rendered in a Shadow DOM attached to `documentElement`: Google Photos often
 * replaces the contents of `body`, and a host placed higher survives those
 * rebuilds (a MutationObserver re-inserts it if needed).
 */

import { PANEL_CSS } from './styles.js';
import * as db from '../content/db.js';
import { ApiScanner, readCursor, resetCursor } from '../content/api-scanner.js';
import { Analyzer } from '../content/analyze-client.js';
import { Selector } from '../content/actions.js';
import { Trasher, planTrash, formatBytes } from '../content/trash-client.js';
import { primeTokens } from '../content/tokens-client.js';
import {
  storageGet, storageSet, storageRemove, sendMessage,
  extensionAlive, isContextLost
} from '../content/runtime.js';
import {
  DEFAULT_FILTERS, applyFilters, clusterDuplicates, pickKeepers,
  countPerCriterion, computeStats, CRITERION_LABELS,
  SORTS, SORT_KEYS, groupSizeMap, itemBytes
} from '../common/filters.js';
import { formatDate } from '../common/dates.js';
import { groupLabel, DEFAULT_EPS } from '../analysis/cluster.js';
import { PEOPLE_RENDER_PX } from '../analysis/people-runner.js';
import {
  candidates as peopleCandidates, pending as pendingPeople,
  scanFaces, regroup, forDisplay
} from '../content/people-client.js';

const SETTINGS_KEY = 'gpc:settings';
const FILTERS_KEY = 'gpc:filters';
const PEOPLE_KEY = 'gpc:people';

const DEFAULT_SETTINGS = {
  // 176px: perceptual hashes and the sharp/blurry ordering are stable at this
  // scale (verified by tests) for about half the bytes of 256px — and transfer
  // is the dominant cost.
  thumbSize: 176,
  resumeScan: true,
  // One volume limit per run. A single visible action means a single limit:
  // two separate counters behind one button were impossible to reason about.
  // 0 means no limit.
  // A bounded run by default: it finishes, reports what it found, and can be
  // repeated. An unbounded first run on a large library looks like a hang.
  maxPerRun: 2000,
  analyzeInflight: 3,
  scanOlderThanTs: null,  // only handle items older than this date
  scanPeople: true,      // read faces as part of the main run
  // File name and byte size come from a second call per 200 items. Worth it:
  // size is the only thing here that says what a photo actually costs you, and
  // it is the reason to delete anything at all.
  scanSizes: true,
  lastAnalysisSplit: null, // where the per-photo work actually goes
  peopleEps: DEFAULT_EPS // how alike two faces must be to count as one person
};

/**
 * Settings that belonged to the scroll-and-harvest scanner.
 *
 * Nothing reads them any more — the API needs no scroll step, no render wait,
 * no thumbnail patience and no page zoom, because it renders nothing. They are
 * dropped rather than left lying in storage, so a stored value can never be
 * mistaken for a live control.
 */
const RETIRED_SETTINGS = [
  'scanMaxPerPass', 'analyzeMaxPerPass', 'scanSinceTs',
  'scanStepRatio', 'scanSettleMaxMs', 'thumbWaitMaxMs',
  'autoRepairThumbs', 'autoRepairLimit', 'scanZoom',
  'lastTilesPerStep', 'lastWaitSplit', 'lastThumbRatio', 'lastRunStarved'
];

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
  // The old time-window key meant the opposite (keep only recent items).
  // Carrying it over would silently invert the scope, so drop it instead.
  for (const key of RETIRED_SETTINGS) delete out[key];
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
    key: 'largeFile',
    icon: '💾',
    label: 'Large files',
    hint: 'The real size on Google\'s servers, which the grid never showed. Deleting one of these frees as much as hundreds of ordinary photos.',
    controls: [{ prop: 'largeFileMb', label: 'At least', min: 1, max: 500, step: 1, fmt: (v) => `${v} MB` }]
  },
  {
    key: 'dateRange',
    icon: '📅',
    label: 'Date range',
    hint: 'Restrict to a date interval.',
    controls: [{ prop: 'dateRange', type: 'daterange' }]
  },
  {
    key: 'withPerson',
    icon: '👥',
    label: 'With selected people',
    hint: 'Matches photos containing anyone ticked in the People list, below.',
    needsPeople: true,
    controls: []
  },
  {
    key: 'withoutPerson',
    icon: '🚫',
    label: 'Without selected people',
    hint: 'Photos not read yet never match, so "not analysed" is never mistaken for "absent".',
    needsPeople: true,
    controls: []
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

/**
 * Append children, ignoring the absent ones.
 *
 * `Node.append(null)` inserts the literal text "null" — it does not skip, the
 * way `el()` does for its own children. Every optional block in this file goes
 * through here so a section that has nothing to say stays silent instead of
 * printing the word.
 */
function put(parent, ...children) {
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    parent.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return parent;
}

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
      renderLimit: 300,
      busy: null,
      browsing: true,
      modalOpen: false,
      dupStale: false,
      faceModel: null,
      cursor: null,
      // The pending "are you sure" for a move to the bin. Null unless the user
      // has pressed the button and not yet answered.
      confirmTrash: null,
      // Set once the extension bridge dies under us — see `noteContext`.
      contextLost: false,
      people: { modelReady: false, groups: [], named: [], faceCount: 0, error: null, progress: null },
      // State shown permanently by the badge, even with the panel closed.
      status: { label: null, ratio: null, tone: null }
    };
    this.statusTimer = null;
    this.scanner = null;
    this.analyzer = null;
    this.selector = null;
    this.trasher = null;
    this.dupCache = null;
    this.liveFrame = null;
    this.counterEls = new Map();
    this.anchorIndex = null;
    this.rangePreview = null;
    this.shiftHeld = false;
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
    // Ask the page for its session credentials now rather than when the run
    // button is pressed: they arrive in a message from the other JavaScript
    // world, and waiting for that on the click would show a pause with no
    // explanation.
    primeTokens();
    this.watchShift();
    this.build();
    await this.reload();
    // Whether the model is already downloaded lives in the offscreen document's
    // storage, not in ours. Without asking, `modelReady` stays false on every
    // load and a model fetched yesterday is offered for download again.
    await this.refreshPeopleState();
    this.renderAll();
  }

  async loadPersisted() {
    try {
      const got = await storageGet([SETTINGS_KEY, FILTERS_KEY, PEOPLE_KEY]);
      if (got[SETTINGS_KEY]) Object.assign(this.state.settings, migrateSettings(got[SETTINGS_KEY]));
      if (Array.isArray(got[PEOPLE_KEY])) {
        // Only names and centroids persist. Groups themselves are rebuilt from
        // the stored faces, because their ids are positional.
        this.state.people.named = got[PEOPLE_KEY];
      }
      if (got[FILTERS_KEY]) {
        this.state.filters = {
          ...structuredClone(DEFAULT_FILTERS),
          ...got[FILTERS_KEY],
          enabled: { ...DEFAULT_FILTERS.enabled, ...(got[FILTERS_KEY].enabled || {}) }
        };
      }
    } catch { /* premier lancement */ }
  }

  /**
   * Save settings and filters.
   *
   * Called from every control, so it must never throw: a slider that raises an
   * uncaught error while being dragged is worse than one that fails to save.
   * A dead bridge is recorded and shown once, rather than reported on each of
   * the thirty writes that follow.
   */
  persist() {
    storageSet({ [SETTINGS_KEY]: this.state.settings, [FILTERS_KEY]: this.state.filters })
      .catch((err) => this.noteContext(err));
  }

  /**
   * Notice that the extension bridge has died, and say so exactly once.
   *
   * Reloading the extension leaves this content script running with a dead
   * `chrome.*`: the panel is still on screen, still responds, and silently does
   * nothing. Only a page reload fixes it, and only the user can decide when —
   * so the panel says so and stops pretending.
   *
   * @returns {boolean} true if this was a lost context
   */
  noteContext(err) {
    if (!isContextLost(err)) return false;
    if (this.state.contextLost) return true;
    this.state.contextLost = true;
    this.state.busy = null;
    this.setStatus({ label: 'Reload the page', ratio: null, tone: 'error' });
    try { this.renderAll(); } catch { /* the panel may be mid-render */ }
    return true;
  }

  /**
   * The one banner that outranks everything else on screen.
   *
   * It offers the reload rather than performing it: a run may be half done, or
   * a selection half made, and throwing the page away without asking would
   * lose both.
   */
  buildContextBanner() {
    if (!this.state.contextLost) return null;
    return el('div', { class: 'banner danger', style: 'margin-bottom:12px' },
      el('b', {}, 'Disconnected from the extension. '),
      'It was reloaded or updated while this page was open, so this panel can no longer reach it — nothing it shows is being saved.',
      el('div', { class: 'row', style: 'margin-top:8px' },
        el('button', {
          class: 'action primary', text: 'Reload the page',
          onclick: () => location.reload()
        })));
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
        title: 'GPhotos Cleaner — open panel',
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
    put(
      this.panel,
      el(
        'header',
        {},
        el('h1', {},
          el('span', { class: 'mark' }, 'GPhotos'), 'Cleaner',
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
      put(
        this.tabsNav,
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
    put(side, this.buildPeopleSection());

    const main = el('div', { class: 'main' });
    // The order bar sits above the grid it reorders, not in the side column
    // with the criteria: those two do different jobs, and mixing them invites
    // reading an order as one more thing that changes the selection.
    main.append(this.buildSortBar({ compact: true }));
    if (!this.state.filtered.length) {
      main.append(el('div', { class: 'muted' },
        Object.values(this.state.filters.enabled).some(Boolean)
          ? 'Nothing matches the active criteria.'
          : 'Nothing here yet — analyse your library first.'));
    } else {
      const grid = el('div', { class: 'grid' });
      shown.forEach((item, i) => grid.append(this.buildThumb(item, i)));
      main.append(grid);
      if (this.state.filtered.length > shown.length) {
        main.append(el('button', {
          class: 'action wide', style: 'margin-top:12px',
          text: `Show more (${nf(this.state.filtered.length - shown.length)} left)`,
          onclick: () => { this.state.renderLimit += 600; this.renderAll(); }
        }));
      }
    }

    this.modalCount = el('span', { class: 'count' }, this.countsLabel());

    this.modal.replaceChildren(
      el('header', {},
        el('h2', {}, 'Sort your library'),
        this.modalCount,
        el('span', { class: 'spacer' }),
        // Repainted, not re-rendered: rebuilding the grid would scroll the
        // user back to the top of a list they were partway through.
        el('button', { class: 'action', text: 'Tick all', onclick: () => {
          this.state.selection = new Set(this.state.filtered.map((i) => i.id));
          this.paintSelection();
        } }),
        el('button', { class: 'action', text: 'Untick all', onclick: () => {
          this.state.selection = new Set();
          this.paintSelection();
        } }),
        el('button', { class: 'icon-btn', text: '✕', title: 'Close (Esc)', onclick: () => this.closeModal() })),
      el('div', { class: 'layout' }, side, main),
      el('footer', {},
        el('div', { class: 'summary' },
          el('b', {}, nf(n)), ' ticked · ',
          el('span', { class: 'muted' }, 'the bin keeps them 60 days')),
        put(el('div', { class: 'buttons' }),
          el('button', {
            class: 'action',
            text: 'Tick in Photos',
            title: 'Tick the selection in Google Photos and leave the deleting to you',
            disabled: !!this.state.busy || !n,
            onclick: () => { this.closeModal(); this.startSelect(); }
          }),
          el('button', {
            class: 'action primary danger',
            text: `Move to bin${n ? ` (${nf(n)})` : ''}`,
            disabled: !!this.state.busy || !n,
            // Closed first: the confirmation belongs in the panel, where the
            // log of what happened is, and a full-screen grid over it would
            // hide both.
            onclick: () => { this.closeModal(); this.state.tab = 'sort'; this.confirmTrash(); }
          }))));
  }

  /** Tickable thumbnail, shared by the side preview and the modal. */
  buildThumb(item, index = 0) {
    const on = this.state.selection.has(item.id);
    return el(
      'div',
      {
        class: `thumb${on ? ' on' : ''}${item.isVideo ? ' video' : ''}`,
        'data-index': index,
        title: `${formatDate(item.ts, item.precision || 'day')}\n${(item.matched || []).map((m) => CRITERION_LABELS[m]).join(', ')}`,
        onmouseenter: () => this.previewRange(index),
        onclick: (ev) => this.pickThumb(item.id, index, ev.shiftKey)
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

  /**
   * Tick one thumbnail, or a whole run of them with Shift.
   *
   * The anchor is the last plain click. Shift applies *the anchor's* state to
   * the whole run rather than toggling each tile: dragging across a mixed
   * selection and watching every tile flip is the behaviour nobody wants, and
   * here a stray flip means a photo quietly joining a deletion list.
   */
  pickThumb(id, index, extend) {
    const sel = this.state.selection;
    const items = this.visibleItems();

    if (extend && this.anchorIndex != null && items[this.anchorIndex]) {
      const [from, to] = [this.anchorIndex, index].sort((a, b) => a - b);
      const turnOn = sel.has(items[this.anchorIndex].id);
      for (let i = from; i <= to; i++) {
        const target = items[i];
        if (!target) continue;
        if (turnOn) sel.add(target.id);
        else sel.delete(target.id);
      }
    } else {
      if (sel.has(id)) sel.delete(id);
      else sel.add(id);
      this.anchorIndex = index;
    }

    this.rangePreview = null;
    this.paintSelection();
  }

  /**
   * Repaint ticks in place instead of rebuilding the grid.
   *
   * `renderAll` calls `replaceChildren` on the modal, which throws away the
   * scroll position — so ticking a photo halfway down a long grid threw the
   * user back to the top, every time. Nothing about the grid's contents changes
   * when a tick does: only which tiles carry the class, and the counters.
   */
  paintSelection() {
    const sel = this.state.selection;
    const items = this.visibleItems();
    for (const node of this.shadow.querySelectorAll('.thumb')) {
      const item = items[Number(node.dataset.index)];
      if (!item) continue;
      const on = sel.has(item.id);
      node.classList.toggle('on', on);
      const mark = node.querySelector('.mark');
      if (mark) mark.textContent = on ? '✓' : '';
    }
    this.paintRangePreview();
    this.refreshCounters();
    this.renderFooter();
    this.renderBadge();
  }

  /**
   * Outline what Shift-clicking here would take.
   *
   * Shown while the key is held, because a range that only reveals itself after
   * the click is a range you discover by undoing it.
   */
  previewRange(index) {
    if (!this.shiftHeld || this.anchorIndex == null) return;
    const [from, to] = [this.anchorIndex, index].sort((a, b) => a - b);
    this.rangePreview = { from, to };
    this.paintRangePreview();
  }

  /**
   * Paint the outline directly instead of re-rendering.
   *
   * The grid holds hundreds of tiles and this fires on every pointer move; a
   * full render would leave the preview trailing the cursor it describes.
   */
  paintRangePreview() {
    const range = this.rangePreview;
    for (const node of this.shadow.querySelectorAll('.thumb')) {
      const i = Number(node.dataset.index);
      node.classList.toggle('ranged', !!range && i >= range.from && i <= range.to);
    }
  }

  clearRangePreview() {
    this.rangePreview = null;
    this.paintRangePreview();
  }

  /**
   * Track Shift on the document, not on the tiles.
   *
   * The key is usually pressed while the pointer already rests on a thumbnail,
   * and a handler bound to the tile would never see it.
   */
  watchShift() {
    const update = (ev) => {
      const held = !!ev.shiftKey;
      if (held === this.shiftHeld) return;
      this.shiftHeld = held;
      if (!held) this.clearRangePreview();
    };
    document.addEventListener('keydown', update, true);
    document.addEventListener('keyup', update, true);
    // A window that loses focus mid-press never delivers the keyup, which would
    // leave an outline painted over a grid that no longer does what it shows.
    window.addEventListener('blur', () => {
      this.shiftHeld = false;
      this.clearRangePreview();
    });
  }

  /** The list the grid is showing — what a tile index refers to. */
  visibleItems() {
    return this.state.filtered;
  }

  toggle(open) {
    const show = open ?? this.panel.hidden;
    this.panel.hidden = !show;
    // The badge stays visible and shifts: it also closes the panel, and hiding
    // it during a run would remove the only activity indicator available when
    // the panel is shut.
    this.badge.title = show
      ? 'GPhotos Cleaner — close panel'
      : 'GPhotos Cleaner — open panel';
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
    // A pending confirmation quotes a count and a size taken from the selection
    // as it was. Anything that recomputes the selection invalidates it, and a
    // confirmation that no longer matches what it will do is the one thing this
    // dialog must never be.
    this.state.confirmTrash = null;
    this.syncBlockedCriteria();
    const dup = this.duplicateSelection();
    this.state.counts = countPerCriterion(this.state.items, this.state.filters, dup.selectable);
    const r = applyFilters(this.state.items, this.state.filters, dup, {
      groupSizes: groupSizeMap(this.state.people.groups)
    });
    this.state.filtered = r.items;
    this.state.groups = r.groups;
    this.state.keepers = r.keepers;
    this.state.browsing = !!r.browsing;
    // With criteria on, everything shown was chosen by a rule, so ticking it
    // all is the useful default — and any filter change resets it, because a
    // stale partial selection is a trap.
    //
    // With no criterion on, the grid is the whole library and nothing has been
    // judged. Ticking it would put every photo one click from Google's bin, so
    // browsing starts empty and the user ticks what they mean.
    this.state.selection = r.browsing ? new Set() : new Set(r.items.map((i) => i.id));
  }

  /* ---------------------------------------------------------------- rendu */

  renderAll() {
    // Counter references are rebuilt on every render; keeping the old ones
    // would write into detached nodes.
    this.counterEls = new Map();
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

    put(

      t,
      this.buildContextBanner(),
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
        // The face pass is a second run over a subset, so it has its own
        // arithmetic. Leaving it out of the status made it look as though
        // nothing had happened, which is how it went unnoticed twice.
        this.buildPeopleStatus(),
        this.buildStorageLine(),
        failed
          ? el('div', { class: 'muted', style: 'margin-top:8px' },
              `${nf(failed)} thumbnail(s) failed, usually expired URLs. They are retried on the next run.`)
          : null,
        this.buildLegacyThumbNote(noThumb)
      )
    );

    const running = this.state.busy === 'full';

    this.scanBar = el('i');
    this.scanLog = el('div', { class: 'log' });
    this.analyzeBar = el('i');
    this.analyzeLog = el('div', { class: 'log' });

    put(

      t,
      el(
        'section',
        {},
        el('h2', {}, 'Analyse your library'),
        el(
          'div',
          { class: 'card' },
          el('div', { class: 'muted' },
            `Lists your library through the Google Photos API and measures each thumbnail at ${this.state.settings.thumbSize}px. Stop any time — progress is kept.`),

          this.buildSinceControl(),
          this.buildLimitControl(),
          this.buildSizeOption(),
          this.buildPeopleOption(),
          this.buildPlanNote(pending),
          this.buildResumeNote(),

          el(
            'div',
            { class: 'row', style: 'margin-top:12px' },
            el('button', {
              class: 'action primary',
              text: running ? 'Stop' : this.runLabel(pending),
              // A dead bridge means the analysis engine is unreachable: the
              // run would start, fail on its first batch, and report an error
              // that says nothing about the actual cause.
              disabled: this.state.contextLost || (!!this.state.busy && !running),
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
   * Items with no thumbnail, left behind by the old scroll-based listing.
   *
   * The API never produces them: it returns the thumbnail URL with the item, so
   * either both arrive or neither does. What is left is a catalogue built by an
   * earlier version, where tiles were read before their images had loaded.
   */
  buildLegacyThumbNote(noThumb) {
    if (!noThumb) return null;
    return el('div', { class: 'banner warn', style: 'margin-top:10px' },
      el('b', {}, `${nf(noThumb)} item(s) with no thumbnail, from an earlier version. `),
      'They were listed before their image had loaded, which the API listing no longer does. ',
      el('div', { class: 'row', style: 'margin-top:8px' },
        el('button', {
          class: 'action',
          text: 'Forget them',
          title: 'Remove them from the catalogue; the next run lists them properly',
          disabled: !!this.state.busy,
          onclick: () => this.dropUnusableItems()
        })));
  }

  /**
   * Drop catalogue entries nothing can ever use.
   *
   * Only the local record goes — these are rows that were never analysable, and
   * the next run re-lists the same photos with their URLs. Nothing on Google's
   * side is touched, which is why this needs no confirmation.
   */
  async dropUnusableItems() {
    const ids = this.state.items.filter((i) => !i.url).map((i) => i.id);
    if (!ids.length) return;
    await db.deleteItems(ids);
    await this.reload();
    this.flashStatus(`${nf(ids.length)} unusable entr(ies) removed`);
    this.renderAll();
  }

  /**
   * What the library costs, once the size pass has said so.
   *
   * Deleting photos is about storage, and until now the extension could not
   * name a single byte — the grid does not carry sizes. The figure is stated
   * with the count it covers, because a total over a fifth of the catalogue is
   * a different claim from a total over all of it.
   */
  buildStorageLine() {
    const total = this.state.items.length;
    if (!total) return null;
    let bytes = 0;
    let sized = 0;
    for (const it of this.state.items) {
      const b = itemBytes(it);
      if (b) { bytes += b; sized++; }
    }
    if (!sized) {
      return this.state.settings.scanSizes
        ? null
        : el('div', { class: 'muted tiny', style: 'margin-top:8px' },
            'File sizes are off, so nothing here can be sorted or filtered by weight.');
    }
    return el('div', { class: 'muted', style: 'margin-top:8px' },
      el('b', {}, formatBytes(bytes)),
      sized === total
        ? ' across the catalogue.'
        : ` across ${nf(sized)} of ${nf(total)} items — the rest have not been measured.`);
  }

  /**
   * Whether the run also asks for file names and sizes.
   *
   * One extra request per two hundred items, and the only source of a figure
   * the grid never had. Off is a legitimate choice on a very large library,
   * where it is the difference between one request per page and four.
   */
  buildSizeOption() {
    const s = this.state.settings;
    return el('div', { class: 'card', style: 'margin-top:10px' },
      el('label', { class: 'switch' },
        el('input', {
          type: 'checkbox', checked: s.scanSizes, disabled: !!this.state.busy,
          onchange: (e) => { s.scanSizes = e.target.checked; this.persist(); this.renderAll(); }
        }),
        el('span', {}, 'Also fetch file names and sizes'),
        el('small', {}, 'one extra request per 200 items; unlocks the size filter and order')));
  }

  runLabel(pending) {
    const limit = this.state.settings.maxPerRun || 0;
    const suffix = limit ? ` (${nf(limit)} max)` : '';
    if (!this.state.settings.resumeScan || !this.state.cursor) return `Analyse my library${suffix}`;
    if (this.state.cursor.reachedEnd) {
      return pending ? `Resume · ${nf(pending)} pending` : `Check for new photos${suffix}`;
    }
    if (this.state.cursor.olderThanTs !== (this.state.settings.scanOlderThanTs ?? null)) {
      return `Analyse my library${suffix}`;
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

    // The date window is stated by its own control just above; repeating it
    // here only made the sentence longer without adding anything.
    parts.push(limit ? `${nf(limit)} new photos` : 'your whole library');
    if (pending) parts.push(`${nf(pending)} pending`);

    return el('div', { class: 'banner info', style: 'margin-top:12px' },
      el('b', {}, 'This run: '),
      parts.join(' · '),
      limit ? el('div', { class: 'muted tiny' }, 'Run again to continue.') : null);
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
        `Only photos before ${formatDate(s.scanOlderThanTs)}.`));
    }
    return wrap;
  }

  /**
   * Explain where the next run will resume, and why.
   *
   * The position is a date now, not a scroll offset — the API is asked for
   * everything taken before a given instant. That makes it something a person
   * can check: if it does not match where they think they got to, the cursor is
   * wrong and "Start over" is right there.
   */
  buildResumeNote() {
    const c = this.state.cursor;
    if (!this.state.settings.resumeScan) {
      return el('div', { class: 'banner info', style: 'margin:10px 0 0' },
        'Resume off: always restarts from the newest photo.');
    }
    if (!c) return null;

    // A window change makes the stored position meaningless: it answers a
    // different question. Saying so beats silently restarting.
    const window = this.state.settings.scanOlderThanTs ?? null;
    if ((c.olderThanTs ?? null) !== window) {
      return el('div', { class: 'banner info', style: 'margin:10px 0 0' },
        el('b', {}, 'The date window changed. '),
        'The saved position belongs to the previous one, so this run starts fresh.');
    }

    if (c.reachedEnd) {
      return el('div', { class: 'banner info', style: 'margin:10px 0 0' },
        el('b', {}, 'Whole library listed. '),
        'The next run checks the top for new photos.');
    }

    return el('div', { class: 'banner info', style: 'margin:10px 0 0' },
      el('b', {}, c.lastTimestamp
        ? `Resuming at ${formatDate(c.lastTimestamp)}. `
        : 'Resuming where listing stopped. '),
      `${nf(c.known || 0)} already known.`);
  }


  /* ------------------------------------------------------------ onglet 2 */
  /**
   * Sort tab: a door, not a room.
   *
   * Judging thumbnails is the whole task, and a 440px column shows sixteen at a
   * time in a strip too narrow to tell a blurred face from a sharp one. The
   * criteria, the order bar and the grid all live in the wide view; keeping a
   * cramped copy here only invited working in the worse of the two.
   */
  renderSort() {
    const t = this.tabs.sort;
    t.replaceChildren();
    const analyzed = this.state.items.filter((i) => i.analyzed).length;
    const active = Object.values(this.state.filters.enabled).filter(Boolean).length;

    put(
      t,
      this.buildContextBanner(),
      this.buildCleanupScore(),
      analyzed
        ? null
        : el('div', { class: 'banner warn' },
            'No thumbnails analysed yet. Start with the ', el('b', {}, 'Analyse'),
            ' tab — without it, only the date range and video length criteria work.'),
      el('button', {
        class: 'action primary wide', text: '⤢  Open the sorting view',
        style: 'margin:4px 0 12px',
        title: 'Criteria on the left, order above, thumbnails filling the width',
        onclick: () => this.openModal()
      }),
      el('div', { class: 'muted' },
        'Criteria, ordering and the thumbnails are all in there. It uses the full width, which is what judging photos needs.'),
      el('div', { class: 'card', style: 'margin-top:12px' },
        el('div', { class: 'card-title' }, 'Right now'),
        el('div', { class: 'kpis' },
          kpi(nf(active), 'criteria on'),
          kpi(nf(this.state.filtered.length), 'matching'),
          kpi(nf(this.state.selection.size), 'ticked')),
        el('div', { class: 'muted tiny', style: 'margin-top:8px' },
          active
            ? `Ordered by "${SORTS[this.state.filters.sort]?.label ?? ''}". Everything matching is ticked.`
            : 'No criterion on: the whole library is shown, nothing ticked. Tick photos yourself, or switch a criterion on.'))
    );
  }

  /**
   * Say where the analysis spent itself, and what that implies.
   *
   * Worker-seconds, not wall-clock: sixteen run at once, so these add to more
   * than the run took. The ratio is the useful part, because each phase answers
   * to a different fix — a wider fetch pool, a smaller rendition, cheaper
   * maths, more detection workers — and a single total picks none of them.
   */
  describeAnalysis(spent) {
    const total = spent.fetch + spent.decode + spent.features + spent.detect;
    if (!total || !spent.photos) return 'No timing recorded.';

    const share = (v) => `${Math.round((v / total) * 100)}%`;
    const each = Math.round(total / spent.photos);
    const worst = ['fetch', 'decode', 'features', 'detect']
      .reduce((a, b) => (spent[a] >= spent[b] ? a : b));
    const advice = {
      fetch: 'Waiting on Google. More parallel fetches would help; a smaller thumbnail would help more.',
      decode: 'Decoding and drawing. A smaller thumbnail is the only lever.',
      features: 'The measurements themselves, on the main analysis workers.',
      detect: 'Face detection. It has its own, smaller pool — widen it.'
    }[worst];

    return `${each} ms of work per photo: ${share(spent.fetch)} fetch, ` +
      `${share(spent.decode)} decode, ${share(spent.features)} measuring, ` +
      `${share(spent.detect)} faces. ${advice}`;
  }

  /**
   * Face-pass counters, beside the analysis ones.
   *
   * It reads a subset — only photos the analysis found a face in — so its
   * numbers never match the totals above and are shown separately rather than
   * folded in. Silence here is what let two bugs run unnoticed: the pass
   * reported faces it had found while the store held none.
   */
  buildPeopleStatus() {
    const p = this.state.people;
    if (!this.state.settings.scanPeople && !p.faceCount) return null;

    const candidates = peopleCandidates(this.state.items);
    const todo = pendingPeople(this.state.items);
    const read = candidates.length - todo.length;

    return el('div', { style: 'margin-top:8px' },
      el('div', { class: 'kpis' },
        kpi(nf(read), 'faces read', read && !todo.length ? 'good' : ''),
        kpi(nf(p.faceCount), 'faces'),
        kpi(nf(p.groups.length), 'people')),
      todo.length
        ? el('div', { class: 'muted tiny' }, `${nf(todo.length)} still to read.`)
        : null);
  }

  /**
   * Whether the run also reads faces.
   *
   * One switch, always usable. Recognising people needs a 13 MB model that
   * cannot be bundled — its weights are licensed for non-commercial research
   * use and this extension is MIT — so the first run that needs it fetches it.
   *
   * The switch is therefore the consent, which is why the label says what it
   * will do rather than leaving it to a dialog nobody reads. It is the only
   * thing this extension ever fetches that is not one of your photos, and
   * turning it off means nothing is fetched at all.
   */
  buildPeopleOption() {
    const s = this.state.settings;
    const p = this.state.people;
    const busy = !!this.state.busy;

    const bar = p.progress
      ? el('div', {},
          el('div', { class: 'progress' }, el('i', { style: `width:${pct(p.progress.ratio)}` })),
          el('div', { class: 'muted tiny', text: p.progress.label }))
      : null;

    // Photos analysed before the switch was turned on would otherwise wait for
    // a run that never comes: the main analysis skips what it has already
    // measured, so it would never revisit them.
    const todo = pendingPeople(this.state.items);
    const candidates = peopleCandidates(this.state.items);

    return el('div', { class: 'card', style: 'margin-top:10px' },
      el('label', { class: 'switch' },
        el('input', {
          type: 'checkbox', checked: s.scanPeople, disabled: busy,
          onchange: (e) => { s.scanPeople = e.target.checked; this.persist(); this.renderAll(); }
        }),
        el('span', {}, 'Also group photos by person'),
        el('small', {}, `re-reads faces at ${PEOPLE_RENDER_PX}px`)),

      s.scanPeople && !p.modelReady
        ? el('div', { class: 'muted', style: 'margin-top:6px' },
            'The first run will fetch a ', el('b', {}, '13 MB'),
            ' recognition model, once — the only thing downloaded here that is not your photos. Untick to skip.')
        : null,

      bar,
      p.error ? el('div', { class: 'banner danger' }, p.error) : null,

      s.scanPeople && todo.length
        ? el('button', {
            class: 'action', style: 'margin-top:8px',
            disabled: busy,
            text: `Read faces in ${nf(todo.length)} photo(s)`,
            title: 'Catch up photos measured before this was switched on',
            onclick: () => this.runPeopleScan()
          })
        : null,

      s.scanPeople && !todo.length && p.modelReady
        ? el('div', {},
            el('div', { class: 'muted tiny', style: 'margin-top:6px' },
              p.faceCount
                ? `${nf(p.faceCount)} face(s) · ${nf(p.groups.length)} person(s). Pick them in Sort.`
                : `Marked read, but no face stored. ${nf(candidates.length)} can be read again.`),
            // Always reachable, because "marked read but nothing stored" is a
            // state the user cannot otherwise leave: nothing is pending, so the
            // catch-up button has nothing to offer, and the people list is
            // empty so its own reset is not on screen either.
            el('button', {
              class: p.faceCount ? 'action' : 'action primary',
              style: 'margin-top:8px',
              disabled: busy || !candidates.length,
              text: `Read all ${nf(candidates.length)} again`,
              title: 'Forget every stored face and read the candidates from scratch',
              onclick: () => this.rereadAllFaces()
            }))
        : null);
  }

  /**
   * Order buttons above the preview.
   *
   * An order is a reason to look, not a filter: it never changes what is
   * selected, only where it sits. That distinction is worth keeping visible,
   * because the grid is one click away from handing a selection to Google
   * Photos — so the active button explains itself rather than just lighting up.
   */
  buildSortBar({ compact = false } = {}) {
    const f = this.state.filters;
    const row = el('div', { class: 'sorts' });

    const anySized = this.state.items.some((i) => itemBytes(i) > 0);

    for (const key of SORT_KEYS) {
      const sort = SORTS[key];
      // Two orders rank by something a pass has to produce first. Shown and
      // disabled rather than hidden: a button that vanishes reads as a bug, and
      // the reason it is off is the useful part.
      const reason = sort.needsPeople && !this.state.people.groups.length
        ? 'Needs people: run the analysis with grouping switched on.'
        : sort.needsSizes && !anySized
          ? 'Needs file sizes: run the analysis with "fetch file names and sizes" switched on.'
          : null;
      row.append(el('button', {
        class: `sort${f.sort === key ? ' on' : ''}`,
        text: sort.label,
        disabled: !!reason,
        title: reason || sort.hint,
        onclick: () => { f.sort = key; this.onFilterChange(); }
      }));
    }

    const hint = el('div', { class: 'muted tiny', text: SORTS[f.sort]?.hint || '' });
    return compact
      ? el('div', { class: 'sortbar' }, row, hint)
      : el('section', {}, el('h2', {}, 'Order'), row, hint);
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

    // A criterion that needs the People pass is shown, not hidden: hiding it would
    // leave no trace of a feature the user may be looking for. It is disabled
    // with the reason stated, and untickable rather than silently inert.
    const blocked = crit.needsPeople ? this.peopleBlockReason() : null;

    return el(
      'div',
      { class: `filter${blocked ? ' disabled' : ''}` },
      el('label', {},
        el('input', {
          type: 'checkbox', checked: on && !blocked, disabled: !!blocked,
          onchange: (e) => { f.enabled[crit.key] = e.target.checked; this.onFilterChange(); }
        }),
        el('span', { class: 'icon' }, crit.icon || ''),
        crit.label,
        counter),
      el('div', { class: 'hint' }, blocked || crit.hint),
      // Only offer a way out when the fix is somewhere else. When the answer is
      // "pick someone", the list is directly below and a button sending the
      // user to another tab would be worse than no button at all.
      blocked
        ? (this.state.people.groups.length
            ? null
            : el('button', {
                class: 'action',
                text: 'Open the Analyse tab',
                onclick: () => { this.state.tab = 'scan'; this.renderAll(); }
              }))
        : controls
    );
  }

  /**
   * Untick any criterion that has become unusable.
   *
   * `buildCriterion` renders a blocked criterion as unticked, but rendering is
   * not state: without this the box would read "off" while the predicate kept
   * selecting photos — a filter acting invisibly, right next to the button that
   * hands a selection to Google Photos. Clearing the faces mid-session is
   * exactly how that happens.
   */
  syncBlockedCriteria() {
    for (const crit of CRITERIA) {
      if (!crit.needsPeople) continue;
      if (this.state.filters.enabled[crit.key] && this.peopleBlockReason()) {
        this.state.filters.enabled[crit.key] = false;
      }
    }
  }

  /**
   * Why the people criteria cannot be used right now, or null if they can.
   *
   * Three distinct answers, because the fix differs each time: get the model,
   * read the photos, or pick somebody. One vague "unavailable" would leave the
   * user guessing at all three.
   */
  peopleBlockReason() {
    const p = this.state.people;
    if (!p.modelReady) return 'Needs the recognition model — download it once in the Analyse tab.';
    if (!p.groups.length) return 'No people found yet. Run the analysis with grouping switched on.';
    if (!this.state.filters.personIds.length) return 'Tick at least one person in the list below.';
    return null;
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
    const r = applyFilters(this.state.items, this.state.filters, dup, {
      groupSizes: groupSizeMap(this.state.people.groups)
    });
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
    if (this.modalCount) this.modalCount.textContent = this.countsLabel();
    if (this.footerSummary) this.footerSummary.replaceChildren(el('b', {}, coches), ' item(s) ticked');
  }

  onFilterChange() {
    // A full recompute is under way, so the light update queued for the next
    // frame would be redundant.
    if (this.liveFrame) {
      cancelAnimationFrame(this.liveFrame);
      this.liveFrame = null;
    }
    this.state.renderLimit = 300;
    this.state.dupStale = false;
    this.recompute();
    this.persist();
    this.renderAll();
  }
  /* ------------------------------------------------------------ onglet 3 */

  /**
   * How alike two faces must be to count as one person.
   *
   * Exposed because the right value depends on whose photos these are. The
   * default was read off studio portraits, where the worst same-person pair sat
   * at 0.48 and the closest strangers at 0.63. A real library has profiles,
   * sunglasses and twenty years of ageing, which push same-person distances up
   * — so one person scatters across several groups unless this is loosened.
   *
   * The two failures are not symmetrical, and the wording says so. Too strict
   * and you get one person several times over, which is untidy. Too loose and
   * two people share a group, which offers up somebody else's photos.
   */
  buildEpsControl() {
    const s = this.state.settings;
    const busy = !!this.state.busy;
    const value = s.peopleEps;
    const risky = value > 0.63;

    const out = el('output', { text: value.toFixed(2) });
    return el('div', { style: 'margin-top:10px' },
      el('div', { class: 'slider' },
        el('label', {}, 'Same person if closer than'),
        el('input', {
          type: 'range', min: 0.45, max: 0.75, step: 0.01, value,
          disabled: busy,
          oninput: (e) => { out.textContent = Number(e.target.value).toFixed(2); },
          onchange: (e) => {
            s.peopleEps = Number(e.target.value);
            this.persist();
            this.rebuildGroups();
          }
        }),
        out,
        // Not resetButton(): that one restores filter defaults, and this is a
        // setting. Pointing it here would write undefined into the threshold.
        el('button', {
          class: 'reset', text: '↺',
          title: value === DEFAULT_EPS
            ? 'Already at the default'
            : `Restore the default (${DEFAULT_EPS.toFixed(2)})`,
          disabled: busy || value === DEFAULT_EPS,
          onclick: () => {
            s.peopleEps = DEFAULT_EPS;
            this.persist();
            this.rebuildGroups();
          }
        })),
      el('div', { class: risky ? 'banner warn' : 'muted tiny' },
        risky
          ? 'Past 0.63 two different people start sharing a group — check the "mixed?" flags before acting on a filter.'
          : 'Lower splits one person into several groups; higher risks merging two people. Changing it regroups straight away.'));
  }

  /**
   * The people picker, shown beside the criteria that use it.
   *
   * It sits in the sorting view rather than in a tab of its own because it is
   * not a place to go: it parameterises two criteria, and picking who you mean
   * belongs next to the box you just ticked. Nothing here starts work — reading
   * photos happens during the analysis that feeds it, so there is never a
   * second run to remember.
   */
  /**
   * What the grid is showing, in its own words.
   *
   * "matching" is a claim about criteria. With none on, the grid is simply the
   * library, and calling that a match would suggest a judgement nobody made.
   */
  countsLabel() {
    const total = nf(this.state.filtered.length);
    const ticked = nf(this.state.selection.size);
    return this.state.browsing
      ? `${total} photo(s) · ${ticked} ticked · no criterion on`
      : `${total} matching · ${ticked} ticked`;
  }

  buildPeopleSection() {
    const p = this.state.people;
    const busy = !!this.state.busy;

    if (!p.groups.length) {
      return el('div', { class: 'muted tiny', style: 'margin-top:10px' },
        !p.modelReady
          ? 'People: switch on "Also group photos by person" in Analyse, then run it.'
          : p.faceCount
            ? `${nf(p.faceCount)} face(s) found, no group yet — someone has to appear in at least two photos to be recognised.`
            : 'People: run the analysis with grouping switched on.');
    }

    const selected = new Set(this.state.filters.personIds);
    const list = el('div', { class: 'people' });

    for (const group of p.groups) {
      const on = selected.has(group.id);
      const covers = (group.cover || [])
        .map((id) => this.state.items.find((i) => i.id === id))
        .filter((i) => i && i.url)
        .slice(0, 3);

      list.append(
        el('div', { class: `person${on ? ' on' : ''}` },
          el('div', {
            class: 'faces',
            title: on ? 'Click to unselect' : 'Click to select for the people criteria',
            onclick: () => this.togglePerson(group.id)
          }, covers.length
            ? covers.map((i) => el('img', { src: i.url, loading: 'lazy', referrerPolicy: 'no-referrer' }))
            : el('span', { class: 'muted', text: 'no preview' })),
          el('input', {
            class: 'name', type: 'text', value: group.name || '',
            placeholder: groupLabel(group),
            onchange: (e) => this.renamePerson(group.id, e.target.value.trim())
          }),
          el('div', { class: 'meta' },
            el('span', { text: `${nf(group.size)} face(s)` }),
            // Spread is the merge signal: a wide group is the one likeliest to
            // hold two people, and that is exactly the case where acting on the
            // criterion deletes the wrong person's photos.
            group.spread > 0.3
              ? el('span', { class: 'warn', title: `Internal spread ${group.spread}`, text: 'mixed?' })
              : null),
          el('span', { class: 'mark', text: on ? '✓' : '' }))
      );
    }

    return el('div', { style: 'margin-top:6px' },
      el('h3', {}, `People (${nf(p.groups.length)})`),
      el('div', { class: 'muted tiny' },
        'Tick who you mean, then use the two people criteria above. Names survive a rebuild.'),
      list,
      this.buildEpsControl(),
      p.error ? el('div', { class: 'banner danger' }, p.error) : null,
      el('div', { class: 'buttons' },
        el('button', {
          class: 'action', text: 'Clear', disabled: !selected.size,
          title: 'Unselect every person',
          onclick: () => { this.state.filters.personIds = []; this.applyPersonFilters(); }
        }),
        el('button', {
          class: 'action', disabled: busy, text: 'Rebuild',
          title: 'Group every known face again from scratch',
          onclick: () => this.rebuildGroups()
        }),
        el('button', {
          class: 'action danger', disabled: busy, text: 'Forget',
          title: 'Drop every face and group; the model stays downloaded',
          onclick: () => this.clearPeopleData()
        })));
  }

  /* ---------------------------------------------------- people actions */

  send(message) {
    return sendMessage(message).catch((err) => {
      this.noteContext(err);
      throw err;
    });
  }

  /**
   * Persistence goes through the panel, as messaging already does.
   *
   * Both are the edges of this class, and routing them through named methods is
   * what lets the run be exercised without a browser attached.
   */
  saveFaces(results, analysed) {
    return db.saveFaces(results, analysed);
  }

  async refreshPeopleState() {
    const p = this.state.people;
    try {
      const status = await this.send({ type: 'PEOPLE_STATUS' });
      p.modelReady = !!status?.present;
    } catch {
      p.modelReady = false;
    }
    p.faceCount = await db.countFaces();
    if (p.faceCount && !p.groups.length) await this.rebuildGroups({ quiet: true });
  }

  /**
   * Download progress, straight to the bar.
   *
   * Repainted in place rather than through a full render: the message arrives
   * many times a second, and re-rendering the whole tab that often would fight
   * with the download for the main thread.
   */
  onModelProgress({ received, total }) {
    const p = this.state.people;
    if (!p.downloading) return;
    p.progress = {
      ratio: total ? received / total : 0,
      label: `${(received / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB`
    };
    const bar = this.shadow.querySelector('.tab:not([hidden]) .progress i');
    const text = this.shadow.querySelector('.tab:not([hidden]) .progress + .tiny');
    if (bar) bar.style.width = pct(p.progress.ratio);
    if (text) text.textContent = p.progress.label;
    if (!bar) this.renderAll();
  }

  /**
   * Make sure the recognition model is present, fetching it once if not.
   *
   * @returns {Promise<boolean>} false when it could not be had, so the caller
   *   skips the pass rather than failing the whole run: the visual analysis is
   *   worth keeping even when grouping is unavailable.
   */
  async ensureRecognitionModel(log = null) {
    const p = this.state.people;
    if (p.modelReady) return true;

    p.error = null;
    p.downloading = true;
    p.progress = { ratio: 0, label: 'Fetching the recognition model…' };
    if (log) this.log(log, 'Fetching the recognition model (13 MB, once)…');
    this.renderAll();

    try {
      const res = await this.send({ type: 'PEOPLE_DOWNLOAD' });
      if (!res?.ok) throw new Error(res?.error || 'download failed');
      p.modelReady = true;
      if (log) this.log(log, 'Recognition model ready.', 'ok');
      return true;
    } catch (err) {
      p.error = `Could not fetch the recognition model: ${err.message}. Grouping is skipped; everything else is unaffected.`;
      if (log) this.log(log, p.error, 'err');
      return false;
    } finally {
      p.downloading = false;
      p.progress = null;
    }
  }

  /**
   * Read faces and group them.
   *
   * `inline` marks the pass as a stage of the main run rather than its own job:
   * it keeps the existing busy state and writes to the analysis log, so the
   * whole thing reads as one operation with one progress bar.
   */
  async runPeopleScan({ inline = false, log = null } = {}) {
    if (!inline && this.state.busy) {
      this.flashStatus('Another run is in progress', 'error', 4000);
      return 0;
    }
    const p = this.state.people;
    const todo = pendingPeople(this.state.items);
    if (!todo.length) return 0;

    if (!inline) this.state.busy = 'people';

    // Fetched here rather than behind a button: the switch above is the
    // consent, and asking twice for the same decision only strands people who
    // ticked it and then wondered why nothing happened. Ordered before the
    // scan because every photo needs it.
    if (!p.modelReady && !(await this.ensureRecognitionModel(log))) {
      if (!inline) this.state.busy = null;
      this.renderAll();
      return 0;
    }

    p.error = null;
    p.progress = { ratio: 0, label: `0 / ${nf(todo.length)}` };
    if (log) this.log(log, `Reading faces in ${nf(todo.length)} photo(s)…`);
    this.renderAll();

    const totals = await scanFaces(todo, {
      send: (m) => this.send(m),
      save: (results, ids) => this.saveFaces(results, ids),
      onProgress: ({ done, total, faces }) => {
        p.progress = { ratio: total ? done / total : 1, label: `${nf(done)} / ${nf(total)} · ${nf(faces)} face(s)` };
        if (log) {
          log.firstElementChild?.remove();
          this.log(log, `Faces · ${nf(done)} / ${nf(total)} · ${nf(faces)} found`);
        }
        // Progress belongs to the Analyse tab now; repaint only that.
        this.renderScan();
      }
    });

    if (totals.errors.length) p.error = totals.errors[0];
    if (!inline) this.state.busy = null;
    p.progress = null;
    if (log) {
      this.log(log, `Faces done: ${nf(totals.faces)} in ${nf(totals.scanned)} photo(s)` +
        (totals.tooSmall ? `, ${nf(totals.tooSmall)} too small to identify` : ''), 'ok');
    } else {
      this.flashStatus(
        `${nf(totals.faces)} face(s) in ${nf(totals.scanned)} photo(s)` +
        (totals.tooSmall ? `, ${nf(totals.tooSmall)} too small to identify` : '')
      );
    }
    await this.reload();
    await this.rebuildGroups({ quiet: inline });
    return totals.faces;
  }

  async rebuildGroups({ quiet = false } = {}) {
    const p = this.state.people;
    const wasBusy = this.state.busy;
    if (!quiet) {
      this.state.busy = 'people';
      p.progress = { ratio: 1, label: 'Grouping…' };
      this.renderAll();
    }
    try {
      // Existing groups are passed in so their names can follow their person
      // across the rebuild; ids are positional and cannot carry a name.
      const { groups, faces } = await regroup({
        previous: p.groups,
        eps: this.state.settings.peopleEps
      });
      p.faceCount = faces;
      p.groups = forDisplay(groups, this.state.items);
      if (!quiet) await this.reload();
    } catch (err) {
      p.error = String(err?.message || err);
    } finally {
      this.state.busy = wasBusy === 'people' ? null : wasBusy;
      p.progress = null;
      this.recompute();
      this.renderAll();
    }
  }

  /**
   * Drop every stored face and read the candidates again.
   *
   * The escape hatch from "marked read, nothing stored" — a state a bug could
   * leave behind and which is otherwise a dead end, since nothing is pending
   * and the people list that carries the other reset is empty.
   */
  async rereadAllFaces() {
    if (this.state.busy) {
      this.flashStatus('Another run is in progress', 'error', 4000);
      return;
    }
    await db.clearFaces();
    this.state.people.groups = [];
    this.state.people.faceCount = 0;
    this.state.filters.personIds = [];
    await this.reload();
    await this.runPeopleScan();
  }

  async clearPeopleData() {
    this.state.busy = 'people';
    this.renderAll();
    try {
      await db.clearFaces();
      this.state.people.groups = [];
      this.state.people.faceCount = 0;
      this.state.filters.personIds = [];
      await this.reload();
      this.flashStatus('Faces and groups cleared');
    } catch (err) {
      this.state.people.error = String(err?.message || err);
    } finally {
      this.state.busy = null;
      this.recompute();
      this.renderAll();
    }
  }

  togglePerson(groupId) {
    const ids = this.state.filters.personIds;
    const at = ids.indexOf(groupId);
    if (at >= 0) ids.splice(at, 1);
    else ids.push(groupId);
    this.applyPersonFilters();
  }

  applyPersonFilters() {
    this.dupCache = null;
    this.recompute();
    this.persist();
    this.renderAll();
  }

  /**
   * Renaming touches only the panel's copy and the persisted list.
   *
   * Groups are recomputed from the faces every time, so the name has nowhere
   * durable to live except alongside the centroid that identifies the person.
   */
  renamePerson(groupId, name) {
    const group = this.state.people.groups.find((g) => g.id === groupId);
    if (!group) return;
    group.name = name || null;
    this.persistPeople();
    this.renderAll();
  }

  persistPeople() {
    const named = this.state.people.groups
      .filter((g) => g.name)
      .map((g) => ({ name: g.name, centroid: g.centroid }));
    storageSet({ [PEOPLE_KEY]: named }).catch((err) => this.noteContext(err));
  }


  /* ------------------------------------------------------------ onglet 4 */

  renderStats() {
    const t = this.tabs.stats;
    t.replaceChildren();
    const s = computeStats(this.state.items);

    if (!s.total) {
      t.append(el('div', { class: 'muted' }, 'Nothing to show yet — run an analysis.'));
      return;
    }

    put(

      t,
      el('section', {}, el('h2', {}, 'Overview'),
        el('div', { class: 'kpis' },
          kpi(nf(s.total), 'items'),
          kpi(nf(s.videos), 'videos'),
          kpi(dur(Math.round(s.videoSeconds)), 'of footage')),
        s.sized
          ? el('div', { class: 'kpis', style: 'margin-top:8px' },
              kpi(formatBytes(s.bytes), 'storage'),
              kpi(formatBytes(Math.round(s.bytes / s.sized)), 'per item'),
              kpi(s.sized === s.total ? 'all' : nf(s.sized), 'measured',
                s.sized === s.total ? 'good' : 'warn'))
          : null),
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
   * There should be none. The API returns the capture time with the item, so a
   * dateless entry can only have come from the old grid reading, where the date
   * was scraped from a tile label or inherited from a neighbour. Saying which
   * beats a dead-end count.
   */
  buildNoDateNote(s) {
    if (!s.noDate) return null;
    const legacy = this.state.items.filter((i) => i.ts == null && i.dateSource !== 'api').length;

    return el('div', { class: 'banner warn' },
      el('b', {}, `${nf(s.noDate)} item(s) with no usable date`),
      ' — they are excluded from the time histograms.',
      el('div', { style: 'margin-top:7px' },
        legacy === s.noDate
          ? 'All of them were listed by an earlier version, which read dates off the page. Listing them again through the API gives every one an exact capture time.'
          : 'The API returns a capture time with each item, so this should not happen. If it persists after a fresh run, the response format has changed.'));
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

    put(

      t,
      el('section', {}, el('h2', {}, 'Resume'),
        el('div', { class: 'card' },
          el('div', { class: 'muted' }, 'On a large library, bounding each run lets you work in slices without ever starting over: the date reached is remembered.'),
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
          el('div', { class: 'muted' },
            'Listing is a handful of requests now, so what remains to tune is the analysis of the thumbnails it returns.'),
          num('thumbSize', 'Thumbnail size', 96, 512, 16,
            'The dominant cost is transfer. 176px is enough — hashes and the sharp/blurry ordering are stable there. Beyond that you pay bytes without gaining discernment.'),
          num('analyzeInflight', 'Concurrent batches', 1, 8, 1,
            'Analysis requests run in parallel. Raise it on a fast connection; lower it to ease a modest machine.'))),

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
            'All analysis is local. The library is listed through the same private API the Google Photos web app uses on itself, with your own session; thumbnails are downloaded exactly as the page would and processed in memory. Nothing is sent to a third party.'),
          el('div', { class: 'muted', style: 'margin-top:8px' },
            'The only thing this extension can remove is a move to the bin, which Google keeps for 60 days. There is no permanent-delete path in the code.')))
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
      await storageRemove([SETTINGS_KEY, FILTERS_KEY, PEOPLE_KEY]);
    } catch (err) {
      this.flashStatus(`Reset failed: ${err.message}`, 'error', 8000);
      this.renderAll();
      return;
    }

    this.state.settings = { ...DEFAULT_SETTINGS };
    this.state.filters = structuredClone(DEFAULT_FILTERS);
    this.state.people = { modelReady: false, groups: [], named: [], faceCount: 0, error: null, progress: null };
    this.state.selection = new Set();
    this.state.confirmTrash = null;
    this.state.renderLimit = 300;
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

  /**
   * The footer, where the selection turns into an action.
   *
   * Two actions, deliberately unequal. The bin is primary: it is what the
   * extension is for, and it is reversible for sixty days. Ticking is kept
   * beside it because it leaves the final click to Google's own interface,
   * which is the right choice for anyone who would rather see the selection in
   * Photos before parting with it.
   */
  renderFooter() {
    this.footer.replaceChildren();
    const n = this.state.selection.size;
    const ticking = this.state.busy === 'select';
    const binning = this.state.busy === 'trash';

    if (this.state.tab !== 'sort') {
      this.footer.append(el('div', { class: 'muted' },
        this.state.busy
          ? 'Working…'
          : 'Use the Sort tab to choose what to remove.'));
      return;
    }

    this.footerSummary = el('div', { class: 'summary' },
      el('b', {}, nf(n)), ' item(s) ticked');
    put(
      this.footer,
      this.footerSummary,
      this.buildTrashConfirm(),
      el('div', { class: 'buttons' },
        el('button', {
          class: binning ? 'action' : 'action primary',
          text: binning ? 'Stop' : `Move to bin${n ? ` (${nf(n)})` : ''}`,
          disabled: (!!this.state.busy && !binning) || (!n && !binning),
          onclick: () => (binning ? this.trasher?.abort() : this.confirmTrash())
        }),
        el('button', {
          class: 'action',
          text: ticking ? 'Stop' : 'Tick in Photos',
          title: 'Tick the selection in Google Photos and leave the deleting to you',
          disabled: (!!this.state.busy && !ticking) || (!n && !ticking),
          onclick: () => (ticking ? this.selector?.abort() : this.startSelect())
        })),
      el('div', { class: 'muted', style: 'margin-top:7px; font-size:11px' },
        'The bin keeps photos for 60 days — nothing here deletes permanently.'),
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
   * They always did, but it used to be a compromise: listing drove the grid and
   * analysis competed with it for the same connection, so analysis was
   * throttled while a scroll was in progress. Nothing competes now — a page of
   * five hundred items is one request — so both run at full speed and results
   * appear while the listing is still going.
   */
  async startFullRun() {
    if (this.state.busy) return;
    await this.doFullRun();
  }

  async doFullRun() {
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
    const limit = s.maxPerRun || Infinity;
    this.scanner = new ApiScanner({
      thumbSize: s.thumbSize,
      resume: s.resumeScan,
      maxNewItems: limit,
      olderThanTs: s.scanOlderThanTs || null,
      withSizes: s.scanSizes
    });
    this.analyzer = new Analyzer({
      inflightBatches: s.analyzeInflight,
      maxPerPass: limit
    });

    let scanDone = false;
    let scanStats = { discovered: 0, known: 0, pages: 0 };
    let anaStats = { done: 0, failed: 0, total: 0 };

    const refreshBadge = () => {
      this.setStatus({
        label: `Listing ${nf(scanStats.discovered)} · Analysing ${nf(anaStats.done)}`,
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

      this.log(scanLog, 'Asking Google Photos for your library…');

      let scanResult = null;
      let scanError = null;
      const scanTask = this.scanner
        .run((st) => {
          scanStats = st;
          // The library size is unknown until the last page, so progress is
          // measured against the run's own limit when there is one, and left
          // indeterminate when there is not. Inventing a denominator would be
          // the one thing worse than no bar.
          if (Number.isFinite(limit)) {
            scanBar.style.width = `${Math.min(1, st.discovered / limit) * 100}%`;
          }
          scanLog.firstElementChild?.remove();
          this.log(scanLog,
            `${nf(st.discovered)} new · page ${st.pages}`
            + (st.skippedRecent ? ` · ${nf(st.skippedRecent)} too recent` : '')
            + (st.alreadyKnown ? ` · ${nf(st.alreadyKnown)} already known` : ''));
          refreshBadge();
        })
        .then((r) => { scanResult = r; })
        .catch((err) => { scanError = err; })
        .finally(() => {
          // Must be in `finally`: if listing fails and this flag stays false,
          // analysis waits forever for items that will never come.
          scanDone = true;
          scanBar.style.width = '100%';
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
          : scanResult.reachedEnd
            ? `End of library reached — ${nf(scanResult.discovered)} new items.`
            : `Listing stopped — ${nf(scanResult.discovered)} new items.`, 'ok');

        this.log(scanLog,
          `${nf(scanResult.pages)} page(s), ${nf(scanResult.requests)} request(s)`
          + (scanResult.retries ? ` · ${nf(scanResult.retries)} retried` : '') + '.');

        if (scanResult.skippedRecent) {
          this.log(scanLog, `${nf(scanResult.skippedRecent)} item(s) skipped as too recent.`);
        }
        if (scanResult.alreadyKnown) {
          this.log(scanLog, `${nf(scanResult.alreadyKnown)} item(s) were already in the catalogue.`);
        }
        // The API returns the thumbnail with the item, so this should be zero.
        // It is reported anyway: if it ever stops being zero, that is Google
        // changing something, and a gap nobody is told about is how the last
        // one ran unnoticed for weeks.
        if (scanResult.skippedNoThumb) {
          this.log(scanLog,
            `${nf(scanResult.skippedNoThumb)} item(s) came back with no thumbnail URL and were not listed.`, 'err');
        }
        if (scanResult.sized) {
          this.log(scanLog,
            `${nf(scanResult.sized)} file size(s) read — ${formatBytes(scanResult.bytes)} listed this run.`);
        } else if (s.scanSizes && scanResult.discovered) {
          this.log(scanLog, 'File sizes could not be read this run; everything else is unaffected.');
        }
        if (scanResult.error) {
          this.log(scanLog, `Listing ended early: ${scanResult.error.message}`, 'err');
        }
      }

      if (analyzeOutcome.status === 'rejected') {
        this.log(anaLog, `Analysis error: ${analyzeOutcome.reason?.message || analyzeOutcome.reason}`, 'err');
        this.state.busy = null;
        this.flashStatus('Analysis failed', 'error', 8000);
        return;
      }

      this.log(anaLog, `Analysis done: ${nf(anaStats.done)} succeeded, ${nf(anaStats.failed)} failed.`, 'ok');
      if (anaStats.spent?.photos) {
        this.state.settings.lastAnalysisSplit = { ...anaStats.spent };
        this.persist();
        this.log(anaLog, this.describeAnalysis(anaStats.spent));
      }

      // The people pass rides on the same run: it needs the face scores the
      // analysis just produced, so it cannot start earlier, and asking the user
      // to press a second button for a second wait would be a poor trade.
      let peopleDone = 0;
      if (s.scanPeople) {
        await this.reload();
        peopleDone = await this.runPeopleScan({ inline: true, log: anaLog });
      }

      this.state.busy = null;
      this.flashStatus(
        `Done · ${nf(anaStats.done)} images analysed` +
        (peopleDone ? ` · ${nf(peopleDone)} face(s)` : '')
      );
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

  abortAll() {
    this.aborting = true;
    this.scanner?.abort();
    this.analyzer?.abort();
  }

  /**
   * Tick the selection in Google Photos, then hand control back.
   *
   * The alternative to binning it here: you click "Move to bin" in Google's own
   * UI, with its own counter and confirmation. Slower, because ticking has to
   * happen in a grid that only renders what is on screen — and worth keeping
   * for exactly that reason, since it puts the last click in Google's hands.
   */
  async startSelect() {
    if (this.state.busy) return;
    const ids = new Set(this.state.selection);
    // Grid order, not display order: the grid runs newest to oldest, and the
    // sorting view may be showing something else entirely. Ticking in the order
    // the user happens to be looking at would walk the scroller back and forth
    // across the whole library.
    const items = this.state.items
      .filter((i) => ids.has(i.id))
      .sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0) || (a.id < b.id ? -1 : 1));
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

  /* -------------------------------------------------------------- deletion */

  /**
   * What a deletion would actually do, in the words the confirmation uses.
   *
   * Built here rather than inside the dialog so it can be checked without a
   * browser: this text is the entire basis on which someone agrees to remove
   * hundreds of photos, and it must never claim more than it will do.
   */
  trashSummary() {
    const ids = this.state.selection;
    const items = this.state.items.filter((i) => ids.has(i.id));
    return { ...planTrash(items), requested: items.length };
  }

  /**
   * Ask, in the plainest terms available, then move the selection to the bin.
   *
   * The confirmation is a step in the panel rather than a `confirm()` dialog:
   * this extension runs inside Google's page, and a native dialog there blocks
   * everything, including our own progress. It states the count, the storage it
   * frees, and — the part that makes this reversible and therefore acceptable —
   * that the photos land in Google's bin for sixty days.
   */
  confirmTrash() {
    if (this.state.busy) return;
    const plan = this.trashSummary();
    if (!plan.deletable.length) {
      this.flashStatus('Nothing in the selection can be binned', 'error', 6000);
      return;
    }
    this.state.confirmTrash = plan;
    this.renderAll();
  }

  cancelTrash() {
    this.state.confirmTrash = null;
    this.renderAll();
  }

  /**
   * The confirmation panel. Rendered in the footer and in the sorting view,
   * because those are the two places the button can be pressed from.
   */
  buildTrashConfirm() {
    const plan = this.state.confirmTrash;
    if (!plan) return null;

    const skipped = plan.noKey.length + plan.notOwned.length;
    return el('div', { class: 'banner danger', style: 'margin-top:10px' },
      el('b', {}, `Move ${nf(plan.deletable.length)} photo(s) to the Google Photos bin?`),
      el('div', { class: 'muted', style: 'margin-top:6px' },
        plan.sizedCount
          ? `About ${formatBytes(plan.bytes)} of storage`
            + (plan.sizedCount < plan.deletable.length
              ? ` (measured on ${nf(plan.sizedCount)} of them).`
              : '.')
          : 'File sizes are unknown for this selection, so the storage freed cannot be stated.'),
      el('div', { style: 'margin-top:6px' },
        'They stay in the bin for 60 days, and can be restored from there. Nothing is deleted permanently.'),
      skipped
        ? el('div', { class: 'muted tiny', style: 'margin-top:6px' },
            `${nf(skipped)} item(s) in the selection will be left alone: `
            + [plan.notOwned.length ? `${nf(plan.notOwned.length)} shared by someone else` : null,
               plan.noKey.length ? `${nf(plan.noKey.length)} listed before this version and missing the key the API needs` : null]
              .filter(Boolean).join(', ') + '.')
        : null,
      el('div', { class: 'row', style: 'margin-top:10px' },
        el('button', {
          class: 'action danger',
          text: `Move ${nf(plan.deletable.length)} to bin`,
          onclick: () => this.startTrash()
        }),
        el('span', { class: 'spacer' }),
        el('button', { class: 'action', text: 'Cancel', onclick: () => this.cancelTrash() })));
  }

  /**
   * Do it.
   *
   * The catalogue entry for a photo is dropped only after Google confirms
   * taking it, and only for that photo — see `Trasher`. A row removed for
   * something still in the library would hide it from every later run.
   */
  async startTrash() {
    const plan = this.state.confirmTrash;
    if (!plan || this.state.busy) return;
    this.state.confirmTrash = null;
    this.state.busy = 'trash';
    this.setStatus({ label: 'Moving to bin…', ratio: 0, tone: null });
    this.renderAll();

    const logBox = this.selectLog;
    this.trasher = new Trasher();

    try {
      this.log(logBox, `Moving ${nf(plan.deletable.length)} photo(s) to the bin…`);
      const report = await this.trasher.run(plan.deletable, (p) => {
        this.setStatus({
          label: `Binning · ${nf(p.done)}/${nf(p.total)}`,
          ratio: p.total ? p.done / p.total : null
        });
        logBox?.firstElementChild?.remove();
        this.log(logBox, `${nf(p.trashed)} moved of ${nf(p.done)} sent`);
      });

      for (const message of report.errors || []) {
        this.log(logBox, `Refused by Google Photos: ${message}`, 'err');
      }

      this.state.busy = null;
      if (report.trashed) {
        this.state.selection = new Set();
        this.log(logBox,
          `${nf(report.trashed)} photo(s) are in the bin. Restore them from Google Photos → Bin within 60 days.`, 'ok');
        this.flashStatus(`${nf(report.trashed)} moved to the bin`, 'done', 8000);
      } else {
        this.flashStatus('Nothing could be moved to the bin', 'error', 8000);
      }
      if (report.failed) {
        this.log(logBox, `${nf(report.failed)} photo(s) could not be moved; they are still in your library.`, 'err');
      }
    } catch (err) {
      this.log(logBox, `Error: ${err.message}`, 'err');
      this.state.busy = null;
      this.flashStatus('Move to bin failed', 'error', 8000);
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
