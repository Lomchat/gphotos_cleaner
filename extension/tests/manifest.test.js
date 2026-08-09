/**
 * Locks the contract between the manifest and the import chain.
 *
 * The content script loads the panel by dynamic import. Every module reached
 * that way must appear in `web_accessible_resources`, or Chrome refuses the
 * import — and the failure is COMPLETELY silent for the user: the extension
 * loads, the icon responds, nothing appears. That is the exact bug this file
 * exists to prevent.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));

const posix = (p) => p.split('\\').join('/');
const abs = (rel) => join(ROOT, rel);

/** Convert a `web_accessible_resources` pattern into a regular expression. */
function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`);
}

const accessible = (manifest.web_accessible_resources || [])
  .flatMap((entry) => entry.resources || [])
  .map(globToRegExp);

const isAccessible = (rel) => accessible.some((re) => re.test(posix(rel)));

/** Extract a file's static import specifiers. */
function importsOf(rel) {
  const source = readFileSync(abs(rel), 'utf8');
  const specs = [];
  const re = /^\s*import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/gm;
  let m;
  while ((m = re.exec(source))) specs.push(m[1]);
  return specs;
}

/** Walk the import graph transitively from an entry point. */
function moduleGraph(entry) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const current = stack.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    for (const spec of importsOf(current)) {
      if (!spec.startsWith('.')) continue; // no external packages expected
      const resolved = posix(normalize(join(dirname(current), spec)));
      stack.push(resolved);
    }
  }
  return seen;
}

/* -------------------------------------------------------------- structure */

test('the manifest declares the files it references', () => {
  const referenced = [
    manifest.background.service_worker,
    ...manifest.content_scripts.flatMap((cs) => cs.js),
    ...Object.values(manifest.icons || {})
  ];
  for (const file of referenced) {
    assert.ok(existsSync(abs(file)), `${file} is declared in the manifest but missing from disk`);
  }
});

test('the offscreen document and its worker exist', () => {
  const swSource = readFileSync(abs(manifest.background.service_worker), 'utf8');
  const m = /['"]([^'"]*offscreen\.html)['"]/.exec(swSource);
  assert.ok(m, 'the service worker must reference an offscreen document');
  assert.ok(existsSync(abs(m[1])), `${m[1]} not found`);

  const offscreenDir = dirname(m[1]);
  const html = readFileSync(abs(m[1]), 'utf8');
  const script = /src=["']([^"']+)["']/.exec(html);
  assert.ok(script, 'the offscreen document must load a script');
  assert.ok(existsSync(abs(join(offscreenDir, script[1]))), 'offscreen script not found');
});

/* ------------------------------------------------------ panel import chain */

test('the content script loads the panel through an extension URL', () => {
  const source = readFileSync(abs(manifest.content_scripts[0].js[0]), 'utf8');
  const m = /getURL\(\s*['"]([^'"]+)['"]\s*\)/.exec(source);
  assert.ok(m, 'the content script must import the panel via chrome.runtime.getURL');
  assert.ok(existsSync(abs(m[1])), `${m[1]} not found`);
});

test('EVERY module reachable from the content script is web-accessible', () => {
  const source = readFileSync(abs(manifest.content_scripts[0].js[0]), 'utf8');
  const entry = /getURL\(\s*['"]([^'"]+)['"]\s*\)/.exec(source)[1];

  const graph = moduleGraph(entry);
  assert.ok(graph.size > 5, `suspiciously small graph (${graph.size} modules)`);

  const missing = [...graph].filter((rel) => !isAccessible(rel));
  assert.deepEqual(
    missing,
    [],
    `these modules are imported by the panel but missing from ` +
      `web_accessible_resources; the import will fail and the extension will stay ` +
      `invisible: ${missing.join(', ')}`
  );
});

test('every module in the graph really exists on disk', () => {
  const source = readFileSync(abs(manifest.content_scripts[0].js[0]), 'utf8');
  const entry = /getURL\(\s*['"]([^'"]+)['"]\s*\)/.exec(source)[1];
  for (const rel of moduleGraph(entry)) {
    assert.ok(existsSync(abs(rel)), `broken import: ${rel}`);
  }
});

test('web_accessible_resources exposes nothing unnecessary', () => {
  // Exposing a file makes it readable by any matching page, so check that each
  // declared pattern actually serves a purpose.
  const source = readFileSync(abs(manifest.content_scripts[0].js[0]), 'utf8');
  const entry = /getURL\(\s*['"]([^'"]+)['"]\s*\)/.exec(source)[1];
  const graph = [...moduleGraph(entry)];

  for (const entryBlock of manifest.web_accessible_resources) {
    for (const glob of entryBlock.resources) {
      const re = globToRegExp(glob);
      assert.ok(
        graph.some((rel) => re.test(posix(rel))),
        `pattern "${glob}" is required by no panel module`
      );
    }
    assert.deepEqual(
      entryBlock.matches,
      ['https://photos.google.com/*'],
      'resources must only be exposed to Google Photos'
    );
  }
});

/* ----------------------------------------------------------- permissions */

test('permissions stay minimal and justified', () => {
  assert.deepEqual(new Set(manifest.permissions), new Set(['storage', 'offscreen']));

  // Google moves image serving between several domains, so the list must cover
  // them while staying restricted to image hosts and Google Photos. No pattern
  // may open a whole domain.
  const hosts = manifest.host_permissions;
  assert.ok(hosts.includes('https://photos.google.com/*'), 'Google Photos access is required');
  for (const p of hosts) {
    assert.match(p, /^https:\/\//, `${p} must be HTTPS`);
    assert.ok(
      /(googleusercontent\.com|usercontent\.google\.com|ggpht\.com|^https:\/\/lh\d+\.google\.com|^https:\/\/photos\.google\.com)/.test(p),
      `${p} is neither Google Photos nor a Google image host`
    );
    assert.ok(!/^https:\/\/\*\.google\.com/.test(p), `${p} would open all of google.com`);
    assert.ok(!/^https:\/\/\*\/\*$/.test(p), `${p} is a global wildcard`);
  }
  // An action popup would stop `chrome.action.onClicked` from firing, and
  // clicking the icon would no longer open the panel.
  assert.equal(manifest.action?.default_popup, undefined);
});

test('the content script targets Google Photos and runs at the right time', () => {
  const cs = manifest.content_scripts[0];
  assert.deepEqual(cs.matches, ['https://photos.google.com/*']);
  assert.equal(cs.run_at, 'document_idle');
  assert.equal(cs.all_frames, false, 'the panel must exist only once');
});

test('the service worker is an ES module', () => {
  // The file uses `import` syntax: without "type": "module" it would not load
  // and analysis would be unreachable.
  assert.equal(manifest.background.type, 'module');
});
