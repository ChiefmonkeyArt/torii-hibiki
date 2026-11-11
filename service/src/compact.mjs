// compact.mjs — one-off (and safe to re-run) cleanup of the node's event store
// (ADR-0003). Removes replaced versions of replaceable and addressable events,
// and any tag rows whose event is gone, then VACUUMs. Nothing else is dropped.
// Steps: drop v0.2.8 backups -> measure -> nothing to do? stop -> check free
// disk -> delete in one transaction -> VACUUM -> report. No backup is taken:
// the store is a cache of relay events and refills itself (ADR-0003, v0.2.9).
// Run with the service stopped (install.sh does this):
//   node src/compact.mjs /var/lib/hibiki/events.db
// GPL-3.0-or-later.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MB = 1024 * 1024;
const BETTER = 'w.kind = e.kind AND w.pubkey = e.pubkey AND (w.created_at > e.created_at OR (w.created_at = e.created_at AND w.id < e.id))';
export const STALE_SQL = `
  SELECT e.id, e.kind FROM events e
   WHERE (e.kind IN (0, 3) OR e.kind BETWEEN 10000 AND 19999)
     AND EXISTS (SELECT 1 FROM events w WHERE ${BETTER})
  UNION ALL
  SELECT e.id, e.kind FROM events e
   WHERE e.kind BETWEEN 30000 AND 39999
     AND EXISTS (SELECT 1 FROM events w WHERE ${BETTER} AND w.identifier = e.identifier)`;
const ORPHANS = 'FROM event_tags WHERE NOT EXISTS (SELECT 1 FROM events WHERE events.id = event_tags.event_id)';

const one = (db, sql, ...a) => Object.values(db.prepare(sql).get(...a) || {})[0];
const size = (f) => { let n = 0; for (const s of ['', '-wal', '-journal']) { try { n += fs.statSync(f + s).size; } catch { /* none */ } } return n; };
const freeBytes = (dir) => { const s = fs.statfsSync(dir); return s.bavail * s.bsize; };
const fmt = (b) => `${(b / MB).toFixed(1)} MB`;

/** Count what would be removed, without changing anything. */
export function measure(db) {
  db.exec('DROP TABLE IF EXISTS temp.stale; CREATE TEMP TABLE stale (id TEXT PRIMARY KEY, kind INTEGER)');
  db.exec(`INSERT INTO temp.stale ${STALE_SQL}`);
  const byKind = Object.fromEntries(db.prepare('SELECT kind, count(*) n FROM temp.stale GROUP BY kind ORDER BY n DESC').all().map((r) => [r.kind, r.n]));
  return {
    events: one(db, 'SELECT count(*) FROM events'),
    tags: one(db, 'SELECT count(*) FROM event_tags'),
    stale: one(db, 'SELECT count(*) FROM temp.stale'),
    staleTags: one(db, 'SELECT count(*) FROM event_tags WHERE event_id IN (SELECT id FROM temp.stale)'),
    orphanTags: one(db, `SELECT count(*) ${ORPHANS}`),
    freePages: one(db, 'PRAGMA freelist_count') * one(db, 'PRAGMA page_size'),
    byKind,
  };
}

/**
 * Compact the event store at `file`. Returns a report; throws only on a real
 * failure (the database is left as it was by the transaction / VACUUM).
 */
/** v0.2.8 kept a pre-compaction copy in <data>/backups; the store is a cache, so drop it. */
export function dropBackups(dir, log = console.log) {
  const bdir = path.join(dir, 'backups');
  let names; try { names = fs.readdirSync(bdir); } catch { return 0; }
  let freed = 0;
  for (const f of names.filter((x) => /^events-\d{8}T\d{6}Z\.db(-journal|-wal|-shm)?$/.test(x))) {
    const p = path.join(bdir, f);
    freed += fs.statSync(p).size; fs.rmSync(p, { force: true });
  }
  try { fs.rmdirSync(bdir); } catch { /* not empty: something else lives there, leave it */ }
  if (freed) log(`compact: removed old backups, ${fmt(freed)} freed`);
  return freed;
}

/**
 * Compact the event store at `file`. Returns a report; throws only on a real
 * failure (the delete is one transaction; VACUUM is atomic).
 */
export function compact(file, { log = console.log, minFreeSlack = 256 * MB, freeSpace = freeBytes } = {}) {
  const dropped = dropBackups(path.dirname(file), log);
  if (!fs.existsSync(file)) { log('compact: no event store yet, nothing to do'); return { done: false, reason: 'missing', dropped }; }
  const before = { bytes: size(file), free: freeSpace(path.dirname(file)) };
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 10000');
    const m = measure(db);
    Object.assign(before, { events: m.events, tags: m.tags });
    log(`compact: ${fmt(before.bytes)}, ${m.events} events, ${m.tags} tag rows, ${fmt(before.free)} free; replaced versions ${m.stale} (${m.staleTags} tag rows) ${JSON.stringify(m.byKind)}, orphan tag rows ${m.orphanTags}, free pages ${fmt(m.freePages)}`);
    if (!m.stale && !m.orphanTags && m.freePages < 32 * MB) { log('compact: nothing to do'); return { done: false, reason: 'clean', before, dropped }; }
    // VACUUM's temporary copy + rollback journal, each at most the file size.
    const need = before.bytes * 2 + minFreeSlack;
    if (before.free < need) {
      log(`compact: skipped, needs ${fmt(need)} free and only ${fmt(before.free)} is available; nothing changed`);
      return { done: false, reason: 'disk', before, need, dropped };
    }
    db.exec('BEGIN IMMEDIATE');
    let staleTags, orphanTags, stale;
    try {
      staleTags = db.prepare('DELETE FROM event_tags WHERE event_id IN (SELECT id FROM temp.stale)').run().changes;
      stale = db.prepare('DELETE FROM events WHERE id IN (SELECT id FROM temp.stale)').run().changes;
      orphanTags = db.prepare(`DELETE ${ORPHANS}`).run().changes;
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    db.exec('DROP TABLE temp.stale');
    db.exec('VACUUM');
    const after = { bytes: size(file), free: freeSpace(path.dirname(file)), events: one(db, 'SELECT count(*) FROM events'), tags: one(db, 'SELECT count(*) FROM event_tags') };
    log(`compact: removed ${stale} replaced versions ${JSON.stringify(m.byKind)}, ${staleTags} of their tag rows and ${orphanTags} orphan tag rows`);
    log(`compact: ${fmt(before.bytes)} -> ${fmt(after.bytes)}; events ${before.events} -> ${after.events}; tag rows ${before.tags} -> ${after.tags}; free ${fmt(before.free)} -> ${fmt(after.free)}`);
    return { done: true, before, after, removed: { events: stale, byKind: m.byKind, tags: staleTags, orphanTags }, dropped };
  } finally { db.close(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const file = process.argv[2] || path.join(process.env.HIBIKI_DATA || '/var/lib/hibiki', 'events.db');
  try { compact(file); } catch (e) { console.error(`compact: failed: ${e.message}`); process.exit(1); }
}
