// signer.mjs — HMAC-signed proxy paths. The node only fetches URLs it has
// itself put into a feed response, so the proxies are never open relays.
import crypto from 'node:crypto';

export const WIDTHS = [96, 320, 640, 1080];
const b64u = (s) => Buffer.from(s).toString('base64url');

export function makeSigner(secret, base = '/hibiki') {
  const mac = (s) => crypto.createHmac('sha256', secret).update(s).digest('base64url').slice(0, 22);
  return {
    img(url, w = 640) {
      if (!url || !url.startsWith('https://')) return null;
      if (!WIDTHS.includes(w)) w = 640;
      const u = b64u(url);
      return `${base}/img/${mac(`img|${w}|${u}`)}/${w}/${u}`;
    },
    media(url) {
      if (!url || !url.startsWith('https://')) return null;
      const u = b64u(url);
      return `${base}/media/${mac(`media|${u}`)}/${u}`;
    },
    link(url) { return mac(`link|${url}`); },
    /** Returns the original URL for a valid signed path tail, or null. */
    verifyImg(sig, w, u) {
      w = Number(w);
      if (!WIDTHS.includes(w) || !safeEq(sig, mac(`img|${w}|${u}`))) return null;
      return decode(u);
    },
    verifyMedia(sig, u) { return safeEq(sig, mac(`media|${u}`)) ? decode(u) : null; },
    verifyLink(sig, url) { return safeEq(sig, mac(`link|${url}`)); },
    session(pubkey, ttlSec = 30 * 86400) {
      const exp = Math.floor(Date.now() / 1000) + ttlSec;
      const body = `${pubkey}.${exp}`;
      return `${body}.${mac(`sess|${body}`)}`;
    },
    verifySession(tok) {
      const m = /^([0-9a-f]{64})\.(\d{10})\.([\w-]{22})$/.exec(tok || '');
      if (!m || Number(m[2]) < Date.now() / 1000) return null;
      return safeEq(m[3], mac(`sess|${m[1]}.${m[2]}`)) ? m[1] : null;
    },
  };
}

function decode(u) {
  try { const s = Buffer.from(u, 'base64url').toString('utf8'); return s.startsWith('https://') ? s : null; }
  catch { return null; }
}
function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
