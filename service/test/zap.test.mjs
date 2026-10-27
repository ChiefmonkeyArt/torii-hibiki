import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { bech32Encode, bech32Decode, convertBits, encodeLnurl, parseBolt11, lnurlEndpoint, payInfo, checkZapRequest, zapInvoice, isReceiptFor, MAX_SATS } from '../src/zap.mjs';
import { encodeQR } from '../src/qr.mjs';
import { firstAccepted } from '../src/ingest.mjs';

const now = () => Math.floor(Date.now() / 1000);
const ownerSk = generateSecretKey(), owner = getPublicKey(ownerSk);
const friend = getPublicKey(generateSecretKey());
const walletSk = generateSecretKey(), walletPk = getPublicKey(walletSk);

import { fakeInvoice } from './helpers.mjs';

test('bech32, lnurl and bolt11 parsing', () => {
  const l = encodeLnurl('https://pay.example/.well-known/lnurlp/tamsin');
  assert.match(l, /^lnurl1/);
  assert.equal(lnurlEndpoint({ lud06: l.toUpperCase() }), 'https://pay.example/.well-known/lnurlp/tamsin');
  assert.equal(lnurlEndpoint({ lud16: 'Tamsin@Pay.Example' }), 'https://pay.example/.well-known/lnurlp/tamsin');
  for (const bad of ['tamsin@localhost', 'a b@x.example', '@x.example', 'x@']) assert.equal(lnurlEndpoint({ lud16: bad }), null);
  assert.equal(lnurlEndpoint({ lud06: encodeLnurl('http://pay.example/x') }), null, 'plain http lnurl refused');
  assert.throws(() => bech32Decode(l.slice(0, -1) + (l.endsWith('q') ? 'p' : 'q')), /checksum/i);
  const h = 'ab'.repeat(32);
  const a = parseBolt11(fakeInvoice('lnbc10u', h));
  assert.equal(a.msat, 1_000_000n); assert.equal(a.hash, h);
  assert.equal(parseBolt11(fakeInvoice('lnbc2500n', h)).msat, 250_000n);
  assert.equal(parseBolt11(fakeInvoice('lnbc', h)).msat, null);
  assert.throws(() => parseBolt11(fakeInvoice('lntb10u', h)), /mainnet/);
  assert.throws(() => parseBolt11(fakeInvoice('lnbc15p', h)), /sub-millisatoshi/);
});

const payDoc = { tag: 'payRequest', callback: 'https://pay.example/cb', minSendable: 1000, maxSendable: 5e9, allowsNostr: true, nostrPubkey: walletPk, commentAllowed: 140 };

test('payInfo accepts only NIP-57 wallets and caps the maximum', async () => {
  const x = await payInfo('https://pay.example/.well-known/lnurlp/t', async () => payDoc);
  assert.equal(x.min, 1); assert.equal(x.max, MAX_SATS); assert.equal(x.comment, 140); assert.match(x.lnurl, /^lnurl1/);
  await assert.rejects(payInfo('https://p.example/x', async () => ({ ...payDoc, allowsNostr: false })), /does not accept zaps/);
  await assert.rejects(payInfo('https://p.example/x', async () => ({ ...payDoc, callback: 'http://p.example/cb' })), /not a lightning/);
  await assert.rejects(payInfo('https://p.example/x', async () => ({ status: 'ERROR', reason: 'gone' })), /gone/);
  await assert.rejects(payInfo('https://p.example/x', async () => ({ ...payDoc, minSendable: 9e9 })), /bad limits/);
});

function request(over = {}, sk = ownerSk, info) {
  const tags = over.tags || [['relays', 'wss://relay.example'], ['amount', '21000'], ['lnurl', info.lnurl], ['p', friend], ['e', 'cd'.repeat(32)]];
  return finalizeEvent({ kind: 9734, created_at: over.created_at || now(), tags, content: over.content || 'cheer up' }, sk);
}

test('zap requests and invoices are checked before money moves', async () => {
  const info = await payInfo('https://pay.example/.well-known/lnurlp/t', async () => payDoc);
  const ctx = { owner, recipient: friend, info };
  const ok = request({}, ownerSk, info);
  assert.equal(checkZapRequest(ok, ctx), '');
  assert.equal(checkZapRequest(request({}, generateSecretKey(), info), ctx), 'not your zap request');
  assert.equal(checkZapRequest(JSON.parse(JSON.stringify({ ...ok, content: 'tampered' })), ctx), 'bad signature');
  assert.equal(checkZapRequest(request({ created_at: now() - 3600 }, ownerSk, info), ctx), 'zap request is stale');
  assert.equal(checkZapRequest(ok, { ...ctx, recipient: owner }), 'wrong recipient');
  const t = (k, v) => ok.tags.map((x) => (x[0] === k ? [k, ...v] : x));
  assert.equal(checkZapRequest(request({ tags: t('amount', ['21500']) }, ownerSk, info), ctx), 'bad amount');
  assert.match(checkZapRequest(request({ tags: t('amount', [String((MAX_SATS + 1) * 1000)]) }, ownerSk, info), ctx), /amount must be/);
  assert.equal(checkZapRequest(request({ tags: t('relays', ['ws://127.0.0.1:7777']) }, ownerSk, info), ctx), 'bad relays');
  assert.equal(checkZapRequest(request({ tags: t('lnurl', ['lnurl1xyz']) }, ownerSk, info), ctx), 'wrong lnurl');

  const hash = createHash('sha256').update(JSON.stringify(ok)).digest('hex');
  let asked;
  const wallet = (pr) => async (u) => { asked = new URL(u); return { pr }; };
  assert.match(await zapInvoice(ok, info, wallet(fakeInvoice('lnbc210n', hash))), /^lnbc210n1/);
  assert.equal(asked.searchParams.get('amount'), '21000');
  assert.equal(JSON.parse(asked.searchParams.get('nostr')).id, ok.id);
  assert.equal(asked.searchParams.get('comment'), 'cheer up');
  await assert.rejects(zapInvoice(ok, info, wallet(fakeInvoice('lnbc1u', hash))), /amount does not match/);
  await assert.rejects(zapInvoice(ok, info, wallet(fakeInvoice('lnbc210n', 'ef'.repeat(32)))), /does not match your zap request/);
  await assert.rejects(zapInvoice(ok, info, wallet(fakeInvoice('lnbc', hash))), /amount does not match/);

  const receipt = finalizeEvent({ kind: 9735, created_at: now(), tags: [['p', friend], ['bolt11', 'x'], ['description', JSON.stringify(ok)]], content: '' }, walletSk);
  assert.equal(isReceiptFor(receipt, ok.id, info), true);
  assert.equal(isReceiptFor(receipt, 'ab'.repeat(32), info), false);
  const forged = finalizeEvent({ kind: 9735, created_at: now(), tags: [['description', JSON.stringify(ok)]], content: '' }, generateSecretKey());
  assert.equal(isReceiptFor(forged, ok.id, info), false, 'receipt must come from the wallet key');
});

test('QR codes have the standard structure', () => {
  const finder = (q, r, c) => { for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) { const ring = Math.max(Math.abs(y - 3), Math.abs(x - 3)); if ((q.rows[r + y][c + x] === '1') !== (ring !== 2)) return false; } return true; };
  for (const text of ['HELLO', 'LIGHTNING:' + fakeInvoice('lnbc210n', 'ab'.repeat(32)).toUpperCase(), 'https://example.com/ünïcode']) {
    const q = encodeQR(text);
    assert.equal(q.size, 4 * q.version + 17); assert.equal(q.rows.length, q.size);
    assert.ok(q.rows.every((r) => r.length === q.size && /^[01]+$/.test(r)));
    assert.ok(finder(q, 0, 0) && finder(q, 0, q.size - 7) && finder(q, q.size - 7, 0), 'finder patterns');
    for (let i = 8; i < q.size - 8; i++) assert.equal(q.rows[6][i], i % 2 ? '0' : '1', 'timing pattern');
    assert.equal(q.rows[q.size - 8][8], '1', 'dark module');
  }
  assert.ok(encodeQR('A'.repeat(400)).version < encodeQR('a'.repeat(400)).version, 'alphanumeric mode is denser');
  assert.throws(() => encodeQR('x'.repeat(5000)));
});

test('publish answers on the first relay OK and leaves slow relays pending', async () => {
  const wait = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms));
  const t0 = Date.now();
  const out = await firstAccepted(['wss://a', 'wss://b', 'wss://c'], (u) => (u === 'wss://a' ? wait(20, { ok: true }) : u === 'wss://b' ? Promise.reject(new Error('nope')) : wait(5000, { ok: true })), 2000);
  assert.ok(Date.now() - t0 < 1000);
  assert.deepEqual(out.map((r) => [r.ok, !!r.pending]), [[true, false], [false, false], [false, true]]);
  assert.equal(out[1].message, 'nope');
  const t1 = Date.now();
  const none = await firstAccepted(['wss://a'], () => wait(5000, { ok: true }), 100);
  assert.ok(Date.now() - t1 < 1000); assert.equal(none[0].pending, true);
  const allFail = await firstAccepted(['wss://a', 'wss://b'], () => Promise.resolve({ ok: false, message: 'blocked' }), 2000);
  assert.deepEqual(allFail.map((r) => r.message), ['blocked', 'blocked']);
});
