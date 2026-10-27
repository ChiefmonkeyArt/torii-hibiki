// feed.mjs — turns stored events into section feeds with feature vectors.
// The node computes public features; the browser applies private weights.
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { nip19 } from 'nostr-tools';
import { isRootNote, replyRefs, extract, hashtags, parseProfile, zapSats, tag } from './nostr.mjs';

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

export function makeFeed({ cfg, store, ingest, signer }) {
  const g = ingest.graph;
  const now = () => Math.floor(Date.now() / 1000);

  function profile(pk) {
    const ev = store.getReplaceable(0, pk);
    const p = ev ? parseProfile(ev) : { name: '', about: '', picture: '', nip05: '' };
    return { name: p.name || nip19.npubEncode(pk).slice(0, 12) + '…', about: p.about, nip05: p.nip05, lud16: p.lud16 || '', pic: p.picture ? signer.img(p.picture, 96) : null, npub: nip19.npubEncode(pk) };
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

  const builders = {
    circle() {
      const items = top(circleItems(), 150);
      peekAll(items.slice(0, 60));
      return { items };
    },
    news() {
      const items = circleItems(72).filter((it) => it.links.length);
      const clusters = new Map();
      for (const it of items) for (const l of it.links) {
        const k = l.url.replace(/^https:\/\/(www\.)?/, '').replace(/\/$/, '');
        if (!clusters.has(k)) clusters.set(k, { url: l.url, sig: l.sig, sharers: [], notes: [], f: { ...it.f, ce: 0 } });
        const c = clusters.get(k);
        if (!c.sharers.includes(it.pubkey)) c.sharers.push(it.pubkey);
        c.notes.push({ id: it.id, pubkey: it.pubkey, content: it.content.slice(0, 280), created_at: it.created_at });
        c.f.ce += it.f.ce + (it.f.c ? 1 : 0); c.f.ge += it.f.ge; c.f.z += it.f.z; c.f.a = Math.min(c.f.a, it.f.a); c.f.c = c.f.c || it.f.c; c.f.h = Math.max(c.f.h, it.f.h);
      }
      const list = [...clusters.values()].map((c) => ({ ...c, id: c.sig, pubkey: c.sharers[0], created_at: Math.max(...c.notes.map((n) => n.created_at)), sharers: c.sharers.slice(0, 8), notes: c.notes.slice(0, 4) }));
      const sorted = Rank.rerank(list, Rank.DEFAULTS, { perAuthor: 6 }).slice(0, 60);
      const curators = store.getByFilters({ kinds: [30004], authors: [...g.follows], limit: 40 })
        .map((e) => ({ id: e.id, pubkey: e.pubkey, title: (tag(e, 'title') || tag(e, 'd') || '').slice(0, 80), size: e.tags.filter((t) => t[0] === 'a' || t[0] === 'e').length }))
        .filter((c) => c.size > 0).slice(0, 12);
      return { clusters: sorted, curators };
    },
    watch() {
      const vids = candidates([1, 21, 22], 7 * 24, [cfg.owner, ...g.follows, ...g.hop2.keys()])
        .filter((e) => (e.kind !== 1 || isRootNote(e)) && extract(e).media.some((m) => m.type === 'video'));
      const eng = engagement(vids.map((e) => e.id));
      const live = store.getByFilters({ kinds: [30311], authors: [...g.follows], since: now() - 12 * H, limit: 50 })
        .filter((e) => tag(e, 'status') === 'live')
        .map((e) => ({ id: e.id, pubkey: e.pubkey, created_at: e.created_at, title: (tag(e, 'title') || 'Live').slice(0, 120), image: tag(e, 'image')?.startsWith('https://') ? signer.img(tag(e, 'image'), 640) : null, viewers: Number(tag(e, 'current_participants')) || null, f: { c: 1, a: 0, ce: 0, ge: 0, z: 0 } }));
      return { items: top(vids.map((e) => item(e, eng, new Map())), 60), live };
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
    const all = [...(out.items || []), ...(out.read || []), ...(out.watch || []), ...(out.clusters || []), ...(out.news || []), ...(out.hero ? [out.hero] : [])];
    const extra = [...(out.live || []), ...(out.highlights || []), ...(out.curators || [])].map((x) => x.pubkey);
    return { section: name, ...out, profiles: withProfiles(all, extra), quoted: quoted(all), graph: { follows: g.follows.size, hop2: g.hop2.size, updated: g.updated }, generated: now() };
  }

  /** Full conversation for the right panel, every reply, best first. */
  function thread(id) {
    const root = store.getEvent(id);
    const rs = repliesTo(id, 500);
    const eng = engagement([id, ...rs.map((r) => r.id)]);
    const replies = orderReplies(rs.map((r) => ({ ...replyOut(r, eng, replyRefs(r).reply), content: r.content.slice(0, 2000), media: mediaOut(extract(r).media.slice(0, 2)) })));
    const spam = replies.filter((r) => r.s < 0.5).length;
    const items = root ? [item(root, eng, new Map())] : [];
    return { root: items[0] || null, replies: replies.filter((r) => r.s >= 0.5), hiddenSpam: spam, profiles: withProfiles([...items, ...replies]), quoted: quoted(items) };
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

  return { section, thread, note, signal, profile, SECTIONS };
}
