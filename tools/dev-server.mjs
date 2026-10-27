#!/usr/bin/env node
// tools/dev-server.mjs — local stand-in for the nginx fragment: serves web/
// under /hibiki/ with the same headers install.sh writes, and proxies the
// service paths to the feed service. Development only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HEADERS } from './headers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const PORT = Number(process.env.PORT || 8790), UP = Number(process.env.HIBIKI_PORT || 8795);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (/^\/hibiki\/(api|img|media)\//.test(u.pathname)) {
    const up = http.request({ host: '127.0.0.1', port: UP, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('error', () => { res.writeHead(502); res.end('upstream down'); });
    return req.pipe(up);
  }
  let rel = u.pathname.replace(/^\/hibiki\/?/, '') || 'index.html';
  const f = path.join(ROOT, path.normalize(rel));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  const ext = path.extname(f);
  const h = { 'content-type': TYPES[ext] || 'application/octet-stream', ...HEADERS.common };
  if (rel === 'napplet.html') Object.assign(h, HEADERS.napplet);
  if (rel === 'index.html') Object.assign(h, HEADERS.shell);
  if (ext === '.woff2') Object.assign(h, HEADERS.fonts);
  res.writeHead(200, h); fs.createReadStream(f).pipe(res);
}).listen(PORT, '127.0.0.1', () => console.log(`dev on http://127.0.0.1:${PORT}/hibiki/`));
