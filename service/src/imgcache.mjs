// imgcache.mjs — size-capped on-disk LRU for re-encoded images and link
// previews. Keys are sha256 of the signed path; access time is the mtime.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export function makeCache(dir, capBytes) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = (key) => path.join(dir, crypto.createHash('sha256').update(key).digest('hex'));
  let total = null, sweeping = false;
  async function size() {
    let n = 0;
    for (const f of await fsp.readdir(dir)) { try { n += (await fsp.stat(path.join(dir, f))).size; } catch {} }
    return n;
  }
  async function sweep() {
    if (sweeping) return; sweeping = true;
    try {
      const items = [];
      for (const f of await fsp.readdir(dir)) {
        try { const s = await fsp.stat(path.join(dir, f)); items.push([f, s.mtimeMs, s.size]); } catch {}
      }
      items.sort((a, b) => a[1] - b[1]);
      total = items.reduce((a, i) => a + i[2], 0);
      const target = capBytes * 0.85;
      for (const [f, , sz] of items) {
        if (total <= target) break;
        await fsp.rm(path.join(dir, f), { force: true }); total -= sz;
      }
    } finally { sweeping = false; }
  }
  return {
    async get(key) {
      const f = file(key);
      try {
        const buf = await fsp.readFile(f);
        const now = new Date(); fsp.utimes(f, now, now).catch(() => {});
        return buf;
      } catch { return null; }
    },
    async put(key, buf) {
      const f = file(key), tmp = `${f}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, buf, { mode: 0o600 });
      await fsp.rename(tmp, f);
      if (total === null) total = await size(); else total += buf.length;
      if (total > capBytes) sweep();
    },
  };
}
