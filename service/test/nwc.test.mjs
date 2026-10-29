import test from 'node:test';
import assert from 'node:assert/strict';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import * as nip44 from 'nostr-tools/nip44';
import * as nip04 from 'nostr-tools/nip04';
import { verifyEvent } from 'nostr-tools/pure';
import fs from 'node:fs';
import vm from 'node:vm';
import { relayOk, cleanRelays, checkNwcRequest, makeNwc } from '../src/nwc.mjs';

const now = () => Math.floor(Date.now() / 1000);
const conn = generateSecretKey(), walletSk = generateSecretKey(), wallet = getPublicKey(walletSk);
const key = (a, b) => nip44.v2.utils.getConversationKey(a, b);
const request = (o = {}) => finalizeEvent({ kind: 23194, created_at: now(), tags: [['p', wallet], ['encryption', 'nip44_v2']], content: nip44.v2.encrypt(JSON.stringify({ method: 'pay_invoice', params: { invoice: 'lnbc1' } }), key(conn, wallet)), ...o }, conn);
const answer = (req, sk = walletSk, e = req.id) => finalizeEvent({ kind: 23195, created_at: now(), tags: [['p', req.pubkey], ['e', e]], content: nip44.v2.encrypt(JSON.stringify({ result_type: 'pay_invoice', result: { preimage: '00' } }), key(sk, req.pubkey)) }, sk);

test('wallet relays must be public wss addresses', () => {
  assert.ok(relayOk('wss://relay.getalby.com/v1'));
  for (const u of ['ws://relay.example.com', 'wss://localhost', 'wss://127.0.0.1', 'wss://[::1]', 'wss://box.local', 'wss://u:p@relay.example.com', 'https://relay.example.com', 'wss://nodot']) assert.equal(relayOk(u), false, u);
  assert.deepEqual(cleanRelays(['wss://a.example/', 'wss://a.example']), ['wss://a.example']);
  assert.equal(cleanRelays([]), null); assert.equal(cleanRelays('wss://a.example'), null);
  assert.equal(cleanRelays(['wss://a.ex', 'wss://b.ex', 'wss://c.ex', 'wss://d.ex', 'wss://e.ex']), null, 'at most four');
});

test('wallet request envelopes are checked before they leave the node', () => {
  assert.equal(checkNwcRequest(request()), '');
  assert.equal(checkNwcRequest(finalizeEvent({ kind: 1, created_at: now(), tags: [['p', wallet]], content: 'x' }, conn)), 'not a wallet request');
  assert.equal(checkNwcRequest(request({ tags: [['p', wallet], ['p', wallet]] })), 'bad wallet key');
  assert.equal(checkNwcRequest(request({ content: 'x'.repeat(17000) })), 'bad content');
  assert.equal(checkNwcRequest(request({ created_at: now() - 600 })), 'request is stale');
  assert.equal(checkNwcRequest({ ...request(), content: 'tampered' }), 'bad signature');
  assert.equal(checkNwcRequest([]), 'not an event');
});

function fakeTransport() {
  const t = { sent: [], subs: [], order: [] };
  t.listen = (relays, filter, onEvent, onReady) => { const s = { relays, filter, onEvent, stopped: false }; t.subs.push(s); t.order.push('listen'); setTimeout(onReady, 5); return () => { s.stopped = true; }; };
  t.send = (relays, ev) => { t.order.push('send'); t.sent.push(ev); };
  t.query = async () => t.info || [];
  return t;
}

test('wallet answers are matched to the request and checked', async () => {
  const tr = fakeTransport(), nwc = makeNwc({ transport: tr });
  const req = request();
  const p = nwc.request(['wss://relay.example.com'], req, 2000);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(tr.order, ['listen', 'send'], 'subscribes before sending');
  assert.equal(tr.sent[0].id, req.id);
  const s = tr.subs[0];
  assert.deepEqual(s.filter.authors, [wallet]); assert.deepEqual(s.filter['#e'], [req.id]);
  s.onEvent(answer(req, generateSecretKey())); // someone else
  s.onEvent(answer(req, walletSk, 'ab'.repeat(32))); // another request
  s.onEvent({ ...answer(req), content: 'forged' }); // bad signature
  const good = answer(req);
  s.onEvent(good);
  const out = await p;
  assert.equal(out.id, good.id); assert.ok(s.stopped, 'subscription closed');
  assert.equal(nwc.busy, 0);
});

test('wallet requests time out, refuse bad input and cap concurrency', async () => {
  const tr = fakeTransport(), nwc = makeNwc({ transport: tr, maxBusy: 1 });
  const slow = nwc.request(['wss://relay.example.com'], request(), 80);
  await assert.rejects(nwc.request(['wss://relay.example.com'], request(), 80), (e) => e.status === 429);
  await assert.rejects(slow, (e) => e.status === 504 && /did not answer/.test(e.message));
  assert.ok(tr.subs[0].stopped);
  await assert.rejects(nwc.request(['ws://relay.example.com'], request()), (e) => e.status === 400);
  await assert.rejects(nwc.request(['wss://relay.example.com'], { ...request(), kind: 1 }), (e) => e.status === 400);
  assert.equal(nwc.busy, 0);
});

test('wallet info reads the signed capability event', async () => {
  const tr = fakeTransport(), nwc = makeNwc({ transport: tr });
  assert.deepEqual(await nwc.info(['wss://relay.example.com'], wallet), { found: false, methods: [], encryption: ['nip04'] });
  tr.info = [finalizeEvent({ kind: 13194, created_at: now(), tags: [['encryption', 'nip44_v2 nip04']], content: 'pay_invoice get_info get_balance' }, walletSk),
    finalizeEvent({ kind: 13194, created_at: now() + 5, tags: [], content: 'everything' }, generateSecretKey())];
  assert.deepEqual(await nwc.info(['wss://relay.example.com'], wallet), { found: true, methods: ['pay_invoice', 'get_info', 'get_balance'], encryption: ['nip44_v2', 'nip04'] });
  await assert.rejects(nwc.info(['wss://relay.example.com'], 'nothex'), (e) => e.status === 400);
});

test('the browser wallet bundle interoperates with nostr-tools', () => {
  const ctx = { crypto: globalThis.crypto, TextEncoder, TextDecoder, Uint8Array, console };
  ctx.self = ctx; ctx.globalThis = ctx;
  vm.runInNewContext(fs.readFileSync(new URL('../../web/nwc.js', import.meta.url), 'utf8'), ctx);
  const L = ctx.HibikiNWC, hex = (b) => Buffer.from(b).toString('hex');
  const sk = hex(conn), msg = '{"method":"get_info","params":{}}';
  assert.equal(L.pubkey(sk), getPublicKey(conn));
  const ev = L.sign({ kind: 23194, created_at: now(), tags: [['p', wallet]], content: 'x' }, sk);
  assert.ok(verifyEvent(JSON.parse(JSON.stringify(ev)))); assert.ok(L.verify(answer(request())));
  assert.equal(nip44.v2.decrypt(L.enc('nip44_v2', sk, wallet, msg), key(walletSk, getPublicKey(conn))), msg);
  assert.equal(L.dec('nip44_v2', sk, wallet, nip44.v2.encrypt(msg, key(walletSk, getPublicKey(conn)))), msg);
  assert.equal(nip04.decrypt(walletSk, getPublicKey(conn), L.enc('nip04', sk, wallet, msg)), msg);
  assert.equal(L.dec('nip04', sk, wallet, nip04.encrypt(walletSk, getPublicKey(conn), msg)), msg);
});
