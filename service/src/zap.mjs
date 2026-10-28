// zap.mjs — NIP-57 zaps sent by the owner. The node looks up the recipient's
// Lightning address (LUD-16/LUD-06) through the SSRF-safe fetcher, passes the
// owner-signed zap request (kind 9734) to their LNURL server, and checks the
// invoice it gets back: mainnet, exactly the confirmed amount, and a
// description hash that commits to that zap request. Paying happens in the
// owner's own wallet. The node never holds funds or keys.
import { createHash } from 'node:crypto';
import { verifyEvent } from 'nostr-tools';
import { fetchBuffer, FetchError } from './safefetch.mjs';

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const HEX64 = /^[0-9a-f]{64}$/;
export const MAX_SATS = 1_000_000;

function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const b = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}
const hrpExpand = (hrp) => [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];

/** bech32 decode without the 90-character limit (invoices are long). */
export function bech32Decode(str) {
  const s = String(str || '');
  if (s.length > 4096 || (s !== s.toLowerCase() && s !== s.toUpperCase())) throw new Error('bad bech32');
  const low = s.toLowerCase(), pos = low.lastIndexOf('1');
  if (pos < 1 || pos + 7 > low.length) throw new Error('bad bech32');
  const hrp = low.slice(0, pos), words = [];
  for (const c of low.slice(pos + 1)) { const v = CHARSET.indexOf(c); if (v < 0) throw new Error('bad bech32'); words.push(v); }
  if (polymod([...hrpExpand(hrp), ...words]) !== 1) throw new Error('bad bech32 checksum');
  return { hrp, words: words.slice(0, -6) };
}
export function bech32Encode(hrp, words) {
  const pm = polymod([...hrpExpand(hrp), ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  const chk = []; for (let i = 0; i < 6; i++) chk.push((pm >>> (5 * (5 - i))) & 31);
  return hrp + '1' + [...words, ...chk].map((w) => CHARSET[w]).join('');
}
export function convertBits(data, from, to, pad) {
  let acc = 0, bits = 0; const out = [], max = (1 << to) - 1;
  for (const v of data) { acc = (acc << from) | v; bits += from; while (bits >= to) { bits -= to; out.push((acc >>> bits) & max); } }
  if (pad && bits) out.push((acc << (to - bits)) & max);
  return out;
}
export const encodeLnurl = (url) => bech32Encode('lnurl', convertBits([...Buffer.from(url, 'utf8')], 8, 5, true));

/** Amount (msat, as a BigInt or null) and description hash of a mainnet BOLT11 invoice. */
export function parseBolt11(pr) {
  const { hrp, words } = bech32Decode(pr);
  const m = /^lnbc(\d*)([munp]?)$/.exec(hrp);
  if (!m) throw new Error('not a mainnet lightning invoice');
  let msat = null;
  if (m[1]) {
    const n = BigInt(m[1]);
    msat = { '': n * 100_000_000_000n, m: n * 100_000_000n, u: n * 100_000n, n: n * 100n, p: n / 10n }[m[2]];
    if (m[2] === 'p' && n % 10n) throw new Error('sub-millisatoshi amount');
  }
  let i = 7, hash = null; // after the 35-bit timestamp; the last 104 words are the signature
  const end = words.length - 104;
  if (end < 7) throw new Error('invoice too short');
  while (i + 3 <= end) {
    const type = words[i], len = words[i + 1] * 32 + words[i + 2], data = words.slice(i + 3, i + 3 + len);
    if (i + 3 + len > end) throw new Error('bad invoice field');
    if (type === 23 && len === 52) hash = Buffer.from(convertBits(data, 5, 8, false).slice(0, 32)).toString('hex'); // 'h'
    i += 3 + len;
  }
  return { msat, hash };
}

/** LNURL-pay endpoint for a profile's lud16 (name@domain) or lud06 (bech32 lnurl). */
export function lnurlEndpoint(p) {
  const a = String(p.lud16 || '').trim().toLowerCase();
  const m = /^([a-z0-9._+-]{1,64})@([a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})+)$/.exec(a);
  if (m) return `https://${m[2]}/.well-known/lnurlp/${m[1]}`;
  const l = String(p.lud06 || '').trim();
  if (/^lnurl1/i.test(l)) {
    const { hrp, words } = bech32Decode(l);
    if (hrp !== 'lnurl') return null;
    const u = Buffer.from(convertBits(words, 5, 8, false)).toString('utf8');
    return /^https:\/\//.test(u) ? u : null;
  }
  return null;
}

/** GETs JSON from a wallet server. Error bodies are read so their LNURL `reason` reaches the owner;
 *  a 5xx, timeout or dropped connection is retried once (asking again only creates another unpaid invoice). */
export async function getJson(url, tries = 2, fetch = fetchBuffer) {
  const host = new URL(url).host;
  let r;
  try { r = await fetch(url, { cap: 64 * 1024, accept: 'application/json', timeout: 8000, anyStatus: true }); } catch (e) {
    if (tries > 1 && !(e.status >= 400 && e.status < 500)) return getJson(url, tries - 1, fetch);
    throw new FetchError(`${host} did not answer (${e.message})`, 502);
  }
  let j = null; try { j = JSON.parse(r.body.toString('utf8')); } catch {}
  if (r.status >= 500 && tries > 1) return getJson(url, tries - 1, fetch);
  if (r.status !== 200) {
    const why = j && typeof j.reason === 'string' ? ': ' + j.reason.slice(0, 120) : '';
    throw new FetchError(`${host} returned error ${r.status}${why}`, r.status >= 500 ? 502 : 422);
  }
  if (!j || typeof j !== 'object') throw new FetchError(`${host} sent a reply that is not JSON`, 502);
  return j;
}

/** Reads and checks a LNURL-pay description. Only NIP-57 capable servers can be zapped. */
export async function payInfo(endpoint, get = getJson) {
  const j = await get(endpoint);
  if (j.status === 'ERROR') throw new FetchError(String(j.reason || 'wallet server error').slice(0, 120), 422);
  if (j.tag !== 'payRequest' || !/^https:\/\//.test(j.callback || '')) throw new FetchError('not a lightning pay address', 422);
  if (j.allowsNostr !== true || !HEX64.test(j.nostrPubkey || '')) throw new FetchError('this wallet does not accept zaps', 422);
  const min = Math.ceil(Number(j.minSendable) / 1000), max = Math.floor(Number(j.maxSendable) / 1000);
  if (!(min >= 1) || !(max >= min)) throw new FetchError('wallet server sent bad limits', 422);
  return { callback: j.callback, min, max: Math.min(max, MAX_SATS), comment: Math.max(0, Math.min(Number(j.commentAllowed) || 0, 500)), nostrPubkey: j.nostrPubkey, lnurl: encodeLnurl(endpoint) };
}

const tagv = (ev, k) => ev.tags.find((t) => t[0] === k)?.[1];

/** Checks an owner-signed zap request before it is sent anywhere. Returns the reason it is refused, or ''. */
export function checkZapRequest(ev, { owner, recipient, info, now = Math.floor(Date.now() / 1000) }) {
  if (!ev || ev.kind !== 9734 || ev.pubkey !== owner) return 'not your zap request';
  if (!verifyEvent(ev)) return 'bad signature';
  if (Math.abs(now - ev.created_at) > 600) return 'zap request is stale';
  const ps = ev.tags.filter((t) => t[0] === 'p');
  if (ps.length !== 1 || ps[0][1] !== recipient) return 'wrong recipient';
  const msat = Number(tagv(ev, 'amount'));
  if (!Number.isInteger(msat) || msat % 1000) return 'bad amount';
  const sats = msat / 1000;
  if (sats < info.min || sats > info.max) return `amount must be ${info.min}–${info.max} sats`;
  const relays = ev.tags.find((t) => t[0] === 'relays');
  if (!relays || relays.length < 2 || relays.slice(1).some((r) => !/^wss:\/\//.test(r))) return 'bad relays';
  if (tagv(ev, 'lnurl') !== info.lnurl) return 'wrong lnurl';
  const es = ev.tags.filter((t) => t[0] === 'e');
  if (es.length > 1 || (es[0] && !HEX64.test(es[0][1] || ''))) return 'bad e tag';
  if ((ev.content || '').length > 500) return 'comment too long';
  return '';
}

/** Gets the invoice for a checked zap request and verifies it commits to it. */
export async function zapInvoice(ev, info, get = getJson) {
  const msat = Number(tagv(ev, 'amount')), body = JSON.stringify(ev);
  const u = new URL(info.callback);
  u.searchParams.set('amount', String(msat));
  u.searchParams.set('nostr', body);
  u.searchParams.set('lnurl', info.lnurl);
  if (ev.content && info.comment) u.searchParams.set('comment', ev.content.slice(0, info.comment));
  const j = await get(u.toString());
  if (j.status === 'ERROR') throw new FetchError(String(j.reason || 'wallet server error').slice(0, 120), 422);
  if (typeof j.pr !== 'string') throw new FetchError('wallet server sent no invoice', 502);
  const pr = j.pr.toLowerCase();
  const inv = parseBolt11(pr);
  if (inv.msat === null || inv.msat !== BigInt(msat)) throw new FetchError('invoice amount does not match what you confirmed', 422);
  // NIP-57 asks the wallet to commit the invoice to the zap request. Some (Primal) ignore it. The payer is
  // protected by the amount check above; an unbound invoice only means the wallet may not publish a receipt.
  return { pr, bound: inv.hash === createHash('sha256').update(body).digest('hex') };
}

/** True if `receipt` (kind 9735) is the wallet's receipt for zap request `reqId`. */
export function isReceiptFor(receipt, reqId, info) {
  if (!receipt || receipt.kind !== 9735 || receipt.pubkey !== info.nostrPubkey) return false;
  try { return JSON.parse(tagv(receipt, 'description') || '{}').id === reqId && verifyEvent(receipt); } catch { return false; }
}

/** Per-node zap state: cached pay info per recipient and the owner's pending requests. */
export function makeZaps({ cfg, ingest, store, get = getJson }) {
  const infos = new Map(), pending = new Map();
  const prune = (m, ttl) => { const t = Date.now(); for (const [k, v] of m) if (t - v.at > ttl) m.delete(k); };

  /** Relays the wallet should publish the receipt to: public ones only, never loopback. */
  function receiptRelays() {
    const pub = [cfg.publicRelay, ...ingest.graph.ownerRelays].filter((r) => /^wss:\/\//.test(r || ''));
    return [...new Set(pub.length ? pub : cfg.indexRelays.filter((r) => /^wss:\/\//.test(r)))].slice(0, 5);
  }
  async function info(pk) {
    prune(infos, 10 * 60000);
    const hit = infos.get(pk);
    if (hit) return hit.info;
    const ev = await ingest.fetchProfile(pk);
    let p = {}; try { p = JSON.parse(ev?.content || '{}'); } catch {}
    const endpoint = lnurlEndpoint({ lud16: typeof p.lud16 === 'string' ? p.lud16 : '', lud06: typeof p.lud06 === 'string' ? p.lud06 : '' });
    if (!endpoint) throw new FetchError('this person has no lightning address', 422);
    const x = await payInfo(endpoint, get);
    x.address = (typeof p.lud16 === 'string' && p.lud16.includes('@') ? p.lud16.trim().toLowerCase() : new URL(endpoint).host).slice(0, 120);
    if (infos.size > 500) infos.clear();
    infos.set(pk, { info: x, at: Date.now() });
    return x;
  }
  return {
    receiptRelays,
    async describe(pk) {
      const x = await info(pk);
      return { ok: true, min: x.min, max: x.max, comment: x.comment, lnurl: x.lnurl, address: x.address, relays: receiptRelays() };
    },
    async invoice(ev) {
      const recipient = ev?.tags?.find((t) => t[0] === 'p')?.[1];
      if (!HEX64.test(recipient || '')) throw new FetchError('wrong recipient', 400);
      const x = await info(recipient);
      const why = checkZapRequest(ev, { owner: cfg.owner, recipient, info: x });
      if (why) throw new FetchError(why, 400);
      const { pr, bound } = await zapInvoice(ev, x, get);
      prune(pending, 30 * 60000);
      if (pending.size > 200) pending.clear();
      pending.set(ev.id, { at: Date.now(), p: recipient, relays: ev.tags.find((t) => t[0] === 'relays').slice(1), info: x, created: ev.created_at });
      return { pr, bound, sats: Number(ev.tags.find((t) => t[0] === 'amount')[1]) / 1000 };
    },
    async receipt(id) {
      const z = pending.get(id);
      if (!z) return { paid: false, unknown: true };
      const filter = { kinds: [9735], '#p': [z.p], since: z.created - 60, limit: 50 };
      const local = store.getByFilters(filter);
      const found = local.find((r) => isReceiptFor(r, id, z.info)) ||
        (await ingest.query([cfg.primaryRelay, ...z.relays], [filter], 4000)).find((r) => isReceiptFor(r, id, z.info));
      if (found) pending.delete(id);
      return { paid: !!found };
    },
  };
}
