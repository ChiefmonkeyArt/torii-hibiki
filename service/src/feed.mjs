// feed.mjs — turns stored events into section feeds with feature vectors.
// The node computes public features; the browser applies private weights.
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { nip19 } from 'nostr-tools';
import { isRootNote, replyRefs, extract, hashtags, parseProfile, zapSats, tag } from './nostr.mjs';
import { hostKind, storyKey, siteOf } from './links.mjs';

const ctx = {};
vm.runInNewContext(fs.readFileSync(new URL('../../web/rank.js', import.meta.url), 'utf8'), ctx);
export const Rank = ctx.HibikiRank;

const H = 3600;
const SECTIONS = ['today', 'circle', 'news', 'watch', 'listen', 'read'];
const MENTION = /nostr:(npub1[02-9ac-hj-np-z]{58}|nprofile1[02-9ac-hj-np-z]+|note1[02-9ac-hj-np-z]{58}|nevent1[02-9ac-hj-np-z]+|naddr1[02-9ac-hj-np-z]+)/g;

/**
 * Reply order everywhere (peek and panel): people you follow first, then by
 * popularity (likes + 2x reposts + 2x replies + zaps on a log scale), then oldest
 * first so conversations read in order when nothing stands out.
 */
export function replyScore(r) {
  return (r.likes || 0) + 2 * (r.reposts || 0) + 2 * (r.replies || 0) + Math.log10(1 + (r.zaps || 0));
}
export function orderReplies(list) {
  return list.slice().sort((a, b) => (b.circle ? 1 : 0) - (a.circle ? 1 : 0) || replyScore(b) - replyScore(a) || a.created_at - b.created_at);
}

export function spamScore(ev, dupes) {
  let s = 1;
  const tags = ev.tags.filter((t) => t[0] === 't').length;
  const ps = ev.tags.filter((t) => t[0] === 'p').length;
  const text = (ev.content || '').replace(/https?:\/\/\S+/g, '').trim();
  if (tags > 6) s *= 0.5;
  if (ps > 8) s *= 0.3;
  if (ev.kind === 1 && text.length < 3 && !/https:\/\//.test(ev.content)) s *= 0.3;
  if ((ev.content.match(/https?:\/\//g) || []).length > 5) s *= 0.5;
  if (dupes && dupes > 1) s *= 0.2;
  return s;
}

/** Words someone added beyond the links and mentions: a share with a comment counts more than a bare one. */
export const commentLen = (content) => (content || '').replace(/https?:\/\/\S+|nostr:\S+/g, '').replace(/\s+/g, ' ').trim().length;
/** A readable headline from the address when the page could not be read. */
export function slugTitle(u) {
  try {
    const seg = new URL(u).pathname.split('/').filter(Boolean).pop() || '';
    const t = decodeURIComponent(seg).replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[-_+]+/g, ' ').replace(/\b\d{5,}\b/g, '')
      .split(' ').filter((w) => w && !(/\d/.test(w) && /^[0-9a-f]{4,}$/i.test(w))).join(' ');
    return t.split(' ').filter((w) => /[a-z]{2}/i.test(w)).length >= 3 ? t[0].toUpperCase() + t.slice(1, 160) : '';
  } catch { return ''; }
}

// Words that say nothing about which event a headline is about (en, de, fr, es).
const STOP = new Set(('the and for with from that this what when where which into over after about than more says said will can have has not but you your our are was were its how why who new news live update '
  + 'der die das und den dem des ein eine einer mit von fur ist im auf nicht sich als auch nach bei aus zum zur wie '
  + 'les des une pour dans sur par pas est qui que avec '
  + 'los las del una por para con que est').split(' '));
/** The distinctive words of a headline, for telling when two outlets cover one event. */
const NO_TOPIC = new Set(['uncategorized', 'uncategorised', 'news', 'nostr', 'general', 'misc', 'other']);

export function headWords(t) {
  return new Set(String(t || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !STOP.has(w)));
}
/** Same event: at least 3 distinctive words shared, covering half of the shorter headline. */
export function sameEvent(a, b) {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n >= 3 && n / Math.min(a.size, b.size) >= 0.5;
}

export function makeFeed({ cfg, store, ingest, signer, links = null }) {
  const g = ingest.graph;
  const now = () => Math.floor(Date.now() / 1000);

  function profile(pk) {
    const ev = store.getReplaceable(0, pk);
    const p = ev ? parseProfile(ev) : { name: '', about: '', picture: '', nip05: '' };
    return { name: p.name || nip19.npubEncode(pk).slice(0, 12) + '…', about: p.about, nip05: p.nip05, lud16: p.lud16 || '', zap: !!(p.lud16 || p.lud06), pic: p.picture ? signer.img(p.picture, 96) : null, npub: nip19.npubEncode(pk) };
  }

  /** Engagement on a set of ids, split into circle and wider audience. */
  function engagement(ids) {
    const m = new Map(ids.map((id) => [id, { ce: new Set(), ge: 0, z: 0, rp: 0, replies: 0, via: [], me: {} }]));
    if (!ids.length) return m;
    const set = new Set(ids);
    for (let i = 0; i < ids.length; i += 200) {
      for (const e of store.getByFilters({ kinds: [7, 6, 9735, 1], '#e': ids.slice(i, i + 200) })) {
        let target = null;
        if (e.kind === 1) { const r = replyRefs(e); target = set.has(r.reply) ? r.reply : set.has(r.root) ? r.root : null; }
        else { const es = e.tags.filter((t) => t[0] === 'e'); target = es.length ? es[es.length - 1][1] : null; }
        const x = target && m.get(target);
        if (!x) continue;
        let who = e.pubkey, sats = 0;
        if (e.kind === 9735) { sats = zapSats(e); try { who = JSON.parse(tag(e, 'description') || '{}').pubkey || who; } catch {} }
        if (e.kind === 1) { x.replies++; continue; }
        if (e.kind === 7 && e.content === '-') continue;
        x.ge += e.kind === 6 ? 2 : 1;
        x.z += sats;
        if (e.kind === 6) x.rp++;
        // The owner's own likes and reposts mark the post as theirs but do not
        // boost it: liking something must not reshuffle your own feed.
        if (who === cfg.owner) { if (e.kind === 7) x.me.l = 1; else if (e.kind === 6) x.me.r = 1; continue; }
        if (g.follows.has(who)) {
          if (!x.ce.has(who)) x.via.push({ pk: who, how: e.kind === 6 ? 'reposted' : e.kind === 9735 ? 'zapped' : 'liked' });
          x.ce.add(who);
        }
      }
    }
    return m;
  }

  function quoteRefs(content) {
    const out = [];
    for (const m of (content || '').matchAll(MENTION)) {
      try {
        const d = nip19.decode(m[1]);
        if (d.type === 'note') out.push(d.data);
        else if (d.type === 'nevent') out.push(d.data.id);
      } catch {}
    }
    return out.slice(0, 2);
  }
  function mentionPks(content) {
    const out = new Set();
    for (const m of (content || '').matchAll(MENTION)) {
      try { const d = nip19.decode(m[1]); if (d.type === 'npub') out.add(d.data); else if (d.type === 'nprofile') out.add(d.data.pubkey); } catch {}
    }
    return out;
  }

  function mediaOut(list) {
    return list.map((x) => ({
      type: x.type,
      alt: x.alt,
      dim: x.dim,
      src: x.type === 'image' ? signer.img(x.url, 640) : signer.media(x.url),
      full: x.type === 'image' ? signer.img(x.url, 1080) : null,
      thumb: x.thumb ? signer.img(x.thumb, 640) : null,
    }));
  }

  /** Core item shape shared by every section. */
  function item(ev, eng, dupes, extra = {}) {
    const { media, links } = extract(ev);
    const e = eng.get(ev.id) || { ce: new Set(), ge: 0, z: 0, rp: 0, replies: 0, via: [], me: {} };
    const cw = ev.tags.find((t) => t[0] === 'content-warning');
    const limit = ev.kind === 30023 ? 1200 : 4000;
    return {
      id: ev.id, kind: ev.kind, pubkey: ev.pubkey, created_at: ev.created_at,
      content: ev.kind === 30023 ? (tag(ev, 'summary') || ev.content).slice(0, limit) : ev.content.slice(0, limit),
      title: tag(ev, 'title')?.slice(0, 200) || null,
      image: ev.kind === 30023 && tag(ev, 'image')?.startsWith('https://') ? signer.img(tag(ev, 'image'), 1080) : null,
      d: ev.kind >= 30000 ? tag(ev, 'd') || '' : undefined,
      t: hashtags(ev),
      cw: cw ? (cw[1] || 'sensitive').slice(0, 80) : null,
      media: mediaOut(media),
      links: links.map((url) => ({ url, sig: signer.link(url) })),
      quotes: quoteRefs(ev.content),
      replies: e.replies,
      via: e.via.slice(0, 3),
      me: e.me.l || e.me.r ? e.me : undefined,
      f: { c: g.follows.has(ev.pubkey) || ev.pubkey === cfg.owner ? 1 : 0, h: g.hop2.get(ev.pubkey) || 0, ce: e.ce.size, ge: e.ge, z: e.z, a: Math.max(0, (now() - ev.created_at) / H), s: spamScore(ev, dupes.get(hashText(ev))), m: media.length ? 1 : 0, l: links.length ? 1 : 0 },
      ...extra,
    };
  }

  const hashText = (ev) => crypto.createHash('sha1').update((ev.content || '').trim().toLowerCase()).digest('base64').slice(0, 12);

  function candidates(kinds, sinceH, authors) {
    const since = now() - sinceH * H;
    const evs = store.getByFilters({ kinds, since, authors, limit: 3000 });
    return evs.filter((e) => !g.mutes.has(e.pubkey));
  }

  /** Original posts and reposts of originals from the circle (+2-hop explore). */
  function circleItems(sinceH = 48) {
    const authors = [cfg.owner, ...g.follows, ...g.hop2.keys()];
    const evs = candidates([1, 6, 20], sinceH, authors);
    const roots = [], reposted = new Map();
    for (const e of evs) {
      if (e.kind === 6) {
        const id = e.tags.find((t) => t[0] === 'e')?.[1];
        if (!id) continue;
        let inner = store.getEvent(id);
        if (!inner) { try { const j = JSON.parse(e.content); if (j && j.id === id && j.kind === 1) inner = j; } catch {} }
        if (inner && isRootNote(inner) && !g.mutes.has(inner.pubkey)) {
          if (!reposted.has(inner.id)) reposted.set(inner.id, { ev: inner, by: [] });
          if (g.follows.has(e.pubkey)) reposted.get(inner.id).by.push(e.pubkey);
        }
      } else if (e.kind === 20 || isRootNote(e)) roots.push(e);
    }
    const all = new Map(roots.map((e) => [e.id, e]));
    for (const [id, r] of reposted) if (!all.has(id)) all.set(id, r.ev);
    const list = [...all.values()];
    const dupes = new Map();
    for (const e of list) { const h = hashText(e); dupes.set(h, (dupes.get(h) || 0) + 1); }
    const eng = engagement(list.map((e) => e.id));
    return list.map((e) => {
      const it = item(e, eng, dupes);
      const rp = reposted.get(e.id);
      if (rp && rp.by.length) { it.repostedBy = rp.by.slice(0, 3); it.f.c = 1; it.f.ce += rp.by.length; }
      return it;
    });
  }

  /** Replies to `id` (direct or in its thread), muted authors removed. */
  function repliesTo(id, limit) {
    return store.getByFilters({ kinds: [1], '#e': [id], limit })
      .filter((r) => { const x = replyRefs(r); return (x.reply === id || x.root === id) && !g.mutes.has(r.pubkey); });
  }
  function replyOut(r, eng, parent) {
    const e = eng.get(r.id) || { ge: 0, rp: 0, replies: 0, z: 0 };
    const circle = g.follows.has(r.pubkey) || r.pubkey === cfg.owner;
    return { id: r.id, pubkey: r.pubkey, created_at: r.created_at, parent, circle, likes: e.ge - 2 * e.rp, reposts: e.rp, replies: e.replies, zaps: e.z, s: spamScore(r) };
  }

  /** Two best replies for the inline peek: people you know first, then the most popular. */
  function peekAll(items) {
    const per = new Map(items.map((it) => [it.id, repliesTo(it.id, 120)]));
    const eng = engagement([...per.values()].flat().map((r) => r.id));
    for (const it of items) {
      const rs = per.get(it.id).map((r) => ({ ...replyOut(r, eng, replyRefs(r).reply), content: r.content.slice(0, 400) })).filter((r) => r.s >= 0.5 && r.parent === it.id);
      it.peek = orderReplies(rs).slice(0, 2).map(({ s, ...r }) => r);
    }
  }

  function withProfiles(items, extraPks = []) {
    const pks = new Set(extraPks);
    for (const it of items) {
      pks.add(it.pubkey);
      for (const v of it.via || []) pks.add(v.pk);
      for (const p of it.repostedBy || []) pks.add(p);
      for (const r of it.peek || []) pks.add(r.pubkey);
      for (const s of it.sharers || []) pks.add(s);
      for (const p of mentionPks(it.content)) pks.add(p);
      for (const n of it.notes || []) pks.add(n.pubkey);
    }
    const profiles = {};
    for (const pk of pks) profiles[pk] = profile(pk);
    return profiles;
  }

  function quoted(items) {
    const q = {};
    for (const it of items) for (const id of it.quotes || []) {
      const ev = store.getEvent(id);
      if (ev && ev.kind === 1) q[id] = { id, pubkey: ev.pubkey, created_at: ev.created_at, content: ev.content.slice(0, 600), media: mediaOut(extract(ev).media.slice(0, 1)) };
    }
    return q;
  }

  function top(items, n = 120) {
    return Rank.rerank(items, Rank.DEFAULTS).slice(0, n);
  }

  /**
   * Shared links grouped into stories (ADR-0005). Only articles reach News;
   * videos go to Watch and code to the Dev strip; shops, social posts and other
   * pages are left out. Links not read yet count as articles until they are;
   * a link nobody could read needs two sharers and a readable address.
   */
  const richness = (r) => (!r || r.failed ? 0 : 1 + (r.title ? 1 : 0) + (r.tldr ? 2 : 0) + (r.image ? 1 : 0));
  function linkStories(sinceH, want = 'article') {
    const items = circleItems(sinceH).filter((it) => it.links.length);
    links?.want([...new Set(items.flatMap((it) => it.links.map((l) => l.url)))]);
    const groups = new Map(), dev = new Map();
    for (const it of items) {
      const said = commentLen(it.content) >= 20;
      for (const l of it.links) {
        const rec = links?.get(l.url);
        const kind = rec ? rec.kind : hostKind(l.url) || 'pending';
        if (kind === 'code' && want === 'article') {
          const k = storyKey(l.url);
          if (!dev.has(k)) dev.set(k, { url: l.url, sig: l.sig, title: new URL(l.url).pathname.split('/').filter(Boolean).slice(0, 2).join('/') || siteOf(l.url), site: siteOf(l.url), sharers: [], created_at: 0 });
          const d = dev.get(k); if (!d.sharers.includes(it.pubkey)) d.sharers.push(it.pubkey); d.created_at = Math.max(d.created_at, it.created_at);
          continue;
        }
        const ok = want === 'article' ? kind === 'article' || kind === 'pending' || kind === 'unknown' : kind === want;
        if (!ok) continue;
        const key = rec?.key || storyKey(l.url);
        if (!groups.has(key)) groups.set(key, { key, url: l.url, sig: l.sig, kind, rec, sharers: new Map(), notes: [], topics: new Set(), f: { c: 0, h: 0, ce: 0, ge: 0, z: 0, a: Infinity, s: 0, d: 0, m: 0 } });
        const c = groups.get(key);
        // Several addresses for one story: keep the copy the node read best.
        if (richness(rec) > richness(c.rec)) { c.rec = rec; c.url = l.url; c.sig = l.sig; c.kind = kind; }
        const share = (pk, worth) => {
          const w = worth * (g.follows.has(pk) || pk === cfg.owner ? 1 : 0.5);
          c.sharers.set(pk, Math.max(c.sharers.get(pk) || 0, w));
        };
        share(it.pubkey, said ? 1 : 0.35);
        for (const pk of it.repostedBy || []) share(pk, 0.35);
        for (const t of it.t || []) { const v = String(t).toLowerCase().slice(0, 40); if (c.topics.size < 12 && !NO_TOPIC.has(v)) c.topics.add(v); }
        if (said && c.notes.length < 8) c.notes.push({ id: it.id, pubkey: it.pubkey, content: it.content.slice(0, 280), created_at: it.created_at });
        else if (c.notes.length < 8 && !c.notes.some((n) => n.pubkey === it.pubkey)) c.notes.push({ id: it.id, pubkey: it.pubkey, content: it.content.slice(0, 280), created_at: it.created_at, bare: 1 });
        const f = c.f;
        f.c = f.c || it.f.c; f.h = Math.max(f.h, it.f.h); f.ce += it.f.ce; f.ge += it.f.ge; f.z += it.f.z; f.a = Math.min(f.a, it.f.a); f.s = Math.max(f.s, it.f.s);
      }
    }
    // One event, several outlets: fold the smaller stories into the most shared one.
    const titled = [...groups.values()].filter((c) => c.rec?.title && c.kind === 'article').map((c) => ({ c, w: headWords(c.rec.title), d: siteOf(c.url) }));
    titled.sort((a, b) => b.c.sharers.size - a.c.sharers.size);
    for (let i = 0; i < titled.length; i++) {
      const A = titled[i];
      if (A.gone || A.w.size < 3) continue;
      for (let j = i + 1; j < titled.length; j++) {
        const B = titled[j];
        if (B.gone || B.d === A.d || B.w.size < 3 || !sameEvent(A.w, B.w)) continue;
        B.gone = true;
        const a = A.c, b = B.c;
        (a.outlets ||= []).push({ site: b.rec.site || B.d, domain: B.d, url: b.url, sig: b.sig, title: b.rec.title });
        for (const [pk, w] of b.sharers) a.sharers.set(pk, Math.max(a.sharers.get(pk) || 0, w));
        for (const n of b.notes) if (!a.notes.some((x) => x.id === n.id)) a.notes.push(n);
        for (const t of b.topics) a.topics.add(t);
        a.f.ce += b.f.ce; a.f.ge += b.f.ge; a.f.z += b.f.z; a.f.a = Math.min(a.f.a, b.f.a); a.f.h = Math.max(a.f.h, b.f.h);
        groups.delete(b.key);
      }
    }
    const stories = [];
    for (const c of groups.values()) {
      // A link nobody could read needs a second sharer before it is shown.
      if (c.kind === 'unknown' && (c.sharers.size < 2 || !slugTitle(c.url))) continue;
      // Not read yet: show it only if the address itself reads like a headline.
      if (c.kind === 'pending' && !slugTitle(c.url)) continue;
      const r = c.rec || {};
      const pks = [...c.sharers.keys()].sort((a, b) => c.sharers.get(b) - c.sharers.get(a));
      c.f.d = [...c.sharers.values()].reduce((a, b) => a + b, 0);
      c.f.m = r.image ? 1 : 0;
      // Best note first: comments before bare shares, circle before others.
      const notes = c.notes.sort((a, b) => (a.bare || 0) - (b.bare || 0) || (c.sharers.get(b.pubkey) || 0) - (c.sharers.get(a.pubkey) || 0)).slice(0, 8);
      stories.push({
        id: c.sig, url: c.url, sig: c.sig, pubkey: pks[0], site: r.site || siteOf(r.url || c.url), domain: siteOf(c.url),
        topics: [...c.topics].slice(0, 6), outlets: (c.outlets || []).slice(0, 5),
        created_at: Math.max(...c.notes.map((n) => n.created_at), 0) || now() - Math.round(c.f.a * H),
        sharers: pks.slice(0, 8), shared: pks.length, inCircle: pks.filter((pk) => g.follows.has(pk) || pk === cfg.owner).length, notes: notes.map(({ bare, ...n }) => n),
        meta: c.rec && !c.rec.failed ? { site: r.site, title: r.title, tldr: r.tldr?.[0] || r.description?.slice(0, 200) || '', readMinutes: r.readMinutes, image: r.image, icon: r.icon }
          : { site: siteOf(c.url), title: slugTitle(c.url), tldr: '', readMinutes: null, image: null, icon: null, pending: c.rec ? 0 : 1 },
        f: c.f,
      });
    }
    for (const d of dev.values()) d.pubkey = d.sharers[0];
    return { stories, dev: [...dev.values()].sort((a, b) => b.sharers.length - a.sharers.length || b.created_at - a.created_at) };
  }

  /** Queue this window's links for a background read (called after each sync). */
  function warmLinks() { if (links) linkStories(72); }

  const builders = {
    circle() {
      const items = top(circleItems(), 150);
      peekAll(items.slice(0, 60));
      return { items };
    },
    news() {
      const { stories, dev } = linkStories(72);
      const sorted = Rank.rerank(stories, Rank.DEFAULTS, { perAuthor: 2, by: 'domain' }).slice(0, 60);
      const curators = store.getByFilters({ kinds: [30004], authors: [...g.follows], limit: 40 })
        .map((e) => ({ id: e.id, pubkey: e.pubkey, title: (tag(e, 'title') || tag(e, 'd') || '').slice(0, 80), size: e.tags.filter((t) => t[0] === 'a' || t[0] === 'e').length }))
        .filter((c) => c.size > 0).slice(0, 12);
      return { clusters: sorted, curators, dev: dev.slice(0, 6) };
    },
    watch() {
      const vids = candidates([1, 21, 22], 7 * 24, [cfg.owner, ...g.follows, ...g.hop2.keys()])
        .filter((e) => (e.kind !== 1 || isRootNote(e)) && extract(e).media.some((m) => m.type === 'video'));
      const eng = engagement(vids.map((e) => e.id));
      const live = store.getByFilters({ kinds: [30311], authors: [...g.follows], since: now() - 12 * H, limit: 50 })
        .filter((e) => tag(e, 'status') === 'live')
        .map((e) => ({ id: e.id, pubkey: e.pubkey, created_at: e.created_at, title: (tag(e, 'title') || 'Live').slice(0, 120), image: tag(e, 'image')?.startsWith('https://') ? signer.img(tag(e, 'image'), 640) : null, viewers: Number(tag(e, 'current_participants')) || null, f: { c: 1, a: 0, ce: 0, ge: 0, z: 0 } }));
      const shared = Rank.rerank(linkStories(72, 'video').stories, Rank.DEFAULTS, { perAuthor: 2, by: 'domain' }).slice(0, 8);
      return { items: top(vids.map((e) => item(e, eng, new Map())), 60), live, shared };
    },
    listen() {
      const evs = candidates([1], 7 * 24, [cfg.owner, ...g.follows, ...g.hop2.keys()])
        .filter((e) => isRootNote(e) && extract(e).media.some((m) => m.type === 'audio'));
      const eng = engagement(evs.map((e) => e.id));
      return { items: top(evs.map((e) => item(e, eng, new Map())), 60) };
    },
    read() {
      const arts = candidates([30023], 30 * 24, [cfg.owner, ...g.follows, ...g.hop2.keys()]);
      const eng = engagement(arts.map((e) => e.id));
      const items = top(arts.map((e) => item(e, eng, new Map())), 60);
      const hl = store.getByFilters({ kinds: [9802], authors: [...g.follows], limit: 60 })
        .map((e) => ({ id: e.id, pubkey: e.pubkey, created_at: e.created_at, text: e.content.slice(0, 400), source: (tag(e, 'r') || '').startsWith('https://') ? tag(e, 'r') : null, a: tag(e, 'a') || null }));
      return { items, highlights: hl.slice(0, 30) };
    },
    today() {
      const c = builders.circle().items;
      const best = c.filter((x) => x.f.ce > 0 || x.f.m).slice(0, 12);
      const r = builders.read().items.slice(0, 4);
      const w = builders.watch();
      const n = builders.news().clusters.slice(0, 5);
      return { hero: best.find((x) => x.media.some((m) => m.type === 'image')) || best[0] || null, items: best, read: r, watch: w.items.slice(0, 4), live: w.live.slice(0, 3), news: n };
    },
  };

  function section(name) {
    if (!SECTIONS.includes(name)) throw Object.assign(new Error('unknown section'), { status: 400 });
    const out = builders[name]();
    const all = [...(out.items || []), ...(out.read || []), ...(out.watch || []), ...(out.clusters || []), ...(out.news || []), ...(out.shared || []), ...(out.dev || []), ...(out.hero ? [out.hero] : [])];
    const extra = [...(out.live || []), ...(out.highlights || []), ...(out.curators || [])].map((x) => x.pubkey);
    return { section: name, ...out, profiles: withProfiles(all, extra), quoted: quoted(all), graph: { follows: g.follows.size, hop2: g.hop2.size, updated: g.updated }, generated: now() };
  }

  /** Full conversation for the right panel, every reply, best first. */
  function thread(id) {
    const root = store.getEvent(id);
    const rs = repliesTo(id, 500);
    const eng = engagement([id, ...rs.map((r) => r.id)]);
    // The same person posting the same words more than once shows once, with a count.
    const seen = new Map(), uniq = [];
    for (const r of [...rs].sort((a, b) => a.created_at - b.created_at)) {
      const k = r.pubkey + '|' + r.content.trim().toLowerCase();
      if (seen.has(k)) { seen.get(k).dup++; continue; }
      const x = { ...replyOut(r, eng, replyRefs(r).reply), content: r.content.slice(0, 2000), media: mediaOut(extract(r).media.slice(0, 2)), dup: 1 };
      seen.set(k, x); uniq.push(x);
    }
    const replies = orderReplies(uniq).map((r) => (r.dup > 1 ? r : (({ dup, ...x }) => x)(r)));
    const spam = replies.filter((r) => r.s < 0.5).length;
    const items = root ? [item(root, eng, new Map())] : [];
    return { root: items[0] || null, replies: replies.filter((r) => r.s >= 0.5), hiddenSpam: spam, profiles: withProfiles([...items, ...replies]), quoted: quoted(items) };
  }

  /** A person's page: their profile, how they relate to the owner, and their recent original posts. */
  function author(pk) {
    const ev = store.getReplaceable(0, pk);
    const p = ev ? parseProfile(ev) : {};
    const posts = store.getByFilters({ kinds: [1, 20, 21, 22, 30023], authors: [pk], limit: 200 })
      .filter((e) => e.kind !== 1 || isRootNote(e)).sort((a, b) => b.created_at - a.created_at).slice(0, 40);
    const eng = engagement(posts.map((e) => e.id));
    const items = posts.map((e) => item(e, eng, new Map()));
    const prof = { ...profile(pk), about: p.about || '', big: p.picture ? signer.img(p.picture, 320) : null };
    return {
      pubkey: pk, profile: prof, items,
      rel: { owner: pk === cfg.owner, follow: g.follows.has(pk), hop2: g.hop2.get(pk) || 0, muted: g.mutes.has(pk) },
      profiles: withProfiles(items, [pk]), quoted: quoted(items),
    };
  }

  /** Full long-form article for the reader. */
  function note(id) {
    const ev = store.getEvent(id);
    if (!ev) return null;
    const it = item(ev, engagement([id]), new Map());
    it.content = ev.content.slice(0, 200000);
    // Pre-sign every image the article embeds; the napplet can load nothing else.
    it.imgs = {};
    for (const m of it.content.matchAll(/!\[[^\]]*\]\((https:\/\/[^)\s]+)\)/g)) if (Object.keys(it.imgs).length < 40) it.imgs[m[1]] = signer.img(m[1], 1080);
    if (ev.kind === 30023) {
      const addr = `30023:${ev.pubkey}:${tag(ev, 'd') || ''}`;
      it.highlights = store.getByFilters({ kinds: [9802], '#a': [addr], limit: 50 }).map((h) => ({ pubkey: h.pubkey, text: h.content.slice(0, 400) }));
    }
    return { item: it, profiles: withProfiles([it], (it.highlights || []).map((h) => h.pubkey)) };
  }

  /** Owner's signal page: who is shaping the feed, and how. */
  function signal() {
    const items = circleItems(48);
    const by = new Map();
    for (const it of items) by.set(it.pubkey, (by.get(it.pubkey) || 0) + 1);
    const voices = [...by].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([pk, n]) => ({ pk, n, circle: g.follows.has(pk) }));
    const tags = new Map();
    for (const it of items) for (const t of it.t) tags.set(t, (tags.get(t) || 0) + 1);
    return {
      follows: g.follows.size, hop2: g.hop2.size, mutes: g.mutes.size, relays: ingest.state.relaysUsed,
      lastSync: ingest.state.lastSync, items48h: items.length,
      originals: items.filter((i) => i.f.c).length, explore: items.filter((i) => !i.f.c).length,
      voices, topics: [...tags].sort((a, b) => b[1] - a[1]).slice(0, 16),
      profiles: withProfiles([], voices.map((v) => v.pk)),
    };
  }

  return { section, thread, note, author, signal, profile, warmLinks, SECTIONS };
}
