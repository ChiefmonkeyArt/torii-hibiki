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

const ownerSk = generateSecretKey(), owner = getPublicKey(ownerSk);
const friendSk = generateSecretKey(), friend = getPublicKey(friendSk);
const now = () => Math.floor(Date.now() / 1000);

async function boot() {
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
  };
  const app = createApp(cfg, { db, store, ingest, log: () => {} });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}/hibiki`;
  return { app, store, base, published, dir };
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
