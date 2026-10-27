// nostr.mjs — pure helpers: NIP-10 thread structure, media and link extraction.

/** NIP-10: a kind-1 note is a root post when it has no `e` tag that marks a
 *  reply or root. `mention` markers and `q` quote tags do not make it a reply.
 *  Deprecated positional e-tags (no marker) are treated as replies. */
export function isRootNote(ev) {
  if (ev.kind !== 1) return false;
  for (const t of ev.tags) {
    if (t[0] !== 'e') continue;
    const marker = t[3];
    if (marker === 'mention') continue;
    return false;
  }
  return true;
}

/** Returns { root, reply } event ids for a reply, per NIP-10. */
export function replyRefs(ev) {
  const es = ev.tags.filter((t) => t[0] === 'e' && t[3] !== 'mention' && /^[0-9a-f]{64}$/.test(t[1] || ''));
  if (!es.length) return { root: null, reply: null };
  const root = es.find((t) => t[3] === 'root')?.[1];
  const reply = es.find((t) => t[3] === 'reply')?.[1];
  if (root || reply) return { root: root || reply, reply: reply || root };
  return { root: es[0][1], reply: es[es.length - 1][1] }; // positional
}

const URL_RE = /\bhttps:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]]/g;
const IMG = /\.(?:jpe?g|png|gif|webp|avif)(?:\?[^\s]*)?$/i;
const VID = /\.(?:mp4|webm|mov|m4v)(?:\?[^\s]*)?$/i;
const AUD = /\.(?:mp3|m4a|ogg|opus|wav|flac|aac)(?:\?[^\s]*)?$/i;
const TRACK = /^(?:utm_|fbclid$|gclid$|mc_|ref$|ref_src$|igshid$|si$)/i;

export function cleanUrl(u) {
  try {
    const x = new URL(u);
    if (x.protocol !== 'https:') return null;
    for (const k of [...x.searchParams.keys()]) if (TRACK.test(k)) x.searchParams.delete(k);
    x.hash = '';
    return x.toString();
  } catch { return null; }
}

/** imeta (NIP-92) gives alt, dim, blurhash and mime per url. */
function imeta(ev) {
  const m = new Map();
  for (const t of ev.tags) {
    if (t[0] !== 'imeta') continue;
    const o = {};
    for (const p of t.slice(1)) { const i = p.indexOf(' '); if (i > 0) o[p.slice(0, i)] = p.slice(i + 1); }
    if (o.url) m.set(o.url, o);
  }
  return m;
}

/** Splits note content into media (image/video/audio) and links. */
export function extract(ev) {
  const meta = imeta(ev);
  const media = [], links = [];
  const seen = new Set();
  for (const raw of (ev.content || '').match(URL_RE) || []) {
    if (seen.has(raw)) continue; seen.add(raw);
    const im = meta.get(raw) || {};
    const mime = im.m || '';
    let type = null;
    if (mime.startsWith('image/') || IMG.test(raw)) type = 'image';
    else if (mime.startsWith('video/') || VID.test(raw)) type = 'video';
    else if (mime.startsWith('audio/') || AUD.test(raw)) type = 'audio';
    if (type) media.push({ type, url: raw, alt: (im.alt || '').slice(0, 300), dim: im.dim || null, thumb: type === 'video' && /^https:\/\//.test(im.image || '') ? im.image : null });
    else { const c = cleanUrl(raw); if (c) links.push(c); }
  }
  // kinds 20/21/22 carry media only in imeta tags
  if (!media.length) for (const [url, im] of meta) {
    const mime = im.m || '';
    const type = mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'image';
    if (url.startsWith('https://')) media.push({ type, url, alt: (im.alt || '').slice(0, 300), dim: im.dim || null, thumb: /^https:\/\//.test(im.image || '') ? im.image : null });
  }
  return { media: media.slice(0, 8), links: links.slice(0, 4) };
}

export function tag(ev, name) { return ev.tags.find((t) => t[0] === name)?.[1]; }

export function hashtags(ev) {
  return [...new Set(ev.tags.filter((t) => t[0] === 't' && t[1]).map((t) => t[1].toLowerCase().slice(0, 40)))].slice(0, 10);
}

/** Parses a kind-0 profile defensively; only known string fields survive. */
export function parseProfile(ev) {
  let j = {};
  try { j = JSON.parse(ev.content); } catch { /* ignore */ }
  const s = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
  return {
    name: s(j.display_name, 64) || s(j.name, 64),
    about: s(j.about, 400),
    picture: s(j.picture, 1000).startsWith('https://') ? s(j.picture, 1000) : '',
    nip05: s(j.nip05, 120),
    lud16: s(j.lud16, 120),
  };
}

/** Zap receipt (9735) amount in sats from the embedded request's amount tag or bolt11. */
export function zapSats(ev) {
  try {
    const req = JSON.parse(tag(ev, 'description') || '{}');
    const msat = Number(req.tags?.find((t) => t[0] === 'amount')?.[1]);
    if (msat > 0) return Math.floor(msat / 1000);
  } catch { /* fall through */ }
  const b = (tag(ev, 'bolt11') || '').match(/^lnbc(\d+)([munp]?)/i);
  if (!b) return 0;
  const mult = { '': 1e8, m: 1e5, u: 100, n: 0.1, p: 0.0001 }[b[2].toLowerCase()];
  return Math.floor(Number(b[1]) * mult);
}
