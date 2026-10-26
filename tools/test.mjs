#!/usr/bin/env node
// tools/test.mjs — no-dependency checks for the preview release.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n     ${e.message}`); process.exitCode = 1; }
}

const VERSION = read('VERSION').trim();
const html = read('web/index.html');
const pkg = JSON.parse(read('package.json'));

t('VERSION is semver', () => assert.match(VERSION, /^\d+\.\d+\.\d+$/));
t('package.json version matches VERSION', () => assert.equal(pkg.version, VERSION));
t('preview page shows the version', () => assert.ok(html.includes(`v${VERSION}`)));
t('no unreplaced name placeholders', () => {
  for (const f of ['web/index.html', 'install.sh', 'README.md', 'docs/adr/0001-personalised-discovery.md', 'docs/roadmap.md']) {
    assert.ok(!/__(NAME|SLUG|REPO|TAGLINE)__/.test(read(f)), `${f} still has a placeholder`);
  }
});
t('strict CSP: default-src none, no script', () => {
  const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)?.[1] || '';
  assert.ok(csp.includes("default-src 'none'"));
  assert.ok(!/script-src/.test(csp));
  assert.ok(!/<script/i.test(html), 'preview must not ship scripts');
});
t('zero third-party requests (no external src/href/url())', () => {
  const refs = [...html.matchAll(/(?:src|href)\s*=\s*"([^"]+)"|url\(([^)]+)\)/g)].map((m) => m[1] || m[2]);
  for (const r of refs) assert.ok(!/^(https?:)?\/\//i.test(r.trim()), `external reference: ${r}`);
  assert.ok(!/fonts\.(googleapis|gstatic)/.test(html));
});
t('payload stays small (< 16 KB)', () => assert.ok(Buffer.byteLength(html) < 16 * 1024));
t('installer is fragment-first and rolls back on nginx -t failure', () => {
  const sh = read('install.sh');
  const frag = sh.indexOf('cat > "${FRAGMENT_FILE}.new"'), reg = sh.indexOf('register "$APP"');
  assert.ok(frag > 0 && reg > frag, 'fragment must be written before register');
  assert.ok(/nginx -t/.test(sh) && /rolled back/.test(sh));
  assert.ok(sh.startsWith('#!/usr/bin/env bash') && /set -euo pipefail/.test(sh));
});
t('event model adds no new kinds', () => {
  const em = read('docs/event-model.md');
  const kinds = new Set([...em.matchAll(/"kind":\s*(\d+)/g)].map((m) => Number(m[1])));
  for (const k of kinds) assert.ok([0, 1984, 10000, 10040, 30004, 30078, 30382, 30383, 30384, 30385].includes(k), `unexpected kind ${k}`);
});

console.log(`\n${passed} passed`);
