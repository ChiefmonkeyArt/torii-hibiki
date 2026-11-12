// ADR-0005: which shared links are news, which are the same story, and how stories rank.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventStore } from 'applesauce-core';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { HibikiEventDatabase } from '../src/eventdb.mjs';
import { hostKind, storyKey, sameSite, siteOf, classify, canonicalOf, makeLinks } from '../src/links.mjs';
import { makeFeed, commentLen, slugTitle, Rank, headWords, sameEvent } from '../src/feed.mjs';
import { makeSigner } from '../src/signer.mjs';
import { parseOg, ytId, makeProxies, cleanTitle } from '../src/proxy.mjs';

test('host kinds: videos, code, social, shops and shorteners are known without a fetch', () => {
  assert.equal(hostKind('https://www.youtube.com/watch?v=x'), 'video');
  assert.equal(hostKind('https://youtu.be/x'), 'video');
  assert.equal(hostKind('https://gist.github.com/a/b'), 'code');
  assert.equal(hostKind('https://x.com/a/status/1'), 'social');
  assert.equal(hostKind('https://primal.net/e/note1x'), 'social');
  assert.equal(hostKind('https://www.amazon.co.uk/dp/1'), 'shop');
  assert.equal(hostKind('https://bit.ly/abc'), 'short');
  assert.equal(hostKind('https://fanfares.io/s/x'), 'audio', 'music tracks are not news, even marked as articles');
  assert.equal(hostKind('https://www.change.org/p/x'), 'page');
  assert.equal(hostKind('https://www.bbc.co.uk/news/articles/x'), null);
  assert.equal(hostKind('https://notgithub.com/x'), null, 'suffix match is on whole labels');
});

test('story keys merge mobile, AMP and trailing-slash copies of one article', () => {
  const k = storyKey('https://www.news.example/world/story-1');
  for (const u of ['https://m.news.example/world/story-1/', 'https://amp.news.example/world/story-1/amp', 'https://news.example/world/story-1?outputType=amp', 'https://www.news.example/world/story-1.amp'])
    assert.equal(storyKey(u), k, u);
  assert.notEqual(storyKey('https://news.example/a?id=1'), storyKey('https://news.example/a?id=2'), 'meaningful query kept');
  assert.equal(siteOf('https://feeds.bbc.co.uk/x'), 'bbc.co.uk');
  assert.ok(sameSite('https://www.bbc.co.uk/a', 'https://bbc.co.uk/b'));
  assert.ok(!sameSite('https://evil.example/a', 'https://news.example/a'));
});

test('a canonical on another site is ignored, so a page cannot join someone else\'s story', () => {
  assert.equal(canonicalOf('https://news.example/a?x=1', { url: 'https://news.example/a?x=1', canonical: 'https://www.news.example/a' }), 'https://www.news.example/a');
  assert.equal(canonicalOf('https://spam.example/p', { url: 'https://spam.example/p', canonical: 'https://news.example/big-story' }), 'https://spam.example/p');
  assert.equal(canonicalOf('https://bit.ly/x', { url: 'https://news.example/final' }), 'https://news.example/final', 'shorteners resolve to where they lead');
});

test('classify: article markup, product pages, videos, homepages and unmarked long reads', () => {
  const u = 'https://site.example/2026/11/a-story';
  assert.equal(classify(u, { url: u, ogType: 'article' }), 'article');
  assert.equal(classify(u, { url: u, ld: ['NewsArticle', 'Person'] }), 'article');
  assert.equal(classify(u, { url: u, published: new Date().toISOString() }), 'article');
  assert.equal(classify(u, { url: u, ogType: 'product' }), 'shop');
  assert.equal(classify(u, { url: u, ogType: 'website', price: true }), 'shop');
  assert.equal(classify(u, { url: u, ogType: 'video.other' }), 'video');
  assert.equal(classify('https://site.example/', { url: 'https://site.example/', ogType: 'website', readMinutes: 4, tldr: ['x'] }), 'page', 'a homepage is not a story');
  assert.equal(classify(u, { url: u, readMinutes: 3, tldr: ['a', 'b', 'c'] }), 'article');
  assert.equal(classify(u, { url: u, readMinutes: 1 }), 'page');
  assert.equal(classify('https://apps.apple.com/us/app/x/id1', { url: 'https://apps.apple.com/us/app/x/id1', ld: ['SoftwareApplication', 'Offer'] }), 'shop');
  assert.equal(classify('https://bible.example/b/1', { url: 'https://bible.example/b/1', ogType: 'book', ld: ['Article'] }), 'page');
  assert.equal(classify('https://store.site.example/pages/a-big-anniversary-sale', { url: 'https://store.site.example/pages/a-big-anniversary-sale', readMinutes: 5, tldr: ['x'] }), 'page', 'shop subdomain');
  assert.equal(classify('https://site.example/raffle/', { url: 'https://site.example/raffle/', readMinutes: 2, tldr: ['x'] }), 'page');
  assert.equal(classify(u, { url: u, ogType: 'article', published: '2023-10-01T00:00:00Z' }, Date.parse('2026-11-12')), 'page', 'old by its own date');
  assert.equal(classify('https://site.example/hookstr/', { url: 'https://site.example/hookstr/', readMinutes: 3, tldr: ['x'] }), 'page', 'no markup and no article-shaped address');
  assert.equal(classify('https://site.example/news/x1', { url: 'https://site.example/news/x1', readMinutes: 3, tldr: ['x'] }), 'article');
  assert.equal(classify('https://bit.ly/x', { url: 'https://news.example/a', ogType: 'article' }), 'article', 'classified by where the shortener leads');
});

test('parseOg reads type, canonical, JSON-LD types, publish time and a raster icon', () => {
  const html = `<html><head><meta property="og:type" content="article"><meta property="article:published_time" content="2026-11-12T08:00:00Z">
    <link rel="icon" href="/favicon.svg"><link rel="apple-touch-icon" href="/touch.png"><link rel="canonical" href="https://www.news.example/a">
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"NewsArticle","author":{"@type":"Person"}}</script></head></html>`;
  const og = parseOg(html, 'https://m.news.example/a?utm=1');
  assert.equal(og.ogType, 'article'); assert.equal(og.canonical, 'https://www.news.example/a');
  assert.deepEqual(og.ld, ['NewsArticle', 'Person']); assert.equal(og.published, '2026-11-12T08:00:00Z');
  assert.equal(og.icon, 'https://m.news.example/touch.png');
  assert.equal(parseOg('<link rel="canonical" href="http://x.example/a">', 'https://x.example/a').canonical, '', 'https only');
});

test('background reader: one fetch per link, known hosts skipped, failures remembered, bounded', async () => {
  const calls = [];
  let live = 0, peak = 0;
  const links = makeLinks({
    concurrency: 2, max: 6,
    fetchMeta: async (u) => { calls.push(u); live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 5)); live--;
      if (u.includes('down')) throw new Error('timeout'); if (u.includes('pic')) throw Object.assign(new Error('not html'), { status: 415 }); return { url: u, ogType: 'article', title: 'T ' + u, site: 'Site' }; },
  });
  links.want(['https://a.example/1', 'https://a.example/1', 'https://b.example/2', 'https://www.youtube.com/watch?v=1', 'https://down.example/x']);
  await links.idle();
  assert.deepEqual([...calls].sort(), ['https://a.example/1', 'https://b.example/2', 'https://down.example/x', 'https://www.youtube.com/watch?v=1'].sort(), 'videos are read for their title; nothing twice');
  assert.ok(peak <= 2, 'concurrency cap');
  assert.equal(links.get('https://down.example/x').kind, 'unknown');
  links.want(['https://pic.example/a.bin', 'https://youtu.be/down']); await links.idle();
  assert.equal(links.get('https://pic.example/a.bin').kind, 'page', 'not HTML: not news');
  assert.equal(links.get('https://youtu.be/down').kind, 'video', 'a video host stays a video when its page fails');
  assert.equal(links.get('https://b.example/2').title, 'T https://b.example/2');
  const before = calls.length;
  links.want(['https://github.com/a/b', 'https://x.com/a']);
  await links.idle();
  assert.equal(calls.length, before, 'code and social hosts are never fetched');
  assert.equal(links.get('https://github.com/a/b').kind, 'code');
  assert.equal(links.size(), 6, 'memory is bounded (8 links seen, oldest dropped)');
});

test('comment length ignores links and mentions; slug titles need three words', () => {
  assert.equal(commentLen('https://a.example/x nostr:npub1abc'), 0);
  assert.equal(commentLen('This is worth a read https://a.example/x'), 'This is worth a read'.length);
  assert.equal(slugTitle('https://a.example/2026/11/big-storm-hits-coast-12345678'), 'Big storm hits coast');
  assert.equal(slugTitle('https://a.example/p/123'), '');
  assert.equal(slugTitle('https://a.example/news/4d09f9d7-de3b-4521-8b94-8dcf758aceb0'), '', 'an ID is not a headline');
  assert.equal(hostKind('https://donorbox.org/x'), 'page');
  assert.equal(classify('https://songs.example/t/my-new-track-is-out', { ogType: 'music.song', title: 'T' }), 'audio');
  assert.equal(classify('https://pod.example/ep/episode-twelve-is-here-now', { ld: ['PodcastEpisode'], published: new Date().toISOString() }), 'audio');
});

test('rerank can cap on a field other than the author', () => {
  const mk = (id, site, score) => ({ id, pubkey: 'p' + id, site, created_at: 0, f: { c: 1, d: score, a: 0 } });
  const out = Rank.rerank([mk(1, 'a', 9), mk(2, 'a', 8), mk(3, 'a', 7), mk(4, 'b', 1)], Rank.DEFAULTS, { perAuthor: 2, by: 'site' });
  assert.ok(out.slice(0, 3).some((x) => x.id === 4), 'the other site gets a top-three slot');
  assert.equal(out.at(-1).site, 'a', 'the third story from one site goes last');
  assert.ok(Rank.score({ c: 1, d: 1 }) > Rank.score({ c: 1, d: 0.35 }), 'a comment beats a bare share');
});

test('shop pages that call themselves articles are shops (v0.2.14)', () => {
  const now = Date.parse('2026-11-12T12:00:00Z'), pub = '2026-11-11T09:00:00Z';
  const page = '<meta property="og:type" content="article"><title>| Proof of Ink</title>' + '<a class="add_to_cart_button">Add to cart</a>'.repeat(3);
  const og = parseOg(page, 'https://ink.example/stackchain-magazine');
  assert.equal(og.cart, true, 'three cart buttons are noticed');
  assert.equal(parseOg('<meta property="og:type" content="article"><p>Add to cart</p>', 'https://a.example/x').cart, false, 'one stray button is not a shop');
  assert.equal(classify('https://ink.example/stackchain-magazine', { ...og, published: pub }, now), 'shop');
  assert.equal(classify('https://ink.example/m', { ogType: 'article', published: pub, tldr: ['Stackchain Magazine 4-6 Add to cart $63.00'] }, now), 'shop', 'cached previews: the summary gives it away');
  assert.equal(classify('https://news.example/2026/11/a-real-story-here', { ogType: 'article', published: pub, tldr: ['Prices rose again.'] }, now), 'article');
});

test('titles drop the site name and stray separators, never the headline (v0.2.14)', () => {
  const c = (t, site, host) => cleanTitle(t, site, `https://${host}/x`);
  assert.equal(c('Wegen Steuererhöhungen: Aufstand - Apollo News', 'Apollo News', 'apollo-news.net'), 'Wegen Steuererhöhungen: Aufstand');
  assert.equal(c('Bitcoin vs Stocks | bitcoin.rocks', 'bitcoin.rocks', 'bitcoin.rocks'), 'Bitcoin vs Stocks');
  assert.equal(c('| Proof of Ink', 'proofofink.com', 'proofofink.com'), 'Proof of Ink');
  assert.equal(c('The TikTok to OnlyFans Pipeline | CEASE report', 'CEASE', 'cease.org.uk'), 'The TikTok to OnlyFans Pipeline');
  assert.equal(c('Cyberattack Took 7 Minutes \u2014 BigGo Finance', 'BigGo Finance', 'finance.biggo.com'), 'Cyberattack Took 7 Minutes');
  assert.equal(c('BBC News - Storm hits Cornwall', 'BBC News', 'www.bbc.co.uk'), 'Storm hits Cornwall');
  assert.equal(c('Bitcoin - the next decade', 'Bitcoin Magazine', 'bitcoinmagazine.com'), 'Bitcoin - the next decade', 'a leading word that only starts the site name stays');
  assert.equal(c('Yahoo Finance', 'Yahoo Finance', 'finance.yahoo.com'), 'Yahoo Finance', 'a title that is only the site name is kept');
  assert.equal(c('Fish-and-chips prices rise', 'Fish', 'fish.example'), 'Fish-and-chips prices rise', 'hyphens inside words are not separators');
});

test('a site you trust ranks higher and says why; stories cap by domain (v0.2.13)', () => {
  const f = { c: 1, d: 1, a: 0 };
  assert.ok(Rank.score({ ...f, t: 1 }) > Rank.score(f), 'trusted outranks the same story untrusted');
  assert.ok(Rank.explain({ ...f, t: 1 }).reasons.some((r) => r.key === 'trusted' && r.label === 'A site you trust'));
  assert.ok(!Rank.explain(f).reasons.some((r) => r.key === 'trusted'), 'no reason shown when not trusted');
  const mk = (id, domain) => ({ id, pubkey: 'p' + id, domain, site: 'Same name', created_at: 0, f: { c: 1, d: 5 - id, a: 0 } });
  const out = Rank.rerank([mk(1, 'a.com'), mk(2, 'a.com'), mk(3, 'a.com'), mk(4, 'b.com')], Rank.DEFAULTS, { perAuthor: 2, by: 'domain' });
  assert.ok(out.slice(0, 3).some((x) => x.id === 4), 'two sites that share a display name are still capped apart');
  assert.equal(out.at(-1).domain, 'a.com', 'the third story from one domain goes last');
});

test('News: only articles, grouped by official address, best comment first, one site capped, code and videos moved', async () => {
  const ownerSk = generateSecretKey(), owner = getPublicKey(ownerSk);
  const keys = Array.from({ length: 4 }, () => generateSecretKey()), pks = keys.map(getPublicKey);
  const db = new HibikiEventDatabase(':memory:'), store = new EventStore({ database: db });
  const t = Math.floor(Date.now() / 1000) - 600;
  const post = (k, content, dt = 0) => store.add(finalizeEvent({ kind: 1, created_at: t - dt, tags: [], content }, k));
  const A = 'https://www.news.example/world/storm', A_AMP = 'https://amp.news.example/world/storm/amp';
  post(keys[0], `Huge storm on the coast, stay safe ${A}`);
  post(keys[1], A_AMP);
  post(keys[2], 'https://shop.example/item/1');
  post(keys[3], 'https://www.youtube.com/watch?v=abc');
  post(keys[3], 'Nice library https://github.com/acme/widget');
  for (let i = 1; i <= 3; i++) post(keys[i % 4], `Read this one, it is good https://big.example/news/story-${i}`, i);
  post(keys[0], 'https://small.example/2026/11/quiet-but-good-story', 30);
  post(keys[2], 'https://homepage.example/');
  const meta = {
    [A]: { ogType: 'article', canonical: 'https://news.example/world/storm', title: 'Storm hits the coast', site: 'News', tldr: ['A storm hit.'], readMinutes: 3 },
    [A_AMP]: { ogType: 'article', canonical: 'https://news.example/world/storm', title: 'Storm hits the coast', site: 'News' },
    'https://shop.example/item/1': { ogType: 'product', title: 'Buy' },
    'https://homepage.example/': { ogType: 'website', title: 'Home' },
    'https://www.youtube.com/watch?v=abc': { ogType: 'video.other', title: 'A video' },
  };
  for (let i = 1; i <= 3; i++) meta[`https://big.example/news/story-${i}`] = { ogType: 'article', title: 'Big ' + i, site: 'Big' };
  meta['https://small.example/2026/11/quiet-but-good-story'] = { ogType: 'article', title: 'Quiet', site: 'Small' };
  const links = makeLinks({ fetchMeta: async (u) => ({ url: u, ...meta[u] }) });
  const ingest = { graph: { follows: new Set(pks), hop2: new Map(), mutes: new Set(), updated: Date.now() } };
  const feed = makeFeed({ cfg: { owner }, store, ingest, signer: makeSigner('ab'.repeat(32)), links });
  feed.warmLinks(); await links.idle();
  const d = feed.section('news');
  const sites = d.clusters.map((c) => c.site);
  assert.ok(!sites.includes('shop.example') && !sites.includes('homepage.example') && !sites.includes('youtube.com'), 'only articles');
  const storm = d.clusters.find((c) => c.meta.title === 'Storm hits the coast');
  assert.equal(d.clusters.filter((c) => c.meta.title === 'Storm hits the coast').length, 1, 'AMP copy merged');
  assert.equal(storm.shared, 2); assert.equal(storm.inCircle, 2);
  assert.equal(storm.notes[0].pubkey, pks[0], 'the comment leads, the bare share follows');
  assert.equal(storm.meta.tldr, 'A storm hit.'); assert.equal(storm.meta.readMinutes, 3);
  assert.ok(d.clusters.slice(0, 3).filter((c) => c.site === 'Big').length <= 2, 'no site fills the top');
  assert.deepEqual([...d.dev].map((x) => x.title), ['acme/widget']);
  const w = feed.section('watch');
  assert.deepEqual([...w.shared].map((x) => x.url), ['https://www.youtube.com/watch?v=abc'], 'video links move to Watch');
  assert.ok(feed.section('today').news.length > 0);
});

test('News before links are read: shown as pending with a slug headline; unreadable links need two sharers', async () => {
  const owner = getPublicKey(generateSecretKey()), k = generateSecretKey(), k2 = generateSecretKey();
  const db = new HibikiEventDatabase(':memory:'), store = new EventStore({ database: db });
  const t = Math.floor(Date.now() / 1000) - 60;
  store.add(finalizeEvent({ kind: 1, created_at: t, tags: [], content: 'https://slow.example/2026/big-storm-hits-coast' }, k));
  store.add(finalizeEvent({ kind: 1, created_at: t, tags: [], content: 'https://down.example/one-sharer-only-here' }, k));
  store.add(finalizeEvent({ kind: 1, created_at: t, tags: [], content: 'https://accounts.example/signup' }, k2));
  const ingest = { graph: { follows: new Set([getPublicKey(k), getPublicKey(k2)]), hop2: new Map(), mutes: new Set(), updated: Date.now() } };
  let release;
  const gate = new Promise((r) => { release = r; });
  const links = makeLinks({ fetchMeta: async (u) => { await gate; throw new Error('down'); } });
  const feed = makeFeed({ cfg: { owner }, store, ingest, signer: makeSigner('ab'.repeat(32)), links });
  let d = feed.section('news');
  assert.equal(d.clusters.length, 2, 'an address that reads like no headline waits until it is read');
  assert.ok(d.clusters.every((c) => c.meta.pending === 1));
  assert.ok(d.clusters.some((c) => c.meta.title === 'Big storm hits coast'));
  release(); await links.idle();
  d = feed.section('news');
  assert.equal(d.clusters.length, 0, 'unreadable, one sharer each: left out');
});

test('YouTube addresses map to a video id; cached previews are signed when read', async () => {
  assert.equal(ytId('https://youtu.be/dQw4w9WgXcQ?t=3'), 'dQw4w9WgXcQ');
  assert.equal(ytId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(ytId('https://music.youtube.com/watch?v=dQw4w9WgXcQ&si=x'), 'dQw4w9WgXcQ');
  assert.equal(ytId('https://youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(ytId('https://www.youtube.com/@someone'), null);
  assert.equal(ytId('https://notyoutube.com/watch?v=dQw4w9WgXcQ'), null);
  const raw = { url: 'https://a.example/x', title: 'T', image: 'https://a.example/i.jpg', icon: null };
  const cache = { get: async () => Buffer.from(JSON.stringify(raw)), put: async () => {} };
  const signer = makeSigner('ab'.repeat(32));
  const out = await makeProxies({ signer, cache, imager: null }).link(raw.url);
  assert.equal(out.image, signer.img(raw.image, 640), 'signed with the current secret');
  assert.equal(raw.image, 'https://a.example/i.jpg', 'the cached copy stays raw');
});

test('one event across outlets folds into one story; topics come from the notes', async () => {
  const w = (t) => headWords(t);
  assert.ok(sameEvent(w('LNbits urges all operators to shut down after attack'), w('LNbits orders emergency shutdown of operators after attack')));
  assert.ok(!sameEvent(w('Bitcoin price falls after US inflation data'), w('Bitcoin Core publishes three security fixes')), 'one shared word is not one event');
  assert.ok(!sameEvent(w('The news of the day'), w('The news of the week')), 'stop words do not count');
  const owner = getPublicKey(generateSecretKey()), keys = Array.from({ length: 3 }, () => generateSecretKey()), pks = keys.map(getPublicKey);
  const db = new HibikiEventDatabase(':memory:'), store = new EventStore({ database: db });
  const t = Math.floor(Date.now() / 1000) - 300;
  const post = (k, content, tags = []) => store.add(finalizeEvent({ kind: 1, created_at: t, tags, content }, k));
  const A = 'https://one.example/2026/lnbits-urges-operators-shut-down', B = 'https://two.example/news/lnbits-emergency-shutdown', C = 'https://three.example/p/unrelated-story-about-gardens';
  post(keys[0], `LNbits users, read this now ${A}`, [['t', 'Lightning']]);
  post(keys[1], `Shut it down until patched ${B}`, [['t', 'security']]);
  post(keys[2], `Something else entirely, lovely read ${C}`);
  const meta = {
    [A]: { ogType: 'article', title: 'LNbits urges all operators to shut down after attack', site: 'One' },
    [B]: { ogType: 'article', title: 'LNbits orders emergency shutdown of operators after attack', site: 'Two' },
    [C]: { ogType: 'article', title: 'A quiet story about community gardens', site: 'Three' },
  };
  const links = makeLinks({ fetchMeta: async (u) => ({ url: u, ...meta[u] }) });
  const ingest = { graph: { follows: new Set(pks), hop2: new Map(), mutes: new Set(), updated: Date.now() } };
  const feed = makeFeed({ cfg: { owner }, store, ingest, signer: makeSigner('ab'.repeat(32)), links });
  feed.warmLinks(); await links.idle();
  const d = feed.section('news');
  assert.equal(d.clusters.length, 2, 'two outlets, one story; the unrelated one stays');
  const s = d.clusters.find((c) => /LNbits/.test(c.meta.title));
  assert.equal(s.outlets.length, 1); assert.equal(s.shared, 2, 'sharers of both outlets count');
  assert.deepEqual([...s.topics].sort(), ['lightning', 'security']);
  assert.equal(s.notes.length, 2); assert.ok(s.domain.endsWith('.example'));
});
