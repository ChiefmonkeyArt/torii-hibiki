import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { EventStore } from 'applesauce-core';
import { NativeSqliteEventDatabase } from 'applesauce-sqlite/native';
import { createApp, VERSION } from '../src/server.mjs';
import { loadConfig } from '../src/config.mjs';
import { createHash } from 'node:crypto';
import { fakeInvoice } from './helpers.mjs';

const ownerSk = generateSecretKey(), owner = getPublicKey(ownerSk);
const friendSk = generateSecretKey(), friend = getPublicKey(friendSk);
const now = () => Math.floor(Date.now() / 1000);

async function boot(deps = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hibiki-'));
  const cfg = loadConfig({ HIBIKI_OWNER: owner, HIBIKI_SECRET: 'cd'.repeat(32), HIBIKI_DATA: dir, HIBIKI_ORIGIN: 'https://node.example' });
  const db = new NativeSqliteEventDatabase(':memory:');
  const store = new EventStore({ database: db });
  const published = [];
  const ingest = {
    graph: { follows: new Set([friend]), hop2: new Map(), mutes: new Set(), outbox: new Map(), ownerRelays: [], updated: Date.now() },
    state: { lastSync: now(), relaysUsed: 3, lastError: null },
    tick() {}, stop() {}, async fetchThread() {}, async fetchEvent(id) { return store.getEvent(id); },
    async publish(ev) { published.push(ev); return [{ relay: 'ws://127.0.0.1:7777', ok: true, message: '' }]; },
    async fetchAuthor(pk) { ingest.authorAsked = pk; }, async fetchProfile(pk) { return store.getReplaceable(0, pk); },
    async query() { return ingest.queryResult || []; },
    async fetchWallet() { ingest.walletAsked = (ingest.walletAsked || 0) + 1; },
    nwcTransport: { listen: (r, f, on, ready) => { ingest.nwcSub = { f, on }; setTimeout(ready, 1); return () => {}; }, send: (r, ev) => { ingest.nwcSent = ev; }, async query() { return ingest.nwcInfo || []; } },
  };
  const app = createApp(cfg, { db, store, ingest, log: () => {}, ...deps });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}/hibiki`;
  return { app, store, base, published, dir, ingest };
}

async function login(base) {
  const url = 'https://node.example/hibiki/api/login';
  const ev = finalizeEvent({ kind: 27235, created_at: now(), tags: [['u', url], ['method', 'POST']], content: '' }, ownerSk);
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { authorization: 'Nostr ' + Buffer.from(JSON.stringify(ev)).toString('base64'), 'x-hibiki': '1' } });
  return r.headers.get('set-cookie').split(';')[0];
}

test('feed service end to end', async (t) => {
  const { app, store, base, published, dir } = await boot();
  t.after(() => { app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const root = finalizeEvent({ kind: 1, created_at: now() - 60, tags: [], content: 'Low tide at Polruan https://img.example/tide.jpg' }, friendSk);
  const reply = finalizeEvent({ kind: 1, created_at: now() - 30, tags: [['e', root.id, '', 'root'], ['p', friend]], content: 'Lovely' }, ownerSk);
  const like = finalizeEvent({ kind: 7, created_at: now() - 20, tags: [['e', root.id], ['p', friend]], content: '+' }, ownerSk);
  store.add(finalizeEvent({ kind: 0, created_at: now() - 100, tags: [], content: JSON.stringify({ name: 'Tamsin', picture: 'https://img.example/me.png' }) }, friendSk));
  // A stranger's reply that other strangers liked: shown, but after the circle reply.
  const strangerSk = generateSecretKey(), fanSk = generateSecretKey();
  const sReply = finalizeEvent({ kind: 1, created_at: now() - 40, tags: [['e', root.id, '', 'root'], ['p', friend]], content: 'The light on the estuary here is something else' }, strangerSk);
  const quiet = finalizeEvent({ kind: 1, created_at: now() - 50, tags: [['e', root.id, '', 'root'], ['p', friend]], content: 'Nice spot for a walk' }, fanSk);
  const fanLike = finalizeEvent({ kind: 7, created_at: now() - 10, tags: [['e', sReply.id]], content: '+' }, fanSk);
  for (const e of [root, reply, like, sReply, quiet, fanLike]) store.add(e);

  let r = await fetch(`${base}/api/health`);
  const health = await r.json();
  assert.equal(health.version, VERSION);
  assert.ok(['loading', 'sharp', 'vips', 'copy'].includes(health.img), 'health reports the image backend');

  r = await fetch(`${base}/api/feed?section=circle`);
  assert.equal(r.status, 401, 'feed needs the owner session');

  // NIP-98 login
  const url = 'https://node.example/hibiki/api/login';
  const auth = (sk) => 'Nostr ' + Buffer.from(JSON.stringify(finalizeEvent({ kind: 27235, created_at: now(), tags: [['u', url], ['method', 'POST']], content: '' }, sk))).toString('base64');
  r = await fetch(`${base}/api/login`, { method: 'POST', headers: { authorization: auth(ownerSk) } });
  assert.equal(r.status, 403, 'CSRF header required');
  r = await fetch(`${base}/api/login`, { method: 'POST', headers: { authorization: auth(friendSk), 'x-hibiki': '1' } });
  assert.equal(r.status, 401, 'non-owner cannot sign in');
  r = await fetch(`${base}/api/login`, { method: 'POST', headers: { authorization: auth(ownerSk), 'x-hibiki': '1' } });
  assert.equal(r.status, 200);
  const sc = r.headers.get('set-cookie');
  assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Strict/); assert.match(sc, /Secure/); assert.match(sc, /Path=\/hibiki\//);
  const cookie = sc.split(';')[0];

  r = await fetch(`${base}/api/feed?section=circle`, { headers: { cookie } });
  const feed = await r.json();
  assert.equal(r.status, 200);
  assert.equal(feed.items.length, 1, 'the reply is not in the feed');
  const it = feed.items[0];
  assert.equal(it.id, root.id);
  assert.equal(it.f.c, 1);
  assert.equal(it.f.ce, 0, 'the owner\'s own like does not boost the post');
  assert.equal(it.me.l, 1, 'the owner\'s like is reported so the button shows it');
  assert.equal(it.replies, 3);
  assert.deepEqual(it.peek.map((p) => p.id), [reply.id, sReply.id], 'peek: circle first, then the most popular reply from anyone');
  assert.equal(it.peek[1].likes, 1);
  assert.match(it.media[0].src, /^\/hibiki\/img\/[\w-]{22}\/640\//, 'media is a signed node path');
  assert.ok(!JSON.stringify(feed).includes('"https://img.example/me.png"'), 'raw image urls never reach the napplet');
  assert.match(feed.profiles[friend].pic, /^\/hibiki\/img\//);

  for (const s of ['today', 'news', 'watch', 'listen', 'read']) {
    r = await fetch(`${base}/api/feed?section=${s}`, { headers: { cookie } });
    assert.equal(r.status, 200, s);
  }
  r = await fetch(`${base}/api/feed?section=nope`, { headers: { cookie } });
  assert.equal(r.status, 400);

  r = await fetch(`${base}/api/thread/${root.id}`, { headers: { cookie } });
  const th = await r.json();
  assert.deepEqual(th.replies.map((x) => x.id), [reply.id, sReply.id, quiet.id], 'thread shows every reply: circle, popular, then oldest');
  assert.equal(th.replies[0].circle, true); assert.equal(th.replies[1].circle, false);
  assert.ok(!('showOthers' in th) && th.hiddenSpam === 0);

  r = await fetch(`${base}/api/signal`, { headers: { cookie } });
  assert.equal((await r.json()).follows, 1);

  // publish: signed by owner, allowed kind
  const mine = finalizeEvent({ kind: 7, created_at: now(), tags: [['e', root.id]], content: '+' }, ownerSk);
  r = await fetch(`${base}/api/publish`, { method: 'POST', headers: { cookie, 'x-hibiki': '1', 'content-type': 'application/json' }, body: JSON.stringify(mine) });
  assert.equal(r.status, 200); assert.equal(published.length, 1);
  const theirs = finalizeEvent({ kind: 7, created_at: now(), tags: [], content: '+' }, friendSk);
  r = await fetch(`${base}/api/publish`, { method: 'POST', headers: { cookie, 'x-hibiki': '1' }, body: JSON.stringify(theirs) });
  assert.equal(r.status, 400); assert.equal(published.length, 1);

  // proxies refuse unsigned or tampered paths before any network access
  r = await fetch(`${base}/img/${'A'.repeat(22)}/640/${Buffer.from('https://169.254.169.254/').toString('base64url')}`);
  assert.equal(r.status, 403);
  r = await fetch(`${base}/media/${'A'.repeat(22)}/${Buffer.from('https://x.example/v.mp4').toString('base64url')}`);
  assert.equal(r.status, 403);
  r = await fetch(`${base}/api/link?url=${encodeURIComponent('https://x.example/')}&sig=nope`, { headers: { cookie } });
  assert.equal(r.status, 403);

  r = await fetch(`${base}/api/logout`, { method: 'POST', headers: { cookie, 'x-hibiki': '1' } });
  assert.match(r.headers.get('set-cookie'), /Max-Age=0/);
});

test('profiles, duplicate replies and zaps over HTTP', async (t) => {
  const walletSk = generateSecretKey(), walletPk = getPublicKey(walletSk);
  const asked = [];
  let invoiceFor = null;
  const zapGet = async (u) => {
    asked.push(u);
    if (u === 'https://pay.example/.well-known/lnurlp/tamsin') return { tag: 'payRequest', callback: 'https://pay.example/cb', minSendable: 1000, maxSendable: 1e8, allowsNostr: true, nostrPubkey: walletPk, commentAllowed: 100 };
    const req = JSON.parse(new URL(u).searchParams.get('nostr'));
    return { pr: fakeInvoice('lnbc210n', invoiceFor || createHash('sha256').update(JSON.stringify(req)).digest('hex')) };
  };
  const { app, store, base, dir, ingest } = await boot({ zapGet });
  t.after(() => { app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  store.add(finalizeEvent({ kind: 0, created_at: now() - 100, tags: [], content: JSON.stringify({ name: 'Tamsin', about: 'Walks', lud16: 'tamsin@pay.example' }) }, friendSk));
  const root = finalizeEvent({ kind: 1, created_at: now() - 60, tags: [], content: 'Cheer up' }, friendSk);
  store.add(root);
  const spamSk = generateSecretKey();
  for (let i = 0; i < 3; i++) store.add(finalizeEvent({ kind: 1, created_at: now() - 50 + i, tags: [['e', root.id, '', 'root']], content: 'same words' }, spamSk));
  const cookie = await login(base);
  const H = { cookie, 'x-hibiki': '1' };

  let r = await fetch(`${base}/api/author/${friend}?live=1`, { headers: H });
  const a = await r.json();
  assert.equal(ingest.authorAsked, friend);
  assert.equal(a.profile.name, 'Tamsin'); assert.equal(a.profile.zap, true); assert.equal(a.rel.follow, true);
  assert.ok(a.items.some((x) => x.id === root.id));
  assert.equal((await fetch(`${base}/api/author/${friend}`)).status, 401, 'profile needs the owner session');

  r = await fetch(`${base}/api/thread/${root.id}`, { headers: H });
  const th = await r.json();
  const dupes = th.replies.filter((x) => x.content === 'same words');
  assert.equal(dupes.length, 1); assert.equal(dupes[0].dup, 3);

  r = await fetch(`${base}/api/zap/info/${friend}`, { headers: H });
  const info = await r.json();
  assert.equal(r.status, 200); assert.equal(info.address, 'tamsin@pay.example'); assert.equal(info.max, 100000);
  assert.ok(info.relays.length && info.relays.every((x) => x.startsWith('wss://')), 'receipt relays are public');
  r = await fetch(`${base}/api/zap/info/${owner}`, { headers: H });
  assert.equal(r.status, 422, 'no lightning address');

  const zr = (over = {}) => finalizeEvent({ kind: 9734, created_at: now(), content: 'cheer up', tags: [['relays', ...info.relays], ['amount', '21000'], ['lnurl', info.lnurl], ['p', friend], ['e', root.id], ...(over.tags || [])] }, over.sk || ownerSk);
  const post = (ev) => fetch(`${base}/api/zap/invoice`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify(ev) });
  const req = zr();
  r = await post(req);
  const inv = await r.json();
  assert.equal(r.status, 200); assert.equal(inv.sats, 21); assert.match(inv.pr, /^lnbc210n1/);
  assert.ok(Array.isArray(inv.qr) && inv.qr.length >= 21);
  assert.equal((await post(zr({ sk: friendSk }))).status, 422, 'only the owner can zap');
  assert.equal(inv.bound, true);
  invoiceFor = 'ef'.repeat(32);
  r = await post(zr());
  assert.equal(r.status, 200); assert.equal((await r.json()).bound, false, 'unbound invoice allowed and flagged');
  assert.equal(asked.filter((u) => u.includes('lnurlp')).length, 1, 'pay info is cached');

  r = await fetch(`${base}/api/zap/receipt/${req.id}`, { headers: H });
  assert.deepEqual(await r.json(), { paid: false });
  ingest.queryResult = [finalizeEvent({ kind: 9735, created_at: now(), tags: [['p', friend], ['description', JSON.stringify(req)]], content: '' }, walletSk)];
  r = await fetch(`${base}/api/zap/receipt/${req.id}`, { headers: H });
  assert.deepEqual(await r.json(), { paid: true });
  r = await fetch(`${base}/api/zap/receipt/${'00'.repeat(32)}`, { headers: H });
  assert.equal((await r.json()).unknown, true);
});

test('wallet record and wallet connect relay hop', async (t) => {
  const { app, store, base, dir, ingest } = await boot();
  t.after(() => { app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  let r = await fetch(`${base}/api/wallet`);
  assert.equal(r.status, 401, 'owner only');
  const cookie = await login(base), H = { cookie, 'x-hibiki': '1', 'content-type': 'application/json' };
  r = await fetch(`${base}/api/wallet?live=1`, { headers: { cookie } });
  assert.deepEqual(await r.json(), { event: null }); assert.equal(ingest.walletAsked, 1);
  const rec = finalizeEvent({ kind: 30078, created_at: now() - 10, tags: [['d', 'hibiki/wallet']], content: 'ciphertext-only' }, ownerSk);
  store.add(rec);
  r = await fetch(`${base}/api/wallet`, { headers: { cookie } });
  assert.equal((await r.json()).event.id, rec.id);
  store.add(finalizeEvent({ kind: 30078, created_at: now(), tags: [['d', 'hibiki/wallet']], content: '' }, ownerSk));
  r = await fetch(`${base}/api/wallet`, { headers: { cookie } });
  assert.deepEqual(await r.json(), { event: null }, 'disconnect clears it');

  const conn = generateSecretKey(), wSk = generateSecretKey(), wpk = getPublicKey(wSk);
  r = await fetch(`${base}/api/nwc/info`, { method: 'POST', headers: H, body: JSON.stringify({ relays: ['wss://127.0.0.1'], pk: wpk }) });
  assert.equal(r.status, 422, 'private relay refused');
  ingest.nwcInfo = [finalizeEvent({ kind: 13194, created_at: now(), tags: [['encryption', 'nip44_v2']], content: 'pay_invoice' }, wSk)];
  r = await fetch(`${base}/api/nwc/info`, { method: 'POST', headers: H, body: JSON.stringify({ relays: ['wss://relay.example.com'], pk: wpk }) });
  assert.deepEqual(await r.json(), { found: true, methods: ['pay_invoice'], encryption: ['nip44_v2'] });
  const req = finalizeEvent({ kind: 23194, created_at: now(), tags: [['p', wpk]], content: 'sealed' }, conn);
  const p = fetch(`${base}/api/nwc/request`, { method: 'POST', headers: H, body: JSON.stringify({ relays: ['wss://relay.example.com'], ev: req }) });
  while (!ingest.nwcSent) await new Promise((x) => setTimeout(x, 5));
  assert.equal(ingest.nwcSent.id, req.id);
  const ans = finalizeEvent({ kind: 23195, created_at: now(), tags: [['e', req.id], ['p', req.pubkey]], content: 'sealed-answer' }, wSk);
  ingest.nwcSub.on(ans);
  r = await p; assert.equal(r.status, 200); assert.equal((await r.json()).event.id, ans.id);
  r = await fetch(`${base}/api/nwc/request`, { method: 'POST', headers: H, body: JSON.stringify({ relays: ['wss://relay.example.com'], ev: { ...req, content: 'changed' } }) });
  assert.equal(r.status, 422);
  r = await fetch(`${base}/api/nwc/request`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({}) });
  assert.ok(r.status >= 400, 'needs the CSRF header');
});
