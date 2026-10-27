// server.mjs — Hibiki feed service. Loopback HTTP behind nginx.
//   /hibiki/api/*    owner API (session cookie from NIP-98 login)
//   /hibiki/img/*    signed image proxy (re-encoded WebP, EXIF stripped)
//   /hibiki/media/*  signed tap-to-play audio/video proxy with Range
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { EventStore } from 'applesauce-core';
import { NativeSqliteEventDatabase } from 'applesauce-sqlite/native';
import { loadConfig } from './config.mjs';
import { makeSigner } from './signer.mjs';
import { makeCache } from './imgcache.mjs';
import { makeProxies } from './proxy.mjs';
import { loadImager } from './imaging.mjs';
import { makeIngest } from './ingest.mjs';
import { makeFeed } from './feed.mjs';
import { verifyNip98, checkPublish } from './auth.mjs';
import { FetchError } from './safefetch.mjs';

export const VERSION = fs.readFileSync(new URL('../../VERSION', import.meta.url), 'utf8').trim();

export function createApp(cfg, deps = {}) {
  const log = deps.log || ((...a) => console.log(new Date().toISOString(), ...a));
  fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
  const db = deps.db || new NativeSqliteEventDatabase(path.join(cfg.dataDir, 'events.db'));
  const store = deps.store || new EventStore({ database: db });
  const signer = makeSigner(cfg.secret, cfg.basePath);
  const cache = makeCache(path.join(cfg.dataDir, 'cache'), cfg.imgCacheBytes);
  const imager = deps.imager ? Promise.resolve(deps.imager) : loadImager(cfg.imgBackend, log);
  let imgBackend = 'loading';
  imager.then((i) => { imgBackend = i.name; log('imaging', `image backend: ${i.name}`); }, (e) => log('imaging', e.message));
  const proxies = makeProxies({ signer, cache, imager, log });
  const ingest = deps.ingest || makeIngest({ cfg, store, log });
  const feed = makeFeed({ cfg, store, ingest, signer });
  const seen = new Map();
  const loginTries = new Map();
  const B = cfg.basePath;

  const json = (res, code, obj, extra = {}) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra });
    res.end(body);
  };
  const cookie = (req) => /(?:^|;\s*)hibiki_s=([^;]+)/.exec(req.headers.cookie || '')?.[1];
  const authed = (req) => (cfg.dev && req.socket.remoteAddress === '127.0.0.1' && !req.headers['x-forwarded-for']) || signer.verifySession(cookie(req)) === cfg.owner;
  async function body(req, cap = 70 * 1024) {
    let n = 0; const c = [];
    for await (const b of req) { n += b.length; if (n > cap) throw new FetchError('body too large', 413); c.push(b); }
    return JSON.parse(Buffer.concat(c).toString('utf8') || 'null');
  }

  async function api(req, res, route, q) {
    const post = req.method === 'POST';
    // CSRF: POSTs need a custom header, which a cross-site form cannot send.
    if (post && req.headers['x-hibiki'] !== '1') return json(res, 403, { error: 'missing x-hibiki header' });
    if (route === 'health') return json(res, 200, { ok: true, version: VERSION, sync: ingest.state.lastSync, follows: ingest.graph.follows.size, img: imgBackend, error: ingest.state.lastError });
    if (route === 'login' && post) {
      const ip = String(req.headers['x-real-ip'] || req.socket.remoteAddress);
      const t = loginTries.get(ip) || [];
      const recent = t.filter((x) => Date.now() - x < 60000);
      if (recent.length >= 10) return json(res, 429, { error: 'slow down' });
      loginTries.set(ip, [...recent, Date.now()]);
      const r = verifyNip98(req.headers.authorization, { url: `${cfg.origin}${B}/api/login`, method: 'POST', owner: cfg.owner, seen });
      if (!r.ok) return json(res, 401, { error: r.why });
      const secure = cfg.origin.startsWith('https://') ? '; Secure' : '';
      return json(res, 200, { ok: true }, { 'set-cookie': `hibiki_s=${signer.session(r.pubkey)}; HttpOnly; SameSite=Strict; Path=${B}/; Max-Age=2592000${secure}` });
    }
    if (route === 'logout' && post) return json(res, 200, { ok: true }, { 'set-cookie': `hibiki_s=; HttpOnly; SameSite=Strict; Path=${B}/; Max-Age=0` });
    if (route === 'me') return json(res, 200, { owner: cfg.owner, signedIn: authed(req), profile: feed.profile(cfg.owner), version: VERSION });
    if (!authed(req)) return json(res, 401, { error: 'sign in as the owner of this node' });

    if (route === 'feed') return json(res, 200, feed.section(q.get('section') || 'today'));
    if (route === 'signal') return json(res, 200, feed.signal());
    let m;
    if ((m = /^thread\/([0-9a-f]{64})$/.exec(route))) {
      if (q.get('live') === '1') await ingest.fetchThread(m[1]);
      return json(res, 200, feed.thread(m[1]));
    }
    if ((m = /^note\/([0-9a-f]{64})$/.exec(route))) {
      await ingest.fetchEvent(m[1]);
      const n = feed.note(m[1]);
      return n ? json(res, 200, n) : json(res, 404, { error: 'not found' });
    }
    if (route === 'link') {
      const url = q.get('url') || '';
      if (!signer.verifyLink(q.get('sig') || '', url)) return json(res, 403, { error: 'bad signature' });
      try { return json(res, 200, await proxies.link(url)); }
      catch (e) { return json(res, e.status && e.status < 500 ? 422 : 502, { error: e.message }); }
    }
    if (route === 'publish' && post) {
      const ev = await body(req);
      const why = checkPublish(ev, cfg.owner);
      if (why) return json(res, 400, { error: why });
      return json(res, 200, { ok: true, id: ev.id, relays: await ingest.publish(ev) });
    }
    if (route === 'sync' && post) { ingest.tick(); return json(res, 202, { ok: true }); }
    return json(res, 404, { error: 'no such route' });
  }

  async function handle(req, res) {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    try {
      if (!p.startsWith(`${B}/`)) return json(res, 404, { error: 'not found' });
      const rest = p.slice(B.length + 1);
      let m;
      if (rest.startsWith('api/')) return await api(req, res, rest.slice(4), u.searchParams);
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method' });
      if ((m = /^img\/([\w-]{22})\/(\d{2,4})\/([\w-]{8,4000})$/.exec(rest))) return await proxies.img(req, res, m[1], m[2], m[3]);
      if ((m = /^media\/([\w-]{22})\/([\w-]{8,4000})$/.exec(rest))) return await proxies.media(req, res, m[1], m[2]);
      return json(res, 404, { error: 'not found' });
    } catch (e) {
      if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : 'internal error' });
      if (!e.status) log('error', e.stack || e.message);
    }
  }

  const server = http.createServer({ requestTimeout: 30000, headersTimeout: 10000 }, handle);
  return { server, store, ingest, feed, signer, handle, close() { ingest.stop(); server.close(); try { db.close(); } catch {} } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadConfig();
  const app = createApp(cfg);
  app.server.listen(cfg.port, cfg.host, () => console.log(`hibiki-feed v${VERSION} on ${cfg.host}:${cfg.port}${cfg.dev ? ' (DEV auth bypass)' : ''}`));
  app.ingest.start();
  const memTimer = setInterval(() => { try { app.store.memory?.prune?.(); } catch {} }, 60000); memTimer.unref();
  for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => { app.close(); process.exit(0); });
}
