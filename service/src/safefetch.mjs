// safefetch.mjs — outbound HTTPS for the image proxy, media proxy and link
// previews. https only, public addresses only (checked at connect time via a
// pinned lookup, so DNS rebinding cannot swap in a private address), manual
// redirects re-validated hop by hop, byte cap and timeout.
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';

const BLOCK4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
const ip4n = (ip) => ip.split('.').reduce((a, b) => (a << 8) + Number(b), 0) >>> 0;

export function isPublicIp(ip) {
  if (net.isIPv4(ip)) {
    const n = ip4n(ip);
    return !BLOCK4.some(([base, bits]) => (n >>> (32 - bits)) === (ip4n(base) >>> (32 - bits)));
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    const m = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isPublicIp(m[1]);
    if (x === '::' || x === '::1') return false;
    // fc00::/7 unique local, fe80::/10 link local, ff00::/8 multicast, 2001:db8::/32 docs, 64:ff9b::/96 NAT64
    if (/^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith('ff') || x.startsWith('2001:db8') || x.startsWith('64:ff9b')) return false;
    if (x.startsWith('::')) return false; // IPv4-compatible and other reserved
    return true;
  }
  return false;
}

export function checkUrl(u) {
  let x;
  try { x = new URL(u); } catch { throw new FetchError('bad url', 400); }
  if (x.protocol !== 'https:') throw new FetchError('https only', 400);
  if (x.username || x.password) throw new FetchError('credentials in url', 400);
  if (x.port && x.port !== '443') throw new FetchError('port not allowed', 400);
  const h = x.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(h) && !isPublicIp(h)) throw new FetchError('private address', 403);
  if (/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(h)) throw new FetchError('private host', 403);
  return x;
}

export class FetchError extends Error {
  constructor(msg, status = 502) { super(msg); this.status = status; }
}

function safeLookup(host, opts, cb) {
  dns.lookup(host, { all: true, verbatim: true }, (err, addrs) => {
    if (err) return cb(err);
    const ok = addrs.filter((a) => isPublicIp(a.address));
    if (!ok.length || ok.length !== addrs.length) return cb(new FetchError('resolves to a private address', 403));
    if (opts && opts.all) return cb(null, ok);
    cb(null, ok[0].address, ok[0].family);
  });
}

const agent = new https.Agent({ keepAlive: true, maxSockets: 32, lookup: safeLookup });
const UA = 'Hibiki/1 (+https://github.com/ChiefmonkeyArt/torii-hibiki)';

/** Opens a response stream. Caller must consume or destroy `res`.
 *  opts: { accept, maxRedirects=4, timeout=10000, headers } */
export function open(url, opts = {}) {
  const max = opts.maxRedirects ?? 4;
  return new Promise((resolve, reject) => {
    let hops = 0;
    const go = (u) => {
      let x;
      try { x = checkUrl(u); } catch (e) { return reject(e); }
      const req = https.get(x, {
        agent, timeout: opts.timeout ?? 10000,
        headers: { 'user-agent': UA, accept: opts.accept || '*/*', 'accept-encoding': 'identity', ...(opts.headers || {}) },
      }, (res) => {
        const s = res.statusCode || 0;
        if (s >= 300 && s < 400 && res.headers.location) {
          res.resume();
          if (++hops > max) return reject(new FetchError('too many redirects'));
          return go(new URL(res.headers.location, x).toString());
        }
        resolve({ res, url: x.toString() });
      });
      req.on('timeout', () => req.destroy(new FetchError('upstream timeout', 504)));
      req.on('error', (e) => reject(e instanceof FetchError ? e : new FetchError(e.message)));
    };
    go(url);
  });
}

/** Buffers a whole body up to `cap` bytes. `anyStatus` returns error bodies too (status in the result). */
export async function fetchBuffer(url, { cap = 8 * 1024 * 1024, accept, timeout = 10000, anyStatus = false } = {}) {
  const { res, url: final } = await open(url, { accept, timeout });
  const status = res.statusCode || 0;
  if (status !== 200 && !anyStatus) { res.resume(); throw new FetchError(`upstream ${status}`); }
  const len = Number(res.headers['content-length'] || 0);
  if (len > cap) { res.destroy(); throw new FetchError('too large', 413); }
  const chunks = []; let n = 0;
  const deadline = setTimeout(() => res.destroy(new FetchError('body timeout', 504)), timeout);
  try {
    for await (const c of res) {
      n += c.length;
      if (n > cap) { res.destroy(); throw new FetchError('too large', 413); }
      chunks.push(c);
    }
  } finally { clearTimeout(deadline); }
  return { status, body: Buffer.concat(chunks), type: String(res.headers['content-type'] || ''), url: final };
}
