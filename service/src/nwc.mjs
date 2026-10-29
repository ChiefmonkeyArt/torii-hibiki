// nwc.mjs — forwards Nostr Wallet Connect (NIP-47) messages between the
// owner's browser and their wallet. The browser holds the connection secret,
// signs and encrypts every request; the node only checks the envelope,
// publishes it to the wallet's relay and hands back the wallet's signed,
// encrypted answer. The node never sees the secret or the content.
import { verifyEvent } from 'nostr-tools/pure';
import { FetchError } from './safefetch.mjs';

const HEX64 = /^[0-9a-f]{64}$/;
const clean = ({ id, pubkey, created_at, kind, tags, content, sig }) => ({ id, pubkey, created_at, kind, tags, content, sig });
const valid = (ev) => { try { return verifyEvent(clean(ev)); } catch { return false; } };

/** Public wss relays only: no IP literals, no local names, no credentials. */
export function relayOk(u) {
  let x; try { x = new URL(u); } catch { return false; }
  const h = x.hostname.toLowerCase();
  if (x.protocol !== 'wss:' || x.username || x.password || !h.includes('.')) return false;
  if (/^[\d.]+$/.test(h) || h.includes(':') || h.startsWith('[')) return false;
  return !/(^|\.)(localhost|local|internal|lan|home|arpa)$/.test(h);
}
export function cleanRelays(list) {
  if (!Array.isArray(list)) return null;
  const r = [...new Set(list.map((s) => String(s).trim().replace(/\/+$/, '')))];
  return r.length && r.length <= 4 && r.every(relayOk) ? r : null;
}
/** Envelope checks for a kind 23194 request signed by the connection key. */
export function checkNwcRequest(ev, now = Math.floor(Date.now() / 1000)) {
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return 'not an event';
  if (ev.kind !== 23194) return 'not a wallet request';
  const p = Array.isArray(ev.tags) ? ev.tags.filter((t) => t[0] === 'p') : [];
  if (p.length !== 1 || !HEX64.test(p[0][1] || '')) return 'bad wallet key';
  if (typeof ev.content !== 'string' || !ev.content || ev.content.length > 16384) return 'bad content';
  if (!Number.isInteger(ev.created_at) || Math.abs(now - ev.created_at) > 120) return 'request is stale';
  if (!valid(ev)) return 'bad signature';
  return '';
}

/** transport: { listen(relays, filter, onEvent, onReady) -> stop, send(relays, ev), query(relays, filters, ms) } */
export function makeNwc({ transport, maxBusy = 4 }) {
  let busy = 0;
  return {
    async info(relaysIn, pk) {
      const relays = cleanRelays(relaysIn);
      if (!relays) throw new FetchError('wallet relay must be a public wss:// address', 400);
      if (!HEX64.test(pk || '')) throw new FetchError('bad wallet key', 400);
      const evs = await transport.query(relays, [{ kinds: [13194], authors: [pk], limit: 3 }], 5000);
      const ev = evs.filter((e) => e.kind === 13194 && e.pubkey === pk && valid(e)).sort((a, b) => b.created_at - a.created_at)[0];
      if (!ev) return { found: false, methods: [], encryption: ['nip04'] };
      const enc = (ev.tags.find((t) => t[0] === 'encryption')?.[1] || 'nip04').split(/\s+/).filter(Boolean).slice(0, 6);
      return { found: true, methods: ev.content.split(/\s+/).filter(Boolean).slice(0, 40), encryption: enc };
    },
    request(relaysIn, ev, ms = 45000) {
      const relays = cleanRelays(relaysIn);
      if (!relays) return Promise.reject(new FetchError('wallet relay must be a public wss:// address', 400));
      const why = checkNwcRequest(ev);
      if (why) return Promise.reject(new FetchError(why, 400));
      if (busy >= maxBusy) return Promise.reject(new FetchError('too many wallet requests at once', 429));
      const wallet = ev.tags.find((t) => t[0] === 'p')[1], req = clean(ev);
      busy++;
      return new Promise((resolve, reject) => {
        let done = false, stop = null;
        const end = (f, v) => { if (done) return; done = true; clearTimeout(timer); busy--; try { stop?.(); } catch {} f(v); };
        const timer = setTimeout(() => end(reject, new FetchError('your wallet did not answer in time', 504)), ms);
        stop = transport.listen(relays, { kinds: [23195], authors: [wallet], '#e': [req.id], since: req.created_at - 60 },
          (r) => { if (r?.kind === 23195 && r.pubkey === wallet && r.tags?.some((t) => t[0] === 'e' && t[1] === req.id) && valid(r)) end(resolve, clean(r)); },
          () => { Promise.resolve(transport.send(relays, req)).catch(() => {}); });
        if (done) stop?.();
      });
    },
    get busy() { return busy; },
  };
}
