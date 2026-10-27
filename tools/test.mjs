#!/usr/bin/env node
// tools/test.mjs — no-dependency checks for the web app, headers, installer and
// docs. The service has its own node:test suite in service/test (npm test runs both).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { SHELL_CSP, NAPPLET_CSP, HEADERS } from './headers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const gz = (f) => zlib.gzipSync(fs.readFileSync(path.join(ROOT, f)), { level: 9 }).length;
let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n     ${e.message}`); process.exitCode = 1; }
}

const VERSION = read('VERSION').trim();
const html = read('web/index.html'), napHtml = read('web/napplet.html');
const pkg = JSON.parse(read('package.json')), svcPkg = JSON.parse(read('service/package.json'));
const lock = JSON.parse(read('service/package-lock.json'));
const sh = read('install.sh');
const WEB_JS = ['web/shell.js', 'web/napplet.js', 'web/rank.js'];
const WEB_ALL = [...WEB_JS, 'web/index.html', 'web/napplet.html', 'web/shell.css', 'web/napplet.css', 'web/hibiki.css'];
const metaCsp = (s) => s.match(/Content-Security-Policy" content="([^"]+)"/)?.[1] || '';
// <meta> CSP cannot carry frame-ancestors or sandbox; the header adds them.
const headerOnly = (csp) => csp.split('; ').filter((d) => !/^(frame-ancestors|sandbox)/.test(d)).join('; ');

t('VERSION is semver', () => assert.match(VERSION, /^\d+\.\d+\.\d+$/));
t('every version marker matches VERSION', () => {
  assert.equal(pkg.version, VERSION, 'package.json');
  assert.equal(svcPkg.version, VERSION, 'service/package.json');
  assert.equal(lock.version, VERSION, 'service/package-lock.json');
  assert.ok(html.includes(`v${VERSION}`), 'web/index.html footer');
  assert.ok(read('README.md').includes(`v${VERSION}`), 'README');
});
t('Node engine floor is 22.13 (built-in sqlite and WebSocket)', () => {
  assert.match(pkg.engines.node, /22\.13/); assert.match(svcPkg.engines.node, /22\.13/);
  assert.match(sh, /a<22\|\|\(a===22&&b<13\)/);
});
t('service dependencies are pinned exactly and locked', () => {
  for (const [n, v] of Object.entries(svcPkg.dependencies)) {
    assert.match(v, /^\d+\.\d+\.\d+$/, `${n} must be pinned`);
    assert.equal(lock.packages[`node_modules/${n}`]?.version, v, `${n} lock mismatch`);
  }
  assert.ok(!svcPkg.dependencies.ws, 'Node 22 has a global WebSocket');
});
t('shell CSP: same-origin only, no inline, header adds frame-ancestors', () => {
  assert.equal(metaCsp(html), headerOnly(SHELL_CSP));
  for (const c of [SHELL_CSP, NAPPLET_CSP]) {
    assert.ok(c.startsWith("default-src 'none'"));
    assert.ok(!/unsafe-|https?:|\*|blob:/.test(c), 'no unsafe-*, hosts, wildcards or blob:');
  }
  assert.match(SHELL_CSP, /frame-ancestors 'self'/);
});
t('napplet CSP: no network at all, opaque-origin sandbox', () => {
  assert.equal(metaCsp(napHtml), headerOnly(NAPPLET_CSP));
  assert.match(NAPPLET_CSP, /connect-src 'none'/);
  assert.match(NAPPLET_CSP, /sandbox allow-scripts$/);
  const frame = html.match(/<iframe[^>]+>/)[0];
  assert.match(frame, /sandbox="allow-scripts"/);
  assert.ok(!/allow-same-origin/.test(frame), 'napplet must stay opaque-origin');
  assert.match(frame, /referrerpolicy="no-referrer"/);
});
t('installer writes exactly the CSP and headers from tools/headers.mjs', () => {
  assert.ok(sh.includes(`SHELL_CSP="${SHELL_CSP}"`), 'shell CSP drift');
  assert.ok(sh.includes(`NAPPLET_CSP="${NAPPLET_CSP}"`), 'napplet CSP drift');
  for (const [k, v] of Object.entries({ ...HEADERS.common, ...HEADERS.shell, ...HEADERS.fonts })) {
    const name = k.replace(/(^|-)([a-z])/g, (_, d, c) => d + c.toUpperCase()).replace('Csp', 'CSP');
    if (k === 'content-security-policy') continue;
    assert.ok(sh.toLowerCase().includes(`add_header ${k} "${v}"`.toLowerCase()), `${name}: ${v}`);
  }
});
t('no HTML injection sinks or dynamic code in browser code', () => {
  for (const f of WEB_JS) assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|setAttribute\(\s*['"]on/.test(read(f)), f);
});
t('napplet never touches the network or storage directly', () => {
  const js = read('web/napplet.js');
  assert.ok(!/\bfetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|indexedDB|localStorage|document\.cookie/.test(js));
  assert.match(js, /postMessage/);
});
t('napplet only renders same-origin node paths as media sources', () => {
  const js = read('web/napplet.js');
  assert.ok(js.includes("var PROXY = /^\\/hibiki\\/(img|media)\\/[\\w-]{22}\\//;"), 'PROXY guard');
  assert.match(js, /k === 'src' \|\| k === 'poster'\) \{ if \(PROXY\.test\(v\)\)/, 'h() drops any other src');
  assert.ok(!/\bhref\b/.test(js), 'no anchors: links open through the shell');
});
t('shell accepts messages only from its napplet and sends the CSRF header', () => {
  const js = read('web/shell.js');
  assert.match(js, /e\.source\s*!==\s*[\w.]+contentWindow/);
  assert.match(js, /'x-hibiki'/);
});
t('zero third-party requests from web files', () => {
  for (const f of WEB_ALL) {
    const s = read(f);
    const refs = [...s.matchAll(/(?:src|href)\s*=\s*"([^"]+)"|url\(([^)]+)\)|@import\s+['"]([^'"]+)/g)].map((m) => m[1] || m[2] || m[3]);
    for (const r of refs) {
      if (f === 'web/index.html' && r === 'https://github.com/ChiefmonkeyArt/torii-hibiki') continue; // source link, a plain anchor
      assert.ok(!/^(https?:)?\/\//i.test(r.trim()), `${f}: external reference ${r}`);
    }
    assert.ok(!/fonts\.(googleapis|gstatic)/.test(s), f);
  }
});
t('fonts are bundled with their OFL licence', () => {
  for (const f of ['noto-sans-regular.woff2', 'noto-sans-bold.woff2', 'noto-serif-jp-mark.woff2', 'OFL.txt']) assert.ok(fs.existsSync(path.join(ROOT, 'web/fonts', f)), f);
  assert.match(read('web/fonts/OFL.txt'), /SIL OPEN FONT LICENSE/i);
});
t('size budgets (gzip): shell <= 8 KB, napplet <= 32 KB, fonts <= 64 KB', () => {
  const shell = ['web/index.html', 'web/shell.js', 'web/shell.css'].reduce((a, f) => a + gz(f), 0);
  const nap = ['web/napplet.html', 'web/napplet.js', 'web/rank.js', 'web/napplet.css', 'web/hibiki.css'].reduce((a, f) => a + gz(f), 0);
  const fonts = fs.readdirSync(path.join(ROOT, 'web/fonts')).filter((f) => f.endsWith('.woff2')).reduce((a, f) => a + fs.statSync(path.join(ROOT, 'web/fonts', f)).size, 0);
  console.log(`     shell ${shell} B, napplet ${nap} B, fonts ${fonts} B`);
  assert.ok(shell <= 8 * 1024, `shell ${shell}`); assert.ok(nap <= 32 * 1024, `napplet ${nap}`); assert.ok(fonts <= 64 * 1024, `fonts ${fonts}`);
});
t('installer: preflight, fragment-first, nginx -t and health-check rollback', () => {
  assert.ok(sh.startsWith('#!/usr/bin/env bash') && /set -euo pipefail/.test(sh));
  const frag = sh.indexOf('cat > "${FRAGMENT_FILE}.new"'), test = sh.indexOf('if ! nginx -t'), flip = sh.lastIndexOf('mv -Tf "${CURRENT_LINK}.new" "$CURRENT_LINK"\nsystemctl'), reg = sh.indexOf('register "$APP"');
  assert.ok(frag > 0 && test > frag && flip > test && reg > flip, 'fragment, nginx -t, flip, then register');
  assert.match(sh, /rollback "\$\{UNIT\} did not report v\$\{VERSION\}"/);
  assert.match(sh, /NPM" ci --omit=dev --ignore-scripts/);
  assert.match(sh, /KEEP_RELEASES=5/);
});
t('installer: image backend falls back from sharp to libvips on CPUs without x86-64-v2', () => {
  const probe = sh.indexOf("import('sharp')"), apt = sh.indexOf('apt-get install -y -qq --no-install-recommends libvips-tools'), flip = sh.indexOf('if ! nginx -t');
  assert.ok(probe > 0 && apt > probe && flip > apt, 'probe sharp, then install libvips-tools, before going live');
  assert.match(sh, /IMG="copy"/);
});
t('installer: service is unprivileged, loopback-only, memory-capped, keeps its secret', () => {
  for (const d of ['User=${SVC_USER}', 'NoNewPrivileges=yes', 'ProtectSystem=strict', 'ProtectHome=yes', 'PrivateTmp=yes', 'MemoryMax=', 'CapabilityBoundingSet=', 'ReadWritePaths=${DATA_DIR}', 'RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX'])
    assert.ok(sh.includes(d), d);
  assert.match(sh, /proxy_pass http:\/\/127\.0\.0\.1:\$\{PORT\}/);
  assert.match(sh, /SECRET="\$\(envval HIBIKI_SECRET "\$ENV_FILE"\)"/, 'secret survives upgrades');
  assert.match(sh, /install -m 0640 -o root -g "\$SVC_USER" "\$ENV_NEW" "\$ENV_FILE"/);
  assert.ok(!/HIBIKI_DEV/.test(sh), 'the dev auth bypass is never configured by the installer');
  assert.match(sh, /CONTINUUM_ADMIN_NPUB/); assert.match(sh, /ws:\/\/127\.0\.0\.1:7777/);
});
t('GPL-3.0 licence present and declared', () => {
  assert.match(read('LICENSE'), /GNU GENERAL PUBLIC LICENSE\s+Version 3/);
  assert.equal(pkg.license, 'GPL-3.0-or-later'); assert.equal(svcPkg.license, 'GPL-3.0-or-later');
});
t('event model adds no new kinds', () => {
  const em = read('docs/event-model.md');
  const kinds = new Set([...em.matchAll(/"kind":\s*(\d+)/g)].map((m) => Number(m[1])));
  for (const k of kinds) assert.ok([0, 1984, 10000, 10040, 30004, 30078, 30382, 30383, 30384, 30385].includes(k), `unexpected kind ${k}`);
});
t('ADR-0001 is accepted at rev 4 and the event model is accepted', () => {
  assert.ok(/Status:\s*\*{0,2}Accepted\*{0,2},? rev(ision)? 4/i.test(read('docs/adr/0001-personalised-discovery.md')), 'ADR-0001 status');
  assert.ok(/Status:\s*\*{0,2}Accepted/i.test(read('docs/event-model.md')), 'event model status');
});
t('node_modules and local data are never committed', () => {
  const gi = read('.gitignore');
  assert.match(gi, /node_modules\//); assert.match(gi, /\*\.db/);
});

console.log(`\n${passed} passed`);
