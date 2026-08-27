/**
 * Panel stylesheet, injected into a Shadow DOM.
 *
 * Shadow DOM isolation is essential: Google Photos defines very broad styles
 * and rebuilds its tree constantly. None of our rules may leak into the page,
 * and none of theirs may reach us.
 *
 * Visual direction: arcade dashboard. Sorting ten thousand photos is a chore;
 * the UI treats it as a game — a score, a gauge that fills, milestones that
 * light up. Near-black ink background, amber-to-coral accent reserved for what
 * is progressing, mint for what is achieved, condensed tabular numerals that
 * read like a scoreboard.
 *
 * The amber is deliberately far from the Google Photos blue: the panel should
 * read as a separate tool sitting on the page, never as part of it.
 *
 * No remote fonts: the page CSP blocks external requests and a content script
 * cannot preload anything. The families below ship with the OS, with fallbacks.
 */

export const PANEL_CSS = `
:host {
  /* ink */
  --ink: #0e0e13;
  --bg: #14141b;
  --bg-raised: #1c1c25;
  --bg-input: #262630;
  --line: #30303d;
  --line-soft: #24242f;

  /* text */
  --text: #f2f0ee;
  --text-dim: #9b98a6;
  --text-faint: #6d6a78;

  /* Stacking, lowest first.
     The panel lives inside Google's own page, so the ladder starts at the
     ceiling of what a page may use and counts up from there. Named, because a
     bare 2147483002 says nothing about what it has to sit above — the viewer
     was written as 2147483001, which is the panel's rung, leaving it *under*
     the sorting view it opens from and behind an opaque background. */
  --z-badge: 2147483000;
  --z-panel: 2147483001;
  --z-modal: 2147483002;
  --z-viewer: 2147483003;

  /* accents */
  --amber: #ffc14d;
  --coral: #ff7a5e;
  --mint: #5ee0a5;
  --sky: #6bc7ff;
  --rose: #ff6b81;
  --accent: var(--amber);
  --grad: linear-gradient(135deg, #ffc14d 0%, #ff7a5e 100%);
  --grad-mint: linear-gradient(135deg, #5ee0a5 0%, #6bc7ff 100%);

  --r-sm: 8px;
  --r-md: 12px;
  --r-lg: 18px;

  --display: "Bahnschrift", "DIN Alternate", "Haettenschweiler", "Arial Narrow", system-ui, sans-serif;
  --body: "Segoe UI Variable Text", "Segoe UI", "Helvetica Neue", system-ui, sans-serif;
  --mono: "Cascadia Mono", "Consolas", ui-monospace, monospace;

  all: initial;
}

*, *::before, *::after { box-sizing: border-box; }

.wrap {
  font: 13px/1.5 var(--body);
  color: var(--text);
  -webkit-font-smoothing: antialiased;
}

/* Numerals: condensed, tabular, aligned — the scoreboard look. */
.num, .kpi b, .bar b, .count, output, .ring-value, .score-value {
  font-family: var(--display);
  font-variant-numeric: tabular-nums;
  letter-spacing: .01em;
}

/* --------------------------------------------------------------- badge */

.badge {
  position: fixed;
  top: 72px;
  right: 16px;
  z-index: var(--z-badge);
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 15px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: rgba(20, 20, 27, .94);
  backdrop-filter: blur(10px) saturate(1.2);
  color: var(--text);
  font: 600 12.5px/1 var(--display);
  letter-spacing: .02em;
  box-shadow: 0 2px 8px rgba(0,0,0,.5), 0 12px 32px rgba(0,0,0,.4);
  cursor: pointer;
  transition: right .24s cubic-bezier(.22,1,.36,1), background .16s, border-color .16s, transform .16s;
}
.badge::before {
  content: "";
  position: absolute; inset: -1px;
  border-radius: inherit;
  padding: 1px;
  background: var(--grad);
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
          mask-composite: exclude;
  opacity: 0;
  transition: opacity .2s;
  pointer-events: none;
}
.badge:hover { background: rgba(30,30,40,.96); transform: translateY(-1px); }
.badge:hover::before, .badge.busy::before { opacity: 1; }
.badge.panel-open { right: 456px; }
.badge.busy { padding-bottom: 14px; }
.badge.error { border-color: var(--rose); color: #ffb3bd; }
.badge.done { border-color: var(--mint); }

.badge .glyph { width: 13px; height: 13px; flex: 0 0 auto; position: relative; }
.badge .glyph.idle::after {
  content: ""; position: absolute; inset: 3px;
  border-radius: 50%; background: var(--text-faint);
}
.badge .glyph.ready::after { background: var(--mint); box-shadow: 0 0 8px rgba(94,224,165,.7); }
.badge .glyph.spinner {
  border: 2px solid rgba(255,255,255,.14);
  border-top-color: var(--amber);
  border-right-color: var(--coral);
  border-radius: 50%;
  animation: spin .7s linear infinite;
}
.badge .glyph.err::after {
  content: "!"; position: absolute; inset: 0;
  text-align: center; font: 700 12px/13px var(--display); color: var(--rose);
}
.badge .glyph.ok::after {
  content: "✓"; position: absolute; inset: 0;
  text-align: center; font-size: 12px; line-height: 13px; color: var(--mint);
}
@keyframes spin { to { transform: rotate(360deg); } }

.badge .label { white-space: nowrap; font-variant-numeric: tabular-nums; }
.badge .bar {
  position: absolute; left: 13px; right: 13px; bottom: 6px;
  height: 3px; border-radius: 2px;
  background: rgba(255,255,255,.12);
  overflow: hidden;
}
.badge .bar[hidden] { display: none; }
.badge .bar i {
  display: block; height: 100%; width: 0;
  background: var(--grad);
  border-radius: inherit;
  transition: width .25s cubic-bezier(.22,1,.36,1);
}
.badge .bar.indeterminate i { width: 35%; animation: slide 1.1s ease-in-out infinite; }
@keyframes slide {
  0% { transform: translateX(-110%); }
  100% { transform: translateX(320%); }
}

/* --------------------------------------------------------------- panel */

.panel {
  position: fixed;
  top: 0; right: 0; bottom: 0;
  width: 440px;
  max-width: 100vw;
  z-index: var(--z-panel);
  display: flex;
  flex-direction: column;
  background: var(--bg);
  border-left: 1px solid var(--line);
  box-shadow: -16px 0 50px rgba(0,0,0,.55);
}
.panel[hidden] { display: none; }

/* Ambient glow: the panel has a light source, not a flat fill. */
.panel::before {
  content: "";
  position: absolute; inset: 0;
  background:
    radial-gradient(120% 45% at 100% 0%, rgba(255,193,77,.10), transparent 60%),
    radial-gradient(90% 40% at 0% 100%, rgba(107,199,255,.06), transparent 65%);
  pointer-events: none;
}

header {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 15px 16px 13px;
  border-bottom: 1px solid var(--line-soft);
  flex: 0 0 auto;
}
header h1 {
  margin: 0; flex: 1;
  font: 700 15px/1.1 var(--display);
  letter-spacing: .04em;
  text-transform: uppercase;
}
header h1 .mark {
  background: var(--grad);
  -webkit-background-clip: text;
          background-clip: text;
  color: transparent;
}
header .sub {
  display: block;
  font: 400 11px/1.4 var(--body);
  letter-spacing: 0;
  text-transform: none;
  color: var(--text-dim);
  margin-top: 3px;
}
header .sub.busy { color: var(--amber); }
header .sub.error { color: var(--rose); }

.icon-btn {
  background: none; border: none; color: var(--text-faint);
  font-size: 17px; line-height: 1; cursor: pointer;
  padding: 5px 7px; border-radius: var(--r-sm);
  transition: background .15s, color .15s;
}
.icon-btn:hover { background: var(--bg-input); color: var(--text); }
.icon-btn.danger:hover { background: rgba(255,107,129,.14); color: var(--rose); }
.icon-btn:disabled { opacity: .28; cursor: default; background: none; }

nav {
  position: relative;
  display: flex;
  gap: 2px;
  padding: 8px 12px 0;
  border-bottom: 1px solid var(--line-soft);
  flex: 0 0 auto;
}
nav button {
  flex: 1;
  padding: 9px 4px 10px;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--text-faint);
  font: 600 11.5px/1 var(--display);
  letter-spacing: .06em;
  text-transform: uppercase;
  cursor: pointer;
  transition: color .15s;
}
nav button:hover { color: var(--text); }
nav button[aria-selected="true"] {
  color: var(--text);
  border-image: var(--grad) 1;
  border-bottom-width: 2px;
  border-bottom-style: solid;
}

.body { position: relative; flex: 1 1 auto; overflow-y: auto; padding: 16px 16px 24px; }
.body::-webkit-scrollbar { width: 10px; }
.body::-webkit-scrollbar-thumb { background: #353544; border-radius: 5px; border: 3px solid var(--bg); }

.tab[hidden] { display: none; }
/* One orchestrated reveal per tab rather than a swarm of micro-animations:
   attention goes to the content, not the motion. */
.tab > * { animation: rise .34s cubic-bezier(.22,1,.36,1) backwards; }
.tab > *:nth-child(2) { animation-delay: .04s; }
.tab > *:nth-child(3) { animation-delay: .08s; }
.tab > *:nth-child(4) { animation-delay: .12s; }
.tab > *:nth-child(n+5) { animation-delay: .16s; }
@keyframes rise {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) {
  .tab > *, .badge, .thumb, .action { animation: none !important; transition: none !important; }
}

/* --------------------------------------------------------------- blocs */

section { margin-bottom: 20px; }
section > h2 {
  margin: 0 0 9px;
  font: 700 10.5px/1 var(--display);
  letter-spacing: .12em;
  text-transform: uppercase;
  color: var(--text-faint);
}

.card {
  position: relative;
  background: var(--bg-raised);
  border: 1px solid var(--line-soft);
  border-radius: var(--r-lg);
  padding: 14px;
}
.card + .card { margin-top: 9px; }

/* ------------------------------------------------------------ progress ring */

.hero {
  position: relative;
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 18px 16px;
  border-radius: var(--r-lg);
  border: 1px solid var(--line-soft);
  background:
    radial-gradient(90% 120% at 0% 0%, rgba(255,193,77,.10), transparent 60%),
    var(--bg-raised);
  overflow: hidden;
}
.ring { position: relative; flex: 0 0 auto; width: 96px; height: 96px; }
.ring svg { width: 100%; height: 100%; transform: rotate(-90deg); }
.ring .track { fill: none; stroke: rgba(255,255,255,.07); stroke-width: 9; }
/* Stroke colour is set as an attribute by the JS: each ring carries its own
   gradient, hence its own id. */
.ring .fill {
  fill: none; stroke-width: 9; stroke-linecap: round;
  transition: stroke-dashoffset .7s cubic-bezier(.22,1,.36,1);
}
.ring .center {
  position: absolute; inset: 0;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 1px;
}
.ring-value { font: 700 25px/1 var(--display); letter-spacing: -.01em; }
.ring-label { font: 500 9px/1 var(--body); letter-spacing: .1em; text-transform: uppercase; color: var(--text-faint); }

.hero-side { flex: 1 1 auto; min-width: 0; }
.hero-title { font: 700 17px/1.2 var(--display); letter-spacing: .01em; }
.hero-sub { margin-top: 4px; font-size: 12px; color: var(--text-dim); line-height: 1.45; }

/* ---------------------------------------------------------- milestones */

.milestones { display: flex; gap: 7px; flex-wrap: wrap; margin-top: 13px; }
.ms {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 5px 10px 5px 7px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: var(--bg-input);
  color: var(--text-faint);
  font: 600 10.5px/1 var(--display);
  letter-spacing: .05em;
  text-transform: uppercase;
  transition: color .2s, border-color .2s, background .2s;
}
.ms .dot { width: 13px; height: 13px; display: grid; place-items: center; font-size: 10px; }
.ms.on {
  color: var(--ink);
  border-color: transparent;
  background: var(--grad-mint);
}
.ms.on .dot { color: var(--ink); }
/* One flash on unlock — a milestone that keeps blinking becomes noise within
   thirty seconds. */
.ms.fresh { animation: pop .5s cubic-bezier(.34,1.56,.64,1); }
@keyframes pop {
  0% { transform: scale(.82); }
  60% { transform: scale(1.07); }
  100% { transform: scale(1); }
}

/* ---------------------------------------------------------------- metrics */

.kpis { display: grid; grid-template-columns: repeat(3, 1fr); gap: 9px; }
.kpi {
  position: relative;
  background: var(--bg-raised);
  border: 1px solid var(--line-soft);
  border-radius: var(--r-md);
  padding: 11px 12px;
  overflow: hidden;
}
.kpi::after {
  content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 3px;
  background: var(--line);
}
.kpi b { display: block; font: 700 22px/1.05 var(--display); }
.kpi span { display: block; margin-top: 4px; font-size: 10.5px; color: var(--text-faint); letter-spacing: .03em; }
.kpi.warn b { color: var(--amber); }
.kpi.warn::after { background: var(--amber); }
.kpi.good b { color: var(--mint); }
.kpi.good::after { background: var(--mint); }
.kpi.danger b { color: var(--rose); }
.kpi.danger::after { background: var(--rose); }

.row { display: flex; align-items: center; gap: 8px; }
.row + .row { margin-top: 8px; }
.spacer { flex: 1; }

/* -------------------------------------------------------------- buttons */

button.action {
  position: relative;
  padding: 9px 15px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: var(--bg-input);
  color: var(--text);
  font: 600 12px/1 var(--display);
  letter-spacing: .04em;
  cursor: pointer;
  transition: background .15s, border-color .15s, transform .1s, box-shadow .15s;
}
button.action:hover:not(:disabled) { background: #30303c; border-color: #3d3d4c; }
button.action:active:not(:disabled) { transform: scale(.98); }
button.action:disabled { opacity: .38; cursor: not-allowed; }
button.action.primary {
  background: var(--grad);
  border-color: transparent;
  color: #1a1206;
  font-weight: 700;
  box-shadow: 0 3px 14px rgba(255,150,77,.24);
}
button.action.primary:hover:not(:disabled) {
  box-shadow: 0 5px 20px rgba(255,150,77,.36);
  filter: brightness(1.06);
}
button.action.danger { background: transparent; border-color: rgba(255,107,129,.5); color: var(--rose); }
button.action.danger:hover:not(:disabled) { background: rgba(255,107,129,.12); border-color: var(--rose); }
button.action.wide { width: 100%; }

.progress { height: 5px; border-radius: 3px; background: rgba(255,255,255,.07); overflow: hidden; margin-top: 8px; }
.progress i {
  display: block; height: 100%; width: 0;
  background: var(--grad);
  border-radius: inherit;
  transition: width .3s cubic-bezier(.22,1,.36,1);
}

.log {
  margin-top: 9px;
  font: 400 11px/1.55 var(--mono);
  color: var(--text-faint);
  max-height: 130px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
.log .err { color: var(--rose); }
.log .ok { color: var(--mint); }

/* --------------------------------------------------------------- filters */

.filter { border-top: 1px solid var(--line-soft); padding: 11px 0; }
.filter:first-of-type { border-top: none; padding-top: 2px; }
/* Dimmed but legible: the criterion has to stay findable, and its reason
   readable, or the user just wonders why the box will not tick. */
.filter.disabled > label { opacity: .5; cursor: default; }
.filter.disabled .hint { color: var(--amber); opacity: .85; }
.filter.disabled button.action { margin-top: 7px; font-size: 11px; padding: 5px 9px; }
.filter > label { display: flex; align-items: center; gap: 9px; cursor: pointer; font-weight: 600; }
.filter > label input { accent-color: var(--amber); width: 15px; height: 15px; margin: 0; flex: 0 0 auto; }
.filter .icon { flex: 0 0 auto; font-size: 14px; line-height: 1; }
.filter .hint { margin: 5px 0 0 24px; font-size: 11px; color: var(--text-faint); line-height: 1.5; }
.filter .controls { margin: 9px 0 0 24px; }
.filter .controls[hidden] { display: none; }

.count {
  margin-left: auto;
  flex: 0 0 auto;
  padding: 3px 9px;
  border-radius: 999px;
  background: var(--bg-input);
  border: 1px solid var(--line);
  font: 700 11px/1.2 var(--display);
  color: var(--text-dim);
}

/* Inside a chip it is a suffix, not a badge: the pill-in-a-pill the standalone
   rule would give, plus its margin-left:auto, pushes the label off centre. */
.chip .count {
  margin: 0;
  padding: 0;
  border: 0;
  background: none;
  font-weight: 400;
  opacity: .65;
}
.chip[aria-pressed="true"] .count { opacity: .8; }
.filter > label input:checked ~ .count {
  background: rgba(255,193,77,.14);
  border-color: rgba(255,193,77,.4);
  color: var(--amber);
}
.count.stale { opacity: .4; font-style: italic; }

.slider { display: flex; align-items: center; gap: 8px; }
.slider label { flex: 0 0 auto; font-size: 11px; color: var(--text-faint); min-width: 92px; }
.slider input[type=range] { flex: 1; accent-color: var(--amber); min-width: 60px; }
.slider output { flex: 0 0 44px; text-align: right; font-size: 11.5px; font-weight: 700; color: var(--text-dim); }

button.reset {
  flex: 0 0 auto;
  width: 20px; height: 20px; padding: 0;
  border: none; border-radius: 6px;
  background: none; color: var(--text-faint);
  font-size: 12px; line-height: 1; cursor: pointer;
  transition: background .15s, color .15s;
}
button.reset:hover:not(:disabled) { background: var(--bg-input); color: var(--amber); }
button.reset:disabled { opacity: .2; cursor: default; }

select, input[type=date], input[type=number], input[type=text] {
  background: var(--bg-input);
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  color: var(--text);
  padding: 6px 8px;
  font: inherit;
  font-size: 12px;
}
select:focus-visible, input:focus-visible, button:focus-visible {
  outline: 2px solid var(--amber);
  outline-offset: 2px;
}

/* ----------------------------------------------------------------- grid */

.grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin-top: 11px; }
.thumb {
  position: relative;
  aspect-ratio: 1;
  border-radius: var(--r-sm);
  overflow: hidden;
  background: var(--bg-input);
  cursor: pointer;
  border: 2px solid transparent;
  transition: border-color .15s, transform .12s;
}
.thumb:hover { transform: scale(1.03); z-index: 1; }
.thumb img { width: 100%; height: 100%; object-fit: cover; display: block; transition: opacity .2s; }
.thumb.on { border-color: var(--amber); }

/* What Shift-clicking would take. Dashed and inset so it reads as a promise
   rather than a state — it must never be mistaken for an actual tick. */
.thumb.ranged::after {
  content: "";
  position: absolute;
  inset: 2px;
  border: 2px dashed var(--amber);
  border-radius: 6px;
  pointer-events: none;
  animation: rangepulse 1.1s ease-in-out infinite;
}
@keyframes rangepulse { 50% { opacity: .45; } }
.thumb.on img { opacity: .74; }
.thumb .mark {
  position: absolute; top: 4px; left: 4px;
  width: 17px; height: 17px; border-radius: 50%;
  background: rgba(0,0,0,.55); border: 1.5px solid rgba(255,255,255,.85);
  display: flex; align-items: center; justify-content: center;
  font-size: 10px; color: #fff; line-height: 1;
  transition: background .15s, border-color .15s;
}
.thumb.on .mark { background: var(--amber); border-color: var(--amber); color: var(--ink); font-weight: 700; }
/* Everything written over the bottom of a tile shares one bar and one
   gradient. Two absolutely-positioned overlays both anchored to bottom:0 sat
   on top of each other, and whichever came second won. */
.thumb .overlay {
  position: absolute; left: 0; right: 0; bottom: 0;
  display: flex; flex-direction: column; gap: 2px;
  padding: 16px 4px 4px;
  background: linear-gradient(transparent, rgba(0,0,0,.85));
  font: 500 9px/1.3 var(--body); color: #fff;
  /* The bar is a label, not a target: clicks belong to the tile under it. */
  pointer-events: none;
}
.thumb .tags { display: flex; flex-wrap: wrap; gap: 2px; }
.thumb .tags span { background: rgba(255,255,255,.18); border-radius: 3px; padding: 1px 4px; }
.thumb .facts {
  display: flex; gap: 6px; align-items: baseline;
  font-size: 9.5px; text-shadow: 0 1px 2px rgba(0,0,0,.9);
}
.thumb .facts b { font-weight: 700; }
.thumb .facts span { opacity: .85; }
.thumb .facts .score {
  margin-left: auto;
  padding: 0 4px; border-radius: 4px;
  background: rgba(255,255,255,.2);
  font: 600 9px/1.5 var(--mono);
  font-variant-numeric: tabular-nums;
  opacity: 1;
}
/* Videos are marked by their duration in the bar and by the play glyph on the
   view button, so the corner badge would be a third statement of the same
   thing — in the corner the bar now occupies. */
.thumb.video::after {
  content: ""; display: none; position: absolute; right: 5px; bottom: 5px;
  font-size: 9px; color: #fff; text-shadow: 0 1px 4px #000;
}

/* ----------------------------------------------------------------- modal */

.modal {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  display: flex;
  flex-direction: column;
  background: var(--ink);
}
.modal[hidden] { display: none; }

.modal > header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 15px 22px;
  border-bottom: 1px solid var(--line-soft);
  background: var(--bg);
  flex: 0 0 auto;
}
.modal > header h2 {
  margin: 0;
  font: 700 16px/1.15 var(--display);
  letter-spacing: .05em;
  text-transform: uppercase;
}
.modal > header .count {
  margin-left: 0;
  background: none; border: none; padding: 0;
  color: var(--text-dim); font-size: 12.5px; font-weight: 500;
}

.modal .layout { flex: 1 1 auto; display: flex; min-height: 0; }
.modal .side {
  flex: 0 0 300px;
  overflow-y: auto;
  border-right: 1px solid var(--line-soft);
  padding: 14px 16px 28px;
  background: var(--bg);
}
.modal .side h3 {
  margin: 0 0 9px;
  font: 700 10.5px/1 var(--display);
  letter-spacing: .12em;
  text-transform: uppercase;
  color: var(--text-faint);
}
.modal .main { flex: 1 1 auto; overflow-y: auto; padding: 18px 22px 30px; min-width: 0; }
.modal .side::-webkit-scrollbar, .modal .main::-webkit-scrollbar { width: 10px; }
.modal .side::-webkit-scrollbar-thumb { background: #353544; border-radius: 5px; border: 3px solid var(--bg); }
.modal .main::-webkit-scrollbar-thumb { background: #353544; border-radius: 5px; border: 3px solid var(--ink); }

/* Space is tight in the sidebar: a label on the same line left the slider only
   a hundred pixels, too few to aim at a threshold. So the label gets its own
   row. */
.modal .side .controls { margin-left: 8px; }
.modal .side .hint { margin-left: 24px; }
.modal .side .slider { flex-wrap: wrap; gap: 3px 8px; }
.modal .side .slider + .slider { margin-top: 8px; }
.modal .side .slider label { flex: 1 0 100%; min-width: 0; }
.modal .side .slider select,
.modal .side .slider input[type=date] { flex: 1 1 auto; min-width: 0; }

@media (max-width: 780px) {
  .modal .layout { flex-direction: column; }
  .modal .side { flex: 0 0 auto; max-height: 42vh; border-right: none; border-bottom: 1px solid var(--line-soft); }
  .badge.panel-open { display: none; }
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: var(--bg-input);
  color: var(--text-dim);
  font: 600 11px/1 var(--display);
  letter-spacing: .04em;
  cursor: pointer;
  white-space: nowrap;
  transition: background .15s, border-color .15s, color .15s;
}
.chip:hover:not(:disabled) { color: var(--text); border-color: #3d3d4c; }
.chip:disabled { opacity: .4; cursor: default; }
.chip[aria-pressed="true"] {
  background: rgba(255,193,77,.15);
  border-color: rgba(255,193,77,.45);
  color: var(--amber);
}
.chip b { font-variant-numeric: tabular-nums; opacity: .8; }

.modal .grid {
  grid-template-columns: repeat(auto-fill, minmax(148px, 1fr));
  gap: 9px;
  margin-top: 0;
}
.modal .thumb { border-radius: var(--r-md); }
.modal .thumb .mark { width: 21px; height: 21px; font-size: 12px; top: 6px; left: 6px; }
.modal .thumb .tags { font-size: 10px; padding: 16px 5px 5px; }

.modal > footer {
  flex: 0 0 auto;
  border-top: 1px solid var(--line-soft);
  background: var(--bg);
  padding: 13px 22px;
  display: flex;
  align-items: center;
  gap: 12px;
}
.modal > footer .summary { flex: 1; font-size: 12.5px; }
.modal > footer .summary b { color: var(--amber); }

/* ------------------------------------------------------------ histograms */

.chart { display: flex; flex-direction: column; gap: 4px; }
.bar { display: grid; grid-template-columns: 62px 1fr 46px; align-items: center; gap: 9px; font-size: 11px; }
.bar span:first-child { color: var(--text-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bar i {
  display: block; height: 11px; border-radius: 3px;
  background: var(--grad);
  min-width: 3px;
  transform-origin: left;
  animation: grow .5s cubic-bezier(.22,1,.36,1) backwards;
}
@keyframes grow { from { transform: scaleX(0); } to { transform: scaleX(1); } }
.bar b { text-align: right; font-weight: 700; color: var(--text-dim); }

/* ----------------------------------------------------------------- footer */

footer {
  position: relative;
  flex: 0 0 auto;
  border-top: 1px solid var(--line-soft);
  padding: 13px 16px;
  background: var(--bg-raised);
}
footer .summary { font-size: 12.5px; margin-bottom: 10px; }
footer .summary b { color: var(--amber); font-family: var(--display); font-size: 15px; }
footer .buttons { display: flex; gap: 8px; }
footer .buttons button { flex: 1; }

.banner {
  border-radius: var(--r-md);
  padding: 10px 12px;
  font-size: 11.5px;
  line-height: 1.55;
  margin-bottom: 11px;
  border-left: 3px solid;
}
.banner.info { background: rgba(107,199,255,.09); border-color: var(--sky); }
.banner.warn { background: rgba(255,193,77,.09); border-color: var(--amber); color: #f7d78f; }
.banner.danger { background: rgba(255,107,129,.1); border-color: var(--rose); color: #ffb3bd; }
.banner b { font-weight: 700; }

.switch { display: flex; align-items: center; gap: 9px; cursor: pointer; }
.switch input { accent-color: var(--amber); width: 15px; height: 15px; margin: 0; flex: 0 0 auto; }
.switch small { color: var(--text-faint); }

.muted { color: var(--text-faint); font-size: 11.5px; line-height: 1.55; }
.tiny { font-size: 10.5px; margin-top: 5px; }

/* ------------------------------------------------------------ sort bar */

.sorts { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.sorts button {
  padding: 6px 11px;
  font: 600 11px/1 var(--display);
  letter-spacing: .04em;
  text-transform: uppercase;
  color: var(--text-dim);
  background: var(--bg-input);
  border: 1px solid var(--line-soft);
  border-radius: 999px;
  cursor: pointer;
  transition: color .15s, border-color .15s, background .15s;
}
.sorts button:hover:not(:disabled) { color: var(--text); border-color: var(--line); }
.sorts button.on {
  color: var(--ink);
  background: var(--grad);
  border-color: transparent;
}
.sorts button:disabled { opacity: .35; cursor: not-allowed; }

/* In the wide view the bar sits above the grid and stays put while it scrolls:
   the order is a claim about what the top of the grid means, so it should not
   scroll away from the thing it describes. */
.sortbar {
  position: sticky;
  top: 0;
  z-index: 2;
  padding: 2px 0 10px;
  margin-bottom: 4px;
  background: linear-gradient(var(--bg) 72%, transparent);
}
.sortbar .sorts { margin-bottom: 4px; }

/* --------------------------------------------------- one block per person */

.group-block { margin: 0 0 18px; }
.group-block > header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 0 6px;
  border-bottom: 1px solid var(--line);
  /* Sticky under the order bar, so the person a run of photos belongs to
     stays readable while scrolling through them. */
  position: sticky;
  top: 46px;
  z-index: 1;
  background: var(--bg);
}
.group-block > header h3 {
  margin: 0;
  font: 600 12.5px/1.3 inherit;
  letter-spacing: .01em;
}
.group-block > header .spacer { flex: 1; }
.group-block > header .action { padding: 3px 9px; font-size: 11px; }
.group-block .grid { margin-top: 8px; }

/* ------------------------------------------------------- the view button */

/* Top-RIGHT. It started on top-left, exactly where the tick mark is: a 22px
   button covering the 17px control the whole grid is built around, so a click
   meant for the checkbox opened the picture instead. Opacity 0 still takes
   clicks, so it was swallowing them even before the tile was hovered. */
.thumb .zoom {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 5px;
  background: rgba(0,0,0,.55);
  color: #fff;
  font-size: 11px;
  line-height: 22px;
  cursor: pointer;
  transition: opacity .12s, background .12s;
  /* Hidden until wanted, and unclickable while hidden: opacity alone still
     takes clicks, which is how it swallowed the tick's. One rule, so the two
     properties cannot drift apart. */
  opacity: 0;
  pointer-events: none;
}
.thumb:hover .zoom, .thumb .zoom:focus-visible { opacity: 1; pointer-events: auto; }
.thumb .zoom:hover { background: rgba(0,0,0,.85); }

/* --------------------------------------------------------- the full view */

.viewer { position: fixed; inset: 0; z-index: var(--z-viewer); }
.viewer .backdrop { position: absolute; inset: 0; background: rgba(0,0,0,.82); }
.viewer .sheet {
  position: absolute;
  inset: 3vh 3vw;
  z-index: 1;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px 14px;
  border-radius: var(--r-md);
  border: 1px solid var(--line);
  background: var(--bg);
  box-shadow: 0 20px 70px rgba(0,0,0,.6);
}
.viewer header { display: flex; align-items: center; gap: 10px; }
.viewer:focus { outline: none; }
.viewer .step {
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--bg-raised);
  color: var(--text);
  font: 400 17px/1 var(--body);
  cursor: pointer;
  transition: background .15s, border-color .15s;
}
.viewer .step:hover:not(:disabled) { background: var(--bg-input); border-color: var(--text-faint); }
.viewer .step:disabled { opacity: .3; cursor: default; }
.viewer header .spacer { flex: 1; }
.viewer .stage {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #000;
  border-radius: var(--r-sm);
  overflow: hidden;
}
.viewer .stage {
  position: relative;
  /* The picture is moved with a transform, which paints outside its box:
     without this a zoomed photo spills over the header and the footer. */
  overflow: hidden;
  touch-action: none;
}
.viewer .stage img, .viewer .stage video {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  display: block;
  transform-origin: center;
  /* No transition: the transform follows a wheel and a pointer, and easing an
     interaction that is already continuous only makes it lag behind. */
  will-change: transform;
}
.viewer .stage.zoomed { cursor: grab; }
.viewer .stage.zoomed:active { cursor: grabbing; }

/* Only while zoomed, so the reading of a fitted photo is never covered. */
.viewer .zoom-level {
  position: absolute;
  right: 10px;
  bottom: 10px;
  padding: 2px 7px;
  border-radius: 999px;
  background: rgba(0,0,0,.62);
  color: #fff;
  font: 600 11px/1.5 var(--mono);
  font-variant-numeric: tabular-nums;
  pointer-events: none;
}
.viewer .zoom-level:empty { display: none; }
.viewer footer { display: flex; gap: 10px; align-items: center; }
.viewer footer .spacer { flex: 1; }

/* The faces found in the photo on screen, each one protectable. */
.faces-strip {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  min-height: 34px;
}
.faces-strip .face {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px 3px 3px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--bg-raised);
}
.faces-strip .face.guarded { border-color: var(--mint); }
/* The crop is a window onto the rendition already fetched for the stage: the
   box is normalised, so scaling and offsetting the same image puts the face in
   the frame with no second decode and no second request. */
.faces-strip .crop {
  position: relative;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  overflow: hidden;
  flex: none;
  background: var(--bg-input);
}
/* Every crop, not just the strip's: the Protected tab was left with a static,
   width-constrained image and framed nothing at all.
   object-fit must stay fill — anything that re-crops undoes the offsets. */
.crop img {
  position: absolute;
  max-width: none;
  max-height: none;
  object-fit: fill;
}
.faces-strip .face .action { padding: 2px 9px; font-size: 10.5px; }

/* ------------------------------------------------------- protected people */

.guard-list { display: flex; flex-direction: column; gap: 8px; }
.guard {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 9px 11px;
  border: 1px solid var(--line-soft);
  border-radius: var(--r-lg);
  background: var(--bg-raised);
}
.guard .crop {
  width: 46px;
  height: 46px;
  border-radius: 50%;
  border: 2px solid var(--mint);
}
.guard-side { flex: 1; min-width: 0; }
.guard-side input {
  width: 100%;
  padding: 4px 7px;
  border: 1px solid transparent;
  border-radius: var(--r-sm);
  background: none;
  color: var(--text);
  font: 600 12.5px/1.2 var(--body);
}
.guard-side input:hover { border-color: var(--line); }
.guard-side input:focus { border-color: var(--amber); background: var(--bg-input); outline: none; }
.guard-side .tiny { margin-top: 2px; padding-left: 7px; }
.guard .action { flex: none; }
.viewer footer .action { text-decoration: none; }

/* ------------------------------------------------- the explanation mark */

/* The hint used to sit under every criterion. Thirteen of them filled the
   column four at a time; it is worth reading once, not on every visit. */
/* What the selection weighs, beside its count. Amber because it is the number
   the whole exercise is about. */
.summary .weight { color: var(--amber); font-weight: 700; }

.why {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 13px;
  height: 13px;
  margin-left: 5px;
  border-radius: 50%;
  border: 1px solid var(--line);
  color: var(--text-faint);
  font-size: 9px;
  font-weight: 700;
  cursor: help;
  flex: none;
}
.why:hover { color: var(--text); border-color: var(--text-dim); }

/* ------------------------------------------------------------- people tab */

.card-title {
  font: 700 13px/1.2 var(--display);
  letter-spacing: .02em;
  margin-bottom: 8px;
}

.field { display: block; margin-bottom: 8px; }
.field span {
  display: block;
  font-size: 10.5px;
  letter-spacing: .04em;
  text-transform: uppercase;
  color: var(--text-faint);
  margin-bottom: 4px;
}
.field input {
  width: 100%;
  box-sizing: border-box;
  font: 11.5px/1.4 var(--mono);
  color: var(--text);
  background: var(--bg-input);
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  padding: 6px 8px;
}
.field input:focus { outline: none; border-color: var(--amber); }

.people {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(122px, 1fr));
  gap: 9px;
  margin: 10px 0;
}

.person {
  position: relative;
  background: var(--bg-input);
  border: 1px solid var(--line-soft);
  border-radius: var(--r-md);
  padding: 7px;
  transition: border-color .15s, transform .15s;
}
.person.on { border-color: var(--amber); transform: translateY(-1px); }

/* Three covers rather than one: a single thumbnail cannot show whether a
   group has quietly merged two people, which is the mistake that matters. */
.person .faces { display: flex; gap: 3px; cursor: pointer; }
.person .faces img {
  flex: 1 1 0;
  min-width: 0;
  aspect-ratio: 1;
  object-fit: cover;
  border-radius: var(--r-sm);
  background: var(--bg);
}
.person .faces .muted { padding: 12px 0; text-align: center; width: 100%; }

.person .name {
  width: 100%;
  box-sizing: border-box;
  margin-top: 6px;
  font: 600 12px/1.3 var(--body);
  color: var(--text);
  background: transparent;
  border: none;
  border-bottom: 1px dashed var(--line);
  padding: 2px 0;
}
.person .name:focus { outline: none; border-bottom-color: var(--amber); }
.person .name::placeholder { color: var(--text-faint); font-weight: 400; }

.person .meta {
  display: flex;
  justify-content: space-between;
  gap: 6px;
  margin-top: 4px;
  font-size: 10px;
  color: var(--text-faint);
}
.person .meta .warn { color: var(--amber); font-weight: 700; }

.person .mark {
  position: absolute;
  top: 10px; right: 10px;
  width: 17px; height: 17px;
  display: grid; place-items: center;
  font-size: 10px; font-weight: 700;
  color: var(--ink);
  background: var(--amber);
  border-radius: 50%;
  opacity: 0;
  transition: opacity .15s;
}
.person.on .mark { opacity: 1; }

code {
  font: 11px/1.5 var(--mono);
  background: var(--bg-input);
  border: 1px solid var(--line-soft);
  padding: 1px 5px;
  border-radius: 5px;
  word-break: break-all;
}
`;
