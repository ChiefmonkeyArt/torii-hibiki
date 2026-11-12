// ADR-0004: lean tag table, honoured deletions, engagement window.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EventStore } from 'applesauce-core';
import { NativeSqliteEventDatabase } from 'applesauce-sqlite/native';
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure';
import { HibikiEventDatabase, withDeletions } from '../src/eventdb.mjs';
import { isLean, prepareSchema } from '../src/schema.mjs';

const sk = generateSecretKey(), sk2 = generateSecretKey(), ownerSk = generateSecretKey();
const owner = getPublicKey(ownerSk);
const mk = (kind, created_at, tags = [], key = sk, content = '') => finalizeEvent({ kind, created_at, tags, content }, key);
const n = (db, sql, ...a) => Object.values(db.db.prepare(sql).get(...a))[0];
const orphans = (db) => n(db, 'SELECT count(*) FROM event_tags WHERE NOT EXISTS (SELECT 1 FROM events WHERE events.id = event_tags.event_id)');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hstore-'));
const ids = (evs) => evs.map((e) => e.id).sort();

test('a new store gets one tag copy and the upstream open never rebuilds the second index', () => {
  const db = new HibikiEventDatabase(':memory:');
  assert.ok(isLean(db.db));
  const idx = db.db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'event_tags'").all();
  assert.deepEqual(idx.map((i) => [i.name, /WHERE 0$/.test(i.sql)]), [['event_tags_name_value_event_idx', true]], 'only the empty placeholder');
  const plan = db.db.prepare("EXPLAIN QUERY PLAN SELECT event_id FROM event_tags WHERE tag_name = 'e' AND tag_value IN ('x')").all().map((r) => r.detail).join(' ');
  assert.match(plan, /PRIMARY KEY/, 'tag filters use the primary key');
  assert.deepEqual(prepareSchema(db.db), {}, 'second open is a no-op');
});

test('migration keeps every tag filter answer except follow lists, and drops orphans', () => {
  const dir = tmp(), file = path.join(dir, 'events.db');
  try {
    const stock = new NativeSqliteEventDatabase(file);
    const root = mk(1, 100, [['t', 'nostr']]), art = mk(30023, 100, [['d', 'a1']]);
    const evs = [root, art, mk(7, 110, [['e', root.id], ['p', root.pubkey]], sk2), mk(1, 120, [['e', root.id], ['p', root.pubkey]], sk2),
      mk(9802, 130, [['a', `30023:${art.pubkey}:a1`]], sk2), mk(3, 100, [['p', root.pubkey], ['p', 'c'.repeat(64)]], sk2)];
    for (const e of evs) stock.add(e);
    const filters = [{ '#e': [root.id] }, { '#p': [root.pubkey], kinds: [7, 1] }, { '#a': [`30023:${art.pubkey}:a1`] }, { '#t': ['nostr'] }, { '#d': ['a1'] }];
    const want = filters.map((f) => ids(stock.getByFilters(f)));
    stock.db.exec("PRAGMA foreign_keys = OFF; INSERT INTO event_tags VALUES ('" + '9'.repeat(64) + "', 'p', 'gone')");
    stock.close();
    const db = new HibikiEventDatabase(file);
    assert.equal(db.schema.migrated, true);
    assert.deepEqual(filters.map((f) => ids(db.getByFilters(f))), want, 'same answers');
    assert.equal(n(db, "SELECT count(*) FROM event_tags t JOIN events e ON e.id = t.event_id WHERE e.kind = 3"), 0);
    assert.equal(orphans(db), 0);
    assert.equal(db.getReplaceable(3, getPublicKey(sk2)).tags.length, 2, 'follow list itself is whole');
    assert.ok(!db.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_autoindex_event_tags_1'").get());
    db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('remove (by event or id) and removeByFilters take the tag rows with them', () => {
  const db = new HibikiEventDatabase(':memory:'), store = new EventStore({ database: db });
  const a = mk(1, 100, [['p', 'a'.repeat(64)], ['t', 'x']]), b = mk(1, 200, [['p', 'b'.repeat(64)]]), c = mk(7, 50, [['e', a.id]]);
  for (const e of [a, b, c]) store.add(e);
  assert.equal(db.remove(a), true, 'event object accepted (the ADR-0003 bug)');
  assert.equal(db.remove(b.id), true);
  assert.equal(db.remove(b.id), false);
  assert.equal(db.removeByFilters({ kinds: [7], until: 60 }), 1);
  assert.equal(n(db, 'SELECT count(*) FROM events'), 0);
  assert.equal(n(db, 'SELECT count(*) FROM event_tags'), 0);
});

test('deletions: verified, removed from SQLite, remembered across a restart, own events only', () => {
  const dir = tmp(), file = path.join(dir, 'events.db');
  try {
    let db = new HibikiEventDatabase(file), store = new EventStore({ database: db });
    withDeletions(store);
    const post = mk(1, 100, [['t', 'oops']]), other = mk(1, 100, [], sk2), art = mk(30023, 100, [['d', 'x']]), keepArt = mk(30023, 300, [['d', 'y']]);
    for (const e of [post, other, art, keepArt]) store.add(e);
    const forged = { ...JSON.parse(JSON.stringify(mk(5, 150, [['e', post.id]]))), sig: '0'.repeat(128) };
    assert.equal(store.add(forged), null, 'bad signature refused');
    assert.ok(db.getEvent(post.id), 'still there');
    store.add(mk(5, 150, [['e', other.id]]));
    assert.ok(db.getEvent(other.id), 'cannot delete someone else\'s post');
    store.add(mk(5, 150, [['e', post.id], ['a', `30023:${art.pubkey}:x`], ['a', `30023:${art.pubkey}:y`]]));
    assert.equal(db.getEvent(post.id), undefined, 'deleted post gone from SQLite');
    assert.equal(db.getEvent(art.id), undefined, 'deleted article address gone');
    assert.ok(db.getEvent(keepArt.id), 'a newer version than the deletion stays');
    assert.equal(n(db, "SELECT count(*) FROM event_tags WHERE tag_name = 't'"), 0);
    db.close();
    // Restart: a fresh store on the same file refuses the deleted post fetched again.
    db = new HibikiEventDatabase(file); store = new EventStore({ database: db });
    assert.deepEqual(withDeletions(store), { replayed: 2 });
    store.add(post);
    assert.equal(db.getEvent(post.id), undefined, 'still refused after restart');
    assert.equal(orphans(db), 0);
    db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('engagement window: old reactions, reposts and receipts from others go; the owner\'s and those tagging the owner stay', () => {
  const db = new HibikiEventDatabase(':memory:');
  const root = mk(1, 10, [], ownerSk), x = 'e'.repeat(64);
  const gone = [mk(7, 10, [['e', x]]), mk(6, 10, [['e', x]]), mk(16, 10, [['e', x]]), mk(9735, 10, [['e', x], ['p', 'a'.repeat(64)]])];
  const stay = [root, mk(7, 10, [['e', x]], ownerSk), mk(7, 10, [['e', root.id], ['p', owner]]), mk(9735, 10, [['P', owner], ['p', 'a'.repeat(64)]]),
    mk(7, 1000, [['e', x]]), mk(1, 10, [['e', x]])];
  for (const e of [...gone, ...stay]) db.add(e);
  assert.equal(db.pruneEngagement(500, owner), gone.length);
  assert.deepEqual(ids(db.getByFilters({})), ids(stay));
  assert.equal(orphans(db), 0);
});

test('ingest prune applies the content, engagement and deletion windows', async () => {
  const { makeIngest } = await import('../src/ingest.mjs');
  const db = new HibikiEventDatabase(':memory:'), store = new EventStore({ database: db });
  const now = Math.floor(Date.now() / 1000), d = 86400, x = 'f'.repeat(64);
  const oldPost = mk(1, now - 15 * d), post = mk(1, now - 8 * d), like = mk(7, now - 8 * d, [['e', x]]), mine = mk(7, now - 8 * d, [['e', x]], ownerSk);
  const fresh = mk(7, now - d, [['e', x]]), oldDel = mk(5, now - 91 * d, [['e', x]]), del = mk(5, now - 10 * d, [['e', x]]);
  for (const e of [oldPost, post, like, mine, fresh, oldDel, del]) db.add(e);
  const ing = makeIngest({ cfg: { owner, retainDays: 14, engageDays: 7, primaryRelay: 'ws://127.0.0.1:1', indexRelays: [], syncMinutes: 60 }, store });
  ing.prune();
  assert.deepEqual(ids(db.getByFilters({})), ids([post, mine, fresh, del]));
});
