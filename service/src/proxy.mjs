// proxy.mjs — the three privacy proxies. Readers' browsers only ever talk to
// this node; upstream hosts see the node, never the reader.
import { fetchBuffer, open, FetchError } from './safefetch.mjs';
import { sniff } from './imaging.mjs';
import { unent, summarize } from './tldr.mjs';

const RASTER = /^image\/(jpeg|png|gif|webp|avif)/;
const MEDIA = /^(video\/(mp4|webm|quicktime|x-m4v)|audio\/(mpeg|mp4|ogg|opus|wav|x-wav|flac|aac|webm|x-m4a))/;
const IMMUTABLE = 'public, max-age=604800, immutable';

export function makeProxies({ signer, cache, imager, log = () => {} }) {
  // imager: a promise of { name, render(body, width) } from imaging.mjs
  const im = Promise.resolve(imager);
  const inflight = new Map();

  async function render(url, w) {
    const { body, type } = await fetchBuffer(url, { cap: 8 * 1024 * 1024, accept: 'image/avif,image/webp,image/*' });
    if (!RASTER.test(type) && !sniff(body)) throw new FetchError('not a raster image', 415);
    // Re-encode (or strip, on the copy backend): removes EXIF/GPS and other metadata.
    const { body: out } = await (await im).render(body, w);
    return out;
  }

  async function img(req, res, sig, w, u) {
    const url = signer.verifyImg(sig, w, u);
    if (!url) return send(res, 403, 'bad signature');
    const key = `img|${(await im).name}|${w}|${u}`;
    let out = await cache.get(key);
    if (!out) {
      let p = inflight.get(key);
      if (!p) { p = render(url, Number(w)).finally(() => inflight.delete(key)); inflight.set(key, p); }
      try { out = await p; } catch (e) { log('img', e.message); return send(res, e.status || 502, 'image unavailable'); }
      cache.put(key, out).catch(() => {});
    }
    const type = sniff(out);
    if (!type) return send(res, 502, 'image unavailable');
    res.writeHead(200, { 'content-type': type, 'content-length': out.length, 'cache-control': IMMUTABLE, 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'" });
    res.end(out);
  }

  async function media(req, res, sig, u) {
    const url = signer.verifyMedia(sig, u);
    if (!url) return send(res, 403, 'bad signature');
    const range = /^bytes=\d*-\d*$/.test(req.headers.range || '') ? req.headers.range : undefined;
    let up;
    try { up = await open(url, { accept: 'video/*,audio/*', timeout: 15000, headers: range ? { range } : {} }); }
    catch (e) { return send(res, e.status || 502, 'media unavailable'); }
    const r = up.res, type = String(r.headers['content-type'] || '').toLowerCase();
    if (![200, 206].includes(r.statusCode) || !MEDIA.test(type)) { r.destroy(); return send(res, 415, 'not playable media'); }
    const h = { 'content-type': type.split(';')[0], 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'" };
    for (const k of ['content-length', 'content-range']) if (r.headers[k]) h[k] = r.headers[k];
    res.writeHead(r.statusCode, h);
    r.pipe(res);
    res.on('close', () => r.destroy());
  }

  /** Link preview: title, description, site, image (signed), from OpenGraph. */
  async function link(url) {
    const key = `link2|${url}`;
    const hit = await cache.get(key);
    if (hit) return JSON.parse(hit.toString());
    const { body, type, url: final } = await fetchBuffer(url, { cap: 1536 * 1024, accept: 'text/html,application/xhtml+xml' });
    if (!/text\/html|application\/xhtml/.test(type)) throw new FetchError('not html', 415);
    const html = body.toString('utf8');
    const out = parseOg(html, final);
    // Free extractive TL;DR from the page we already fetched (no AI, no third party).
    const sum = summarize(html, out.title);
    if (sum) { out.tldr = sum.tldr; out.readMinutes = out.readMinutes || sum.minutes; }
    out.image = out.image ? signer.img(out.image, 640) : null;
    await cache.put(key, Buffer.from(JSON.stringify(out)));
    return out;
  }

  return { img, media, link };
}

const clip = (s, n) => unent(String(s || '')).replace(/\s+/g, ' ').trim().slice(0, n);

export function parseOg(html, base) {
  const head = html.slice(0, 200000);
  const meta = {};
  for (const m of head.matchAll(/<meta\s+([^>]+?)\/?>/gi)) {
    const a = {};
    for (const p of m[1].matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) a[p[1].toLowerCase()] = p[3] ?? p[4];
    const k = (a.property || a.name || '').toLowerCase();
    if (k && a.content && !(k in meta)) meta[k] = a.content;
  }
  const title = meta['og:title'] || meta['twitter:title'] || (head.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1];
  let image = meta['og:image'] || meta['twitter:image'] || '';
  try { image = image ? new URL(unent(image), base).toString() : ''; } catch { image = ''; }
  if (!image.startsWith('https://')) image = '';
  const words = Number(meta['twitter:data1']?.match(/(\d+)\s*min/)?.[1]) || null;
  return {
    url: base,
    site: clip(meta['og:site_name'] || new URL(base).hostname.replace(/^www\./, ''), 60),
    title: clip(title, 200),
    description: clip(meta['og:description'] || meta['twitter:description'] || meta.description, 400),
    image,
    readMinutes: words,
  };
}

function send(res, code, msg) {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(msg);
}
