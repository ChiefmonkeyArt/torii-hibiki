// ingest.mjs — reads the owner's social graph and their circle's posts.
// Outbox model (NIP-65): each followed author is read from the relays they
// say they write to, chosen by a greedy cover so a few relays reach most of
// the circle. The shared node relay is always included and is where Hibiki
// publishes. Nothing here holds a key.
import { RelayPool, RelayGroup } from 'applesauce-relay';
import { nip19 } from 'nostr-tools';
import { lastValueFrom, toArray, timeout, catchError, of } from 'rxjs';

export const CONTENT_KINDS = [1, 6, 20, 21, 22, 30023, 9802, 30311, 30004];
export const ENGAGE_KINDS = [7, 6, 9735];
const HOUR = 3600;
const QUOTE = /nostr:(note1[02-9ac-hj-np-z]{58}|nevent1[02-9ac-hj-np-z]+)/g;

export function writeRelays(ev) {
  if (!ev) return [];
  return ev.tags.filter((t) => t[0] === 'r' && /^wss:\/\/[^\s]+$/.test(t[1] || '') && t[2] !== 'read')
    .map((t) => t[1].replace(/\/+$/, '')).slice(0, 8);
}

/** Greedy set cover: pick relays that reach the most uncovered authors. */
export function chooseRelays(outbox, authors, max, fallback) {
  const uncovered = new Set(authors), plan = new Map();
  const byRelay = new Map();
  for (const a of authors) for (const r of outbox.get(a) || []) {
    if (!byRelay.has(r)) byRelay.set(r, new Set());
    byRelay.get(r).add(a);
  }
  while (plan.size < max && uncovered.size) {
    let best = null, bestN = 0;
    for (const [r, set] of byRelay) {
      if (plan.has(r)) continue;
      let n = 0; for (const a of set) if (uncovered.has(a)) n++;
      if (n > bestN) { best = r; bestN = n; }
    }
    if (!best || bestN < 1) break;
    const got = [...byRelay.get(best)].filter((a) => uncovered.has(a));
    plan.set(best, got); for (const a of got) uncovered.delete(a);
  }
  if (uncovered.size) for (const r of fallback) plan.set(r, [...(plan.get(r) || []), ...uncovered]);
  return plan;
}

/** Publishes to every relay; resolves as soon as one accepts (or all have
 *  answered, or `ms` passes). Relays still working are marked pending and
 *  finish in the background. */
export async function firstAccepted(relays, send, ms) {
  const results = new Map();
  const each = relays.map((url) => Promise.resolve().then(() => send(url))
    .then((r) => ({ relay: url, ok: !!r?.ok, message: r?.message || '' }), (e) => ({ relay: url, ok: false, message: e?.message || 'failed' }))
    .then((r) => { results.set(url, r); return r; }));
  let timer;
  await Promise.race([
    new Promise((res) => { each.forEach((p) => p.then((r) => { if (r.ok) res(); })); Promise.all(each).then(res); }),
    new Promise((res) => { timer = setTimeout(res, ms); }),
  ]);
  clearTimeout(timer);
  return relays.map((url) => results.get(url) || { relay: url, ok: false, pending: true, message: '' });
}

const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

export function makeIngest({ cfg, store, log = () => {} }) {
  const pool = new RelayPool();
  const primary = cfg.primaryRelay;
  const graph = { follows: new Set(), hop2: new Map(), mutes: new Set(), outbox: new Map(), ownerRelays: [], updated: 0 };
  const state = { lastSync: 0, lastGraph: 0, running: false, lastError: null, relaysUsed: 0 };

  function req(relays, filters, ms = 12000) {
    relays = [...new Set(relays)].filter(Boolean);
    if (!relays.length) return Promise.resolve([]);
    return lastValueFrom(pool.request(relays, filters, {
      timeout: ms + 3000,
      complete: RelayGroup.completeAfterIdle({ grace: 2500, idle: 1500, cap: ms }),
    }).pipe(toArray(), timeout(ms + 5000), catchError((e) => { log('req', relays.length, e.message); return of([]); })));
  }
  const keep = (evs) => { let n = 0; for (const e of evs) if (store.add(e)) n++; return n; };

  async function loadGraph() {
    const discover = [primary, ...cfg.indexRelays];
    keep(await req(discover, [{ kinds: [0, 3, 10002, 10000], authors: [cfg.owner] }]));
    const k3 = store.getReplaceable(3, cfg.owner);
    const mine = store.getReplaceable(10002, cfg.owner);
    graph.ownerRelays = writeRelays(mine);
    graph.follows = new Set((k3?.tags || []).filter((t) => t[0] === 'p' && /^[0-9a-f]{64}$/.test(t[1])).map((t) => t[1]));
    graph.follows.delete(cfg.owner);
    graph.mutes = new Set((store.getReplaceable(10000, cfg.owner)?.tags || []).filter((t) => t[0] === 'p').map((t) => t[1]));
    const follows = [...graph.follows];
    for (const part of chunk(follows, 300)) keep(await req(discover, [{ kinds: [0, 10002, 3], authors: part }], 15000));
    graph.outbox = new Map(follows.map((p) => [p, writeRelays(store.getReplaceable(10002, p))]));
    // 2-hop: how many of your follows follow each pubkey you do not follow.
    const hop2 = new Map();
    for (const p of follows) {
      const ev = store.getReplaceable(3, p);
      if (!ev) continue;
      for (const t of ev.tags) {
        if (t[0] !== 'p' || graph.follows.has(t[1]) || t[1] === cfg.owner || graph.mutes.has(t[1])) continue;
        hop2.set(t[1], (hop2.get(t[1]) || 0) + 1);
      }
    }
    graph.hop2 = new Map([...hop2].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 300));
    graph.updated = Date.now();
    log('graph', `${graph.follows.size} follows, ${graph.hop2.size} 2-hop`);
  }

  async function syncContent() {
    const now = Math.floor(Date.now() / 1000);
    const since = state.lastSync ? state.lastSync - 600 : now - 48 * HOUR;
    const authors = [cfg.owner, ...graph.follows];
    const plan = chooseRelays(graph.outbox, authors, cfg.maxOutboxRelays, cfg.indexRelays.slice(1));
    plan.set(primary, authors);
    state.relaysUsed = plan.size;
    let n = 0;
    await Promise.all([...plan].map(async ([relay, who]) => {
      for (const part of chunk(who, 250)) n += keep(await req([relay], [{ kinds: CONTENT_KINDS, authors: part, since, limit: 500 }]));
    }));
    // Explore: recent original posts from the strongest 2-hop accounts.
    const explore = [...graph.hop2.keys()].slice(0, 150);
    for (const part of chunk(explore, 150)) n += keep(await req([primary, ...cfg.indexRelays], [{ kinds: [1, 20, 21, 22, 30023], authors: part, since: now - 24 * HOUR, limit: 400 }]));
    // Profiles for explore authors.
    const missing = explore.filter((p) => !store.getReplaceable(0, p));
    for (const part of chunk(missing, 300)) keep(await req(cfg.indexRelays, [{ kinds: [0], authors: part }]));
    // Engagement on recent roots.
    const ids = store.getByFilters({ kinds: [1, 20, 21, 22, 30023], since: now - 48 * HOUR }).map((e) => e.id);
    const engRelays = [primary, ...[...plan.keys()].slice(0, 6)];
    for (const part of chunk(ids, 150)) n += keep(await req(engRelays, [{ kinds: [...ENGAGE_KINDS, 1], '#e': part, since: now - 72 * HOUR, limit: 2000 }]));
    // Quoted notes (nostr:note / nevent) so quote cards can render.
    const want = new Set();
    for (const e of store.getByFilters({ kinds: [1], since: now - 48 * HOUR })) for (const m of (e.content || '').matchAll(QUOTE)) {
      try { const d = nip19.decode(m[1]); const id = d.type === 'note' ? d.data : d.data.id; if (!store.getEvent(id)) want.add(id); } catch {}
      if (want.size >= 300) break;
    }
    for (const part of chunk([...want], 150)) n += keep(await req([primary, ...cfg.indexRelays], [{ ids: part }], 8000));
    state.lastSync = now;
    log('sync', `${n} new events from ${plan.size} relays`);
  }

  function prune() {
    const until = Math.floor(Date.now() / 1000) - cfg.retainDays * 86400;
    try { store.database?.removeByFilters?.({ kinds: [...CONTENT_KINDS, ...ENGAGE_KINDS], until }); } catch (e) { log('prune', e.message); }
  }

  async function tick() {
    if (state.running) return;
    state.running = true;
    try {
      if (Date.now() - state.lastGraph > HOUR * 1000) { await loadGraph(); state.lastGraph = Date.now(); prune(); }
      await syncContent();
      state.lastError = null;
      try { store.memory?.prune?.(); } catch {}
    } catch (e) { state.lastError = e.message; log('tick', e.stack || e.message); }
    finally { state.running = false; }
  }

  /** On-demand: replies for a thread, fetched live from the author's outbox. */
  async function fetchThread(root) {
    const ev = store.getEvent(root);
    const relays = [primary, ...(ev ? graph.outbox.get(ev.pubkey) || [] : []), ...cfg.indexRelays.slice(1)];
    keep(await req(relays.slice(0, 8), [{ kinds: [1, 7, 9735], '#e': [root], limit: 300 }], 5000));
  }
  async function fetchEvent(id) {
    if (store.getEvent(id)) return store.getEvent(id);
    keep(await req([primary, ...cfg.indexRelays], [{ ids: [id] }], 5000));
    return store.getEvent(id);
  }

  /** On-demand: a person's profile, relay list and recent posts, for their profile page. */
  async function fetchAuthor(pk) {
    const relays = [primary, ...(graph.outbox.get(pk) || writeRelays(store.getReplaceable(10002, pk))).slice(0, 4), ...cfg.indexRelays];
    keep(await req(relays.slice(0, 8), [{ kinds: [0, 10002], authors: [pk] }, { kinds: [1, 6, 20, 21, 22, 30023], authors: [pk], limit: 60 }], 5000));
  }
  async function fetchProfile(pk) {
    if (!store.getReplaceable(0, pk)) keep(await req([primary, ...cfg.indexRelays], [{ kinds: [0], authors: [pk] }], 4000));
    return store.getReplaceable(0, pk);
  }
  /** Reads `filters` from `relays`, keeps what arrives and returns it. */
  async function query(relays, filters, ms = 5000) { const evs = await req(relays, filters, ms); keep(evs); return evs; }

  // Owner-signed events go to the node relay and the owner's write relays.
  // The event is stored first, so it shows in Hibiki at once; the answer
  // comes back as soon as one relay accepts it (or after 3 s), and the
  // slower relays finish in the background.
  async function publish(ev, firstWithin = 3000) {
    store.add(ev);
    const relays = [...new Set([primary, ...graph.ownerRelays])].slice(0, 8);
    const out = await firstAccepted(relays, (url) => pool.relay(url).publish(ev, { timeout: 8000 }), firstWithin);
    const failed = out.filter((r) => !r.ok && !r.pending);
    if (failed.length) log('publish', failed.map((r) => `${r.relay}: ${r.message}`).join('; '));
    return out;
  }

  let timer = null;
  return {
    graph, state, tick, fetchThread, fetchEvent, fetchAuthor, fetchProfile, query, publish,
    start() { tick(); timer = setInterval(tick, cfg.syncMinutes * 60000); timer.unref?.(); },
    stop() { clearInterval(timer); },
  };
}
