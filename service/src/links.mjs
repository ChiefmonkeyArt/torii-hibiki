// links.mjs — what a shared link is, and which links are the same story
// (ADR-0005). The node reads each new link once in the background (through the
// same safe fetch and cache as link previews), keeps a small record of its
// kind, official address and headline, and the News page is built from that.
// Pure helpers plus one bounded queue. GPL-3.0-or-later.

// Sites whose links are never news articles, by kind. Matched on the host or
// any parent domain. Kept short: page metadata decides everything else.
const HOSTS = {
  video: 'youtube.com youtu.be vimeo.com rumble.com twitch.tv odysee.com tiktok.com dailymotion.com bitchute.com zap.stream',
  code: 'github.com gitlab.com codeberg.org gitea.com sr.ht gitworkshop.dev npmjs.com crates.io pypi.org',
  social: 'x.com twitter.com t.me telegram.me facebook.com instagram.com threads.net bsky.app reddit.com mastodon.social discord.com discord.gg linkedin.com ' +
    'open.substack.com stacker.news primal.net njump.me iris.to snort.social coracle.social nostrudel.ninja damus.io habla.news yakihonne.com highlighter.com nostr.band',
  audio: 'open.spotify.com music.apple.com podcasts.apple.com soundcloud.com bandcamp.com wavlake.com fountain.fm fanfares.io',
  page: 'change.org donorbox.org gofundme.com givesendgo.com geyser.fund kickstarter.com patreon.com linktr.ee',
  shop: 'amazon.com amazon.co.uk amazon.de ebay.com ebay.co.uk etsy.com aliexpress.com temu.com shopify.com',
  short: 'bit.ly t.co tinyurl.com ow.ly buff.ly is.gd goo.gl lnkd.in shorturl.at rebrand.ly cutt.ly dlvr.it trib.al',
};
const HOST_KIND = new Map();
for (const [kind, list] of Object.entries(HOSTS)) for (const h of list.split(' ')) HOST_KIND.set(h, kind);

/** News shows articles; Watch shows videos; the Dev strip shows code. Audio, social, shop and other pages are left out. */
export const NEWS_KINDS = new Set(['article']);
// Pages that carry article-ish markup but are not news: apps, products, books, events, docs.
const NOT_ARTICLE_LD = /^(SoftwareApplication|MobileApplication|WebApplication|Product|Event|Book|Course|JobPosting|Recipe|MusicRecording|MusicAlbum|PodcastSeries|Movie|VideoGame)$/;
const NOT_ARTICLE_HOST = /^(store|shop|apps?|play|docs|wiki|help|support|status|accounts?|login|checkout|pay)\./;
const NOT_ARTICLE_PATH = /\/(shop|store|products?|cart|checkout|pricing|apps?|download|donate|raffle|events?|tickets?|jobs?|careers|login|signup|register|search|tags?|categor(y|ies)|about|contact)(\/|$)/i;
const ARTICLE_PATH = /\/(19|20)\d{2}\/\d{1,2}\/|\/(news|articles?|blog|posts?|p|story|stories|opinion|analysis|features?|world|politics|business|economy|tech|technology|science|wirtschaft|politik|nachrichten)\//i;
/** Older than this by its own publish date, a page is not news any more. */
export const MAX_AGE_DAYS = 30;
const ARTICLE_LD = /^(Article|NewsArticle|ReportageNewsArticle|AnalysisNewsArticle|OpinionNewsArticle|BackgroundNewsArticle|ReviewNewsArticle|BlogPosting|LiveBlogPosting|TechArticle|ScholarlyArticle|Report)$/;

const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };
/** Host without www./m./amp./mobile. so mobile and AMP copies match. */
export const bareHost = (h) => h.replace(/^(?:www\d?|m|amp|mobile)\./, '');

/** Kind from the host alone, or null when the page itself has to decide. */
export function hostKind(url) {
  let h = bareHost(hostOf(url));
  while (h) {
    const k = HOST_KIND.get(h);
    if (k) return k;
    const i = h.indexOf('.');
    if (i < 0) break;
    h = h.slice(i + 1);
  }
  return null;
}

/** Registrable domain, near enough: last two labels, three for co.uk-style. */
export function siteOf(u) {
  const parts = bareHost(hostOf(u)).split('.');
  const n = parts.length >= 3 && parts.at(-1).length === 2 && /^(co|com|org|net|ac|gov|edu|ne|or)$/.test(parts.at(-2)) ? 3 : 2;
  return parts.slice(-n).join('.');
}
export const sameSite = (a, b) => !!siteOf(a) && siteOf(a) === siteOf(b);

const AMP_Q = /^(amp|outputtype|output|format)$/i;
/** The grouping key: host without www/m/amp, path without /amp and trailing slash, no AMP params. */
export function storyKey(u) {
  let x;
  try { x = new URL(u); } catch { return u; }
  for (const k of [...x.searchParams.keys()]) if (AMP_Q.test(k) && /^(1|true|amp)?$/i.test(x.searchParams.get(k))) x.searchParams.delete(k);
  x.searchParams.sort();
  const path = x.pathname.replace(/\/amp(\.html)?\/?$/i, '/').replace(/\.amp(\.html)?$/i, '').replace(/\/+$/, '') || '';
  const q = x.searchParams.toString();
  return bareHost(x.hostname.toLowerCase()) + path + (q ? '?' + q : '');
}

/** article | video | code | social | shop | audio | short | page, from host and page metadata. */
export function classify(url, meta, now = Date.now()) {
  const final = meta?.url || url;
  const hk = hostKind(final);
  if (hk) return hk;
  if (!meta) return 'page';
  let x;
  try { x = new URL(final); } catch { return 'page'; }
  const og = (meta.ogType || '').toLowerCase(), ld = meta.ld || [];
  if (og === 'product' || meta.price || ld.some((t) => /^(Product|SoftwareApplication|MobileApplication|WebApplication)$/.test(t))) return 'shop';
  if (og.startsWith('music') || ld.some((t) => /^(MusicRecording|MusicAlbum|PodcastEpisode|PodcastSeries)$/.test(t))) return 'audio';
  if (og === 'book' || ld.some((t) => NOT_ARTICLE_LD.test(t))) return 'page';
  if (NOT_ARTICLE_HOST.test(x.hostname) || NOT_ARTICLE_PATH.test(x.pathname)) return 'page';
  const when = Date.parse(meta.published || '');
  if (when && now - when > MAX_AGE_DAYS * 86400e3) return 'page';
  if (og.startsWith('article') || ld.some((t) => ARTICLE_LD.test(t)) || when) return 'article';
  if (og.startsWith('video') || ld.includes('VideoObject')) return 'video';
  if (og === 'profile' || ld.includes('ProfilePage')) return 'social';
  // No markup: a real article body on an article-shaped address still counts.
  const slug = (x.pathname.split('/').filter(Boolean).pop() || '').split(/[-_]+/).filter((w) => /[a-z]/i.test(w)).length;
  const shaped = ARTICLE_PATH.test(x.pathname) || slug >= 4;
  return shaped && (meta.readMinutes || 0) >= 2 && meta.tldr?.length ? 'article' : 'page';
}

/** The story a link belongs to: the page's own official address when it is on the same site. */
export function canonicalOf(url, meta) {
  const final = meta?.url || url, c = meta?.canonical;
  return c && c.startsWith('https://') && sameSite(c, final) ? c : final;
}

/**
 * Background reader. get(url) answers at once from memory; want(urls) queues
 * unknown links. fetchMeta(url) is the link-preview fetch (disk-cached), so a
 * link is read from the web at most once per cache lifetime.
 */
export function makeLinks({ fetchMeta, log = () => {}, max = 4000, concurrency = 2, retryMs = 6 * 3600e3 }) {
  const known = new Map(), queue = [], queued = new Set();
  let running = 0, waiters = [];

  function remember(url, rec) {
    known.delete(url); known.set(url, rec);
    if (known.size > max) known.delete(known.keys().next().value);
  }
  function get(url) {
    const r = known.get(url);
    if (r && r.failed && Date.now() - r.at > retryMs) { known.delete(url); return undefined; }
    return r;
  }
  function want(urls) {
    for (const u of urls) {
      if (known.has(u) && get(u)) continue;
      if (queued.has(u)) continue;
      const hk = hostKind(u);
      // Code, social, shop, audio and campaign hosts need no fetch; shorteners are followed and videos read for a title.
      if (hk && hk !== 'short' && hk !== 'video') { remember(u, { kind: hk, key: storyKey(u), url: u, site: siteOf(u) }); continue; }
      if (queue.length >= 600) break;
      queued.add(u); queue.push(u);
    }
    pump();
  }
  function pump() {
    while (running < concurrency && queue.length) {
      const u = queue.shift();
      running++;
      Promise.resolve().then(() => fetchMeta(u)).then((m) => {
        const canon = canonicalOf(u, m);
        remember(u, { kind: classify(u, m), key: storyKey(canon), url: canon, site: m.site || siteOf(canon), title: m.title || '', tldr: m.tldr || null,
          readMinutes: m.readMinutes || null, image: m.image || null, icon: m.icon || null, description: m.description || '' });
      }, (e) => {
        // A known host keeps its kind; a page that is not HTML (an image, a file) is not news.
        const kind = hostKind(u) || (e.status === 415 ? 'page' : 'unknown');
        remember(u, { kind, key: storyKey(u), url: u, site: siteOf(u), failed: true, at: Date.now() });
        log('links', `${siteOf(u)}: ${e.message}`);
      }).finally(() => {
        running--; queued.delete(u);
        if (queue.length) pump();
        else if (!running) { const w = waiters; waiters = []; w.forEach((f) => f()); }
      });
    }
  }
  /** Resolves when the queue is empty (tests and warm-up). */
  const idle = () => (running || queue.length ? new Promise((r) => waiters.push(r)) : Promise.resolve());
  return { get, want, idle, size: () => known.size, pending: () => queue.length + running };
}
