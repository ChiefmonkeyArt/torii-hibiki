#!/usr/bin/env node
// tools/test.mjs — no-dependency checks for the web app, headers, installer and
// docs. The service has its own node:test suite in service/test (npm test runs both).
import os from 'node:os';
import cp from 'node:child_process';
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
const WEB_JS = ['web/shell.js', 'web/wallet.js', 'web/napplet.js', 'web/rank.js'];
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
  for (const m of js.matchAll(/\.src = (\w+)/g)) assert.equal(m[1], 'srcs', 'direct src writes only from the PROXY-filtered list');
  assert.match(js, /srcs = \[big, p\.pic\]\.filter\(function \(s\) \{ return s && PROXY\.test\(s\); \}\)/);
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
t('size budgets (gzip): shell <= 8 KB, wallet <= 6 KB + lazy crypto <= 28 KB, napplet <= 32 KB, fonts <= 64 KB', () => {
  const wal = gz('web/wallet.js'), crypto = gz('web/nwc.js');
  console.log(`     wallet ${wal} B, wallet crypto (loaded on first use) ${crypto} B`);
  assert.ok(wal <= 6 * 1024, `wallet ${wal}`); assert.ok(crypto <= 28 * 1024, `nwc ${crypto}`);
  const shell = ['web/index.html', 'web/shell.js', 'web/shell.css'].reduce((a, f) => a + gz(f), 0);
  const nap = ['web/napplet.html', 'web/napplet.js', 'web/rank.js', 'web/napplet.css', 'web/hibiki.css'].reduce((a, f) => a + gz(f), 0);
  const fonts = fs.readdirSync(path.join(ROOT, 'web/fonts')).filter((f) => f.endsWith('.woff2')).reduce((a, f) => a + fs.statSync(path.join(ROOT, 'web/fonts', f)).size, 0);
  console.log(`     shell ${shell} B, napplet ${nap} B, fonts ${fonts} B`);
  assert.ok(shell <= 8 * 1024, `shell ${shell}`); assert.ok(nap <= 32 * 1024, `napplet ${nap}`); assert.ok(fonts <= 64 * 1024, `fonts ${fonts}`);
});
t('replies and likes: no reply gating, in-place like, opt-out only for likes', () => {
  const nap = read('web/napplet.js'), shell = read('web/shell.js');
  assert.ok(!/outside your circle/.test(nap) && !/showOthers/.test(nap), 'every reply is shown, no Show gate');
  assert.match(nap, /function patch\(it\)/); assert.ok(!/S\.liked\[it\.id\] = 1; render\(\)/.test(nap), 'liking does not re-render the page');
  assert.match(shell, /draft\.kind === 7 && store\.get\('skip7'/, 'only likes may skip the confirm dialog');
  assert.match(read('web/index.html'), /id="c-skipbox"/);
});
t('watch: preview frames are lazy and capped, the player keeps everything on screen', () => {
  const nap = read('web/napplet.js'), css = read('web/napplet.css');
  assert.match(nap, /frameBusy < 3/, 'at most three preview frames load at once');
  assert.match(nap, /preload: 'metadata'.*'aria-hidden': 'true'/, 'preview frames load metadata only');
  const wm = nap.slice(nap.indexOf('function watchModal'), nap.indexOf('function liveCard'));
  assert.ok(wm && !/noteCard|videoBox/.test(wm), 'no second copy of the post or a placeholder under the playing video');
  assert.match(css, /\.modal>\.glass\.vm\{[^}]*height:calc\(100vh - 48px\)[^}]*overflow:hidden/, 'player fits the viewport on desktop');
  assert.match(css, /\.pb>\*\{flex-shrink:0\}/);
});
t('zaps: owner confirms (or one-taps within their limits), shell checks every value the napplet sends', () => {
  const shell = read('web/shell.js'), nap = read('web/napplet.js');
  const z = shell.slice(shell.indexOf('function zap(d)'), shell.indexOf('var INVOICE'));
  const za = z.slice(z.indexOf('function zapAsk('));
  assert.ok(za && /return ask\(\{/.test(za), 'a normal zap goes through the confirm dialog');
  assert.ok(!/skip7|skip:/.test(z), 'the zap confirm has no skip flag');
  assert.match(z, /if \(d\.one\) \{\s*if \(!wallet \|\| !wallet\.ready\(\)\) return Promise\.reject/, 'one-tap only with a connected wallet');
  assert.match(z, /return zapAsk\(d, Math\.floor\(Number\(d\.sats\)\)\)/, 'otherwise the dialog');
  assert.match(z, /sats >= 1 && sats <= 1000000/); assert.match(z, /HEX\.test\(d\.pubkey/);
  assert.match(shell, /case 'feed\.lightning': if \(INVOICE\.test\(d\.pr/, 'only invoices open a wallet');
  assert.match(shell, /case 'feed\.copy':\s*if \(INVOICE\.test\(d\.text[^)]*\) \|\| \/\^npub1/, 'clipboard takes invoices or npubs only');
  assert.match(shell, /case 'feed\.author': if \(HEX\.test/); assert.match(shell, /case 'feed\.zapcheck': if \(HEX\.test/);
  assert.ok(!/webln|window\.nostr/.test(nap), 'the napplet never reaches a wallet or signer itself');
});
t('one-tap zaps: shell owns the secret, the amount, the limits and the Undo (ADR-0001 9.4)', () => {
  const shell = read('web/shell.js'), nap = read('web/napplet.js'), w = read('web/wallet.js'), html = read('web/index.html');
  assert.ok(!/walletconnect|secret|nip44|HibikiNWC/i.test(nap), 'the napplet never sees the wallet connection');
  assert.ok(html.indexOf('src="wallet.js"') > 0 && html.indexOf('src="wallet.js"') < html.indexOf('src="shell.js"'), 'wallet.js loads before shell.js');
  const one = w.slice(w.indexOf('function oneTap('), w.indexOf('// ---- settings dialog'));
  assert.match(one, /sats = l\.tap/, 'amount comes from the shell\'s own settings, not the message');
  assert.ok(!/d\.sats/.test(one), 'the napplet amount is ignored');
  assert.match(one, /sats > l\.cap \|\| l\.spent \+ sats > l\.daily\) return fallback/, 'over a limit goes back to the dialog');
  assert.match(one, /setTimeout\(res, 3000\)/, '3 second Undo window');
  assert.ok(one.indexOf("wait.then") < one.indexOf("request('pay_invoice'"), 'pays only after the Undo window');
  assert.match(one, /Date\.now\(\) - lastTap < 600/, 'tap rate limit');
  assert.match(w, /var DEF = \{ tap: 21, cap: 1000, daily: 10000 \}/, 'owner-chosen defaults');
  assert.match(w, /nip44\.encrypt\(x\.owner\(\), JSON\.stringify\(o\)\)/, 'record encrypted to the owner');
  assert.match(w, /\['d', 'hibiki\/wallet'\]/);
  assert.ok(!/localStorage/.test(w), 'no raw storage: secrets only via the shell store fallback or sessionStorage');
  assert.match(w, /a\.pubkey !== W\.pk \|\| !L\.verify\(a\) \|\| !a\.tags\.some/, 'wallet answers are checked in the browser too');
  assert.match(shell, /case 'feed\.wallet': if \(wallet\) wallet\.open\(\); break;/);
  assert.match(shell, /send\('feed\.walletstate', s\)/); assert.match(nap, /m\.type === 'feed\.walletstate'/);
  assert.match(sh, /web\/wallet\.js web\/nwc\.js/, 'installer preflight lists the wallet files');
});
t('wallet crypto bundle matches its source and pinned versions', () => {
  const head = read('web/nwc.js').split('\n')[0];
  assert.match(head, new RegExp(`nostr-tools ${lock.packages['node_modules/nostr-tools'].version.replace(/\./g, '\\.')} .*esbuild ${svcPkg.devDependencies.esbuild.replace(/\./g, '\\.')}`));
  assert.match(svcPkg.devDependencies.esbuild, /^\d+\.\d+\.\d+$/, 'esbuild pinned exactly');
  const r = cp.spawnSync(process.execPath, [path.join(ROOT, 'tools/build-nwc.mjs'), '--check'], { encoding: 'utf8' });
  if (/Cannot find (package|module) 'esbuild'/.test(r.stderr)) { console.log('     (esbuild not installed; rebuild check skipped)'); return; }
  assert.equal(r.status, 0, r.stderr || r.stdout);
});
t('columns: draggable, remembered divider, hidden on phones', () => {
  const nap = read('web/napplet.js'), css = read('web/napplet.css'), shell = read('web/shell.js');
  assert.match(nap, /role: 'separator', 'aria-orientation': 'vertical'/);
  assert.match(nap, /ArrowLeft/); assert.match(nap, /dblclick/);
  assert.match(nap, /tell\('feed\.pref', \{ split: S\.split \}\)/);
  assert.match(shell, /d\.split >= 280 && d\.split <= 1600/, 'shell bounds the stored width');
  assert.match(css, /calc\(100% - 400px\)/, 'the feed column keeps at least 400px');
  assert.match(css, /max-width:860px\)\{\.split\{display:none\}/);
});
t('conversation: names open profiles, Reply opens a form under that comment', () => {
  const nap = read('web/napplet.js');
  assert.match(nap, /function who\(pk/); assert.match(nap, /function personPage\(/);
  assert.match(nap, /function composer\(/); assert.match(nap, /myReplies/, 'your reply shows at once');
  assert.match(nap, /posted ' \+ \w+\.dup \+ ' times|dup \+ ' times/, 'collapsed duplicates are labelled');
});
t('deploy access (ADR-0002): hook accepts only deploy vX.Y.Z or status', () => {
  const run = (cmd) => cp.spawnSync('bash', [path.join(ROOT, 'ops/hibiki-deploy-hook')], { env: { ...process.env, SSH_ORIGINAL_COMMAND: cmd, HIBIKI_HOOK_DRYRUN: '1' }, encoding: 'utf8' });
  assert.match(run('deploy v0.2.4').stdout, /would run: sudo -n \/usr\/local\/sbin\/hibiki-deploy v0\.2\.4/);
  assert.match(run('status').stdout, /would run: curl/);
  for (const bad of ['', 'bash', 'deploy main', 'deploy v0.2.4; id', 'deploy v0.2.4 && id', 'deploy v0.2', 'deploy $(id)', 'status; id', 'deploy v0.2.4\nid']) {
    const r = run(bad); assert.equal(r.status, 2, `refused: ${JSON.stringify(bad)}`); assert.ok(!/would run/.test(r.stdout));
  }
});
t('deploy access (ADR-0002): only an annotated tag at main HEAD with matching VERSION installs', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdep-'));
  const g = (cwd, ...a) => cp.execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...a], { cwd, encoding: 'utf8' });
  const up = path.join(tmp, 'up'); fs.mkdirSync(up); g(up, 'init', '-q');
  const commit = (v) => { fs.writeFileSync(path.join(up, 'VERSION'), v + '\n'); fs.writeFileSync(path.join(up, 'install.sh'), '#!/bin/sh\necho INSTALLED $(cat VERSION)\n', { mode: 0o755 }); g(up, 'add', '-A'); g(up, 'commit', '-qm', v); };
  commit('0.9.0'); g(up, 'tag', '-a', 'v0.9.0', '-m', 'old');
  commit('0.9.1'); g(up, 'tag', 'v0.9.1'); // lightweight
  commit('0.9.3'); g(up, 'tag', '-a', 'v0.9.2', '-m', 'wrong version');
  g(up, 'tag', '-a', 'v0.9.3', '-m', 'good');
  const dep = (tag) => cp.spawnSync('bash', [path.join(ROOT, 'ops/hibiki-deploy'), tag], { env: { ...process.env, HIBIKI_DEPLOY_SRC: path.join(tmp, 'src'), HIBIKI_DEPLOY_REPO: up, HIBIKI_DEPLOY_LOCK: path.join(tmp, 'lock') }, encoding: 'utf8' });
  try {
    assert.match(dep('v0.9.3').stdout, /INSTALLED 0\.9\.3/);
    for (const [tag, why] of [['v0.9.0', /not main HEAD/], ['v0.9.1', /not an annotated tag/], ['v0.9.2', /does not match/], ['v9.9.9', /not an annotated tag/], ['main', /not a release tag/], ['v0.9.3;id', /not a release tag/]]) {
      const r = dep(tag); assert.notEqual(r.status, 0, tag); assert.match(r.stderr, why, tag); assert.ok(!/INSTALLED/.test(r.stdout), tag);
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
t('deploy access (ADR-0002): manual workflow, pinned host key, narrow sudoers, forced-command key', () => {
  const wf = read('.github/workflows/deploy.yml'), setup = read('ops/install-deploy-access.sh');
  const on = wf.slice(wf.indexOf('\non:'), wf.indexOf('\npermissions:'));
  assert.match(on, /workflow_dispatch/); assert.ok(!/\b(push|schedule|pull_request|release|workflow_run)\b/.test(on), 'manual only');
  assert.match(wf, /StrictHostKeyChecking=yes/); assert.match(wf, /permissions:\n  contents: read/);
  assert.ok(!/\$\{\{ inputs\.tag \}\}"?\s*$/m.test(wf.split('run:').slice(1).join('')), 'inputs reach shell only through env');
  assert.match(setup, /NOPASSWD: \/usr\/local\/sbin\/hibiki-deploy"/); assert.match(setup, /visudo -c -f/);
  assert.match(setup, /command="\/usr\/local\/sbin\/hibiki-deploy-hook",restrict/);
  assert.match(read('ops/hibiki-deploy.pub'), /^ssh-ed25519 \S+ hibiki-deploy@github-actions\n?$/);
  assert.match(read('ops/hibiki-deploy'), /if \[\[ "\$\(id -u\)" -ne 0 \]\]; then/, 'test overrides are ignored as root');
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
