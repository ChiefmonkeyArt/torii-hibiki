import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { EventStore } from 'applesauce-core';
import { NativeSqliteEventDatabase } from 'applesauce-sqlite/native';
import { generateSecretKey, finalizeEvent } from 'nostr-tools/pure';
import { HibikiEventDatabase, beats } from '../src/eventdb.mjs';
import { compact, measure } from '../src/compact.mjs';

const sk = generateSecretKey(), sk2 = generateSecretKey();
const P = (c) => ['p', c.repeat(64)];
const mk = (kind, created_at, tags = [], key = sk, content = '') => finalizeEvent({ kind, created_at, tags, content }, key);
const rows = (db, sql, ...a) => db.db.prepare(sql).all(...a);
const n = (db, sql, ...a) => Object.values(db.db.prepare(sql).get(...a))[0];
const setup = () => { const db = new HibikiEventDatabase(':memory:'); return { db, store: new EventStore({ database: db }) }; };
// Two events with the same created_at, ordered by id.
function tiePair(kind, ts, tags = []) {
  for (let i = 0; ; i++) {
    const a = mk(kind, ts, tags, sk, String(i)), b = mk(kind, ts, tags, sk, String(i + 1000));
    if (a.id !== b.id) return a.id < b.id ? [a, b] : [b, a];
  }
}

test('root cause: upstream store keeps replaced versions in SQLite (remove() is given an event, not an id)', () => {
  const db = new NativeSqliteEventDatabase(':memory:'), store = new EventStore({ database: db });
  store.add(mk(3, 100, [P('a'), P('b')])); store.add(mk(3, 200, [P('c')]));
  assert.equal(n(db, 'SELECT count(*) FROM events WHERE kind = 3'), 2, 'if this fails, upstream fixed it: revisit ADR-0003');
});

test('a newer replaceable event replaces the old one and its tag rows, through the event store', () => {
  const { db, store } = setup();
  const old = mk(3, 100, [P('a'), P('b')]), neu = mk(3, 200, [P('c')]);
  store.add(old); store.add(neu);
  assert.deepEqual(rows(db, 'SELECT id FROM events').map((r) => r.id), [neu.id]);
  assert.equal(n(db, 'SELECT count(*) FROM event_tags WHERE event_id = ?', old.id), 0);
  assert.equal(n(db, 'SELECT count(*) FROM event_tags WHERE event_id = ?', neu.id), 1);
  assert.equal(store.getReplaceable(3, neu.pubkey).id, neu.id);
});

test('an older version arriving later is ignored', () => {
  const { db, store } = setup();
  const neu = mk(0, 200, [], sk, '{"name":"new"}'), old = mk(0, 100, [], sk, '{"name":"old"}');
  store.add(neu);
  assert.equal(db.add(old).id, neu.id, 'database returns the stored winner');
  store.add(old);
  assert.deepEqual(rows(db, 'SELECT id FROM events').map((r) => r.id), [neu.id]);
});

test('on a created_at tie the lowest id wins, whichever arrives first', () => {
  for (const order of ['low-first', 'high-first']) {
    const { db } = setup();
    const [low, high] = tiePair(10002, 500, [['r', 'wss://a.example']]);
    assert.ok(beats(low, high) && !beats(high, low));
    if (order === 'low-first') { db.add(low); db.add(high); } else { db.add(high); db.add(low); }
    assert.deepEqual(rows(db, 'SELECT id FROM events').map((r) => r.id), [low.id], order);
    assert.equal(n(db, 'SELECT count(*) FROM event_tags WHERE event_id = ?', high.id), 0, order);
  }
});

test('addressable events are kept per d tag; replaceable kinds ignore a stray d tag', () => {
  const { db } = setup();
  const a1 = mk(30023, 100, [['d', 'post-a']]), a2 = mk(30023, 200, [['d', 'post-a']]), b1 = mk(30023, 150, [['d', 'post-b']]);
  db.add(a1); db.add(b1); db.add(a2);
  assert.deepEqual(rows(db, 'SELECT id FROM events ORDER BY created_at').map((r) => r.id), [b1.id, a2.id]);
  const k3 = mk(3, 100, [P('a')]), k3d = mk(3, 200, [['d', 'x'], P('b')]);
  db.add(k3); db.add(k3d);
  assert.deepEqual(rows(db, 'SELECT id FROM events WHERE kind = 3').map((r) => r.id), [k3d.id], 'one follow list per pubkey');
  assert.equal(db.getReplaceable(3, k3d.pubkey)?.id, k3d.id, 'found by (kind, pubkey)');
  assert.equal(db.getReplaceable(30023, a2.pubkey, 'post-a')?.id, a2.id);
  const other = mk(3, 50, [P('a')], sk2);
  db.add(other);
  assert.equal(n(db, 'SELECT count(*) FROM events WHERE kind = 3'), 2, 'other authors keep their own');
});

test('regular events, duplicates and other kinds are untouched', () => {
  const { db, store } = setup();
  const n1 = mk(1, 100, [P('a')]), n2 = mk(1, 200, [P('a')]), r = mk(7, 300, [['e', 'f'.repeat(64)]]);
  for (const e of [n1, n2, r, n1]) store.add(e);
  const k = mk(10000, 100, [P('a')]);
  db.add(k); db.add(k);
  assert.equal(n(db, 'SELECT count(*) FROM events'), 4);
  assert.equal(n(db, 'SELECT count(*) FROM event_tags WHERE event_id = ?', k.id), 1);
});

function legacyStore(file) {
  // Build a store the way v0.2.7 did, so replaced versions pile up.
  const db = new NativeSqliteEventDatabase(file), store = new EventStore({ database: db });
  for (let t = 1; t <= 5; t++) store.add(mk(3, 100 * t, [P('a'), P('b'), P(String(t))]));
  for (let t = 1; t <= 3; t++) store.add(mk(0, 100 * t, [], sk, `{"v":${t}}`));
  store.add(mk(30023, 100, [['d', 'x']])); store.add(mk(30023, 200, [['d', 'x']])); store.add(mk(30023, 150, [['d', 'y']]));
  store.add(mk(3, 100, [P('z')], sk2));
  for (let t = 1; t <= 4; t++) store.add(mk(1, t, [P('a')]));
  db.db.exec("PRAGMA foreign_keys = OFF; INSERT INTO event_tags VALUES ('" + '9'.repeat(64) + "', 'p', 'gone')");
  db.close();
}

test('compaction removes only replaced versions and orphan tags, takes no backup, and is safe to re-run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcompact-')), file = path.join(dir, 'events.db');
  try {
    legacyStore(file);
    const lines = [], log = (s) => lines.push(s);
    const r = compact(file, { log });
    assert.equal(r.done, true);
    assert.deepEqual(r.removed.byKind, { 0: 2, 3: 4, 30023: 1 });
    assert.equal(r.removed.events, 7); assert.equal(r.removed.tags, 4 * 3 + 1, 'kind-3 p tags plus the old article d tag'); assert.equal(r.removed.orphanTags, 1);
    assert.equal(r.before.events - r.after.events, 7);
    assert.ok(r.after.bytes <= r.before.bytes);
    const db = new DatabaseSync(file);
    const kinds = db.prepare('SELECT kind, count(*) n FROM events GROUP BY kind ORDER BY kind').all().map((x) => [x.kind, x.n]);
    assert.deepEqual(kinds, [[0, 1], [1, 4], [3, 2], [30023, 2]], 'one per slot, all regular notes kept');
    assert.equal(db.prepare('SELECT created_at FROM events WHERE kind = 3 AND pubkey = (SELECT pubkey FROM events WHERE kind = 0)').get().created_at, 500, 'the newest follow list stays');
    db.close();
    assert.deepEqual(fs.readdirSync(dir).sort(), ['events.db'], 'no backup or temp files left');
    assert.ok(lines.some((l) => /removed 7 replaced versions/.test(l)) && lines.some((l) => /->/.test(l)), 'logs counts and sizes');
    assert.equal(compact(file, { log }).reason, 'clean', 're-run does nothing');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('compaction refuses to start without enough free disk, and drops v0.2.8 backups', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcompact-')), file = path.join(dir, 'events.db');
  try {
    legacyStore(file);
    const before = fs.readFileSync(file);
    const low = compact(file, { log: () => {}, freeSpace: () => 1024 });
    assert.equal(low.reason, 'disk');
    assert.ok(low.need >= low.before.bytes * 2, 'needs room for VACUUM and the journal');
    assert.ok(before.equals(fs.readFileSync(file)), 'nothing changed');
    const b = path.join(dir, 'backups');
    fs.mkdirSync(b);
    fs.writeFileSync(path.join(b, 'events-20261111T154634Z.db'), 'x'.repeat(1000));
    fs.writeFileSync(path.join(b, 'events-20261111T154634Z.db-journal'), 'y');
    const lines = [];
    assert.equal(compact(file, { log: (l) => lines.push(l) }).dropped, 1001);
    assert.ok(!fs.existsSync(b), 'empty backups folder removed');
    assert.ok(lines.some((l) => /removed old backups/.test(l)));
    fs.mkdirSync(b);
    fs.writeFileSync(path.join(b, 'events-20200101T000000Z.db'), 'old');
    fs.writeFileSync(path.join(b, 'keep-me.txt'), 'not ours');
    assert.equal(compact(file, { log: () => {} }).reason, 'clean', 'backups go even when the store is already clean');
    assert.deepEqual(fs.readdirSync(b), ['keep-me.txt'], 'other files are left alone');
    const db = new DatabaseSync(file); const m = measure(db); db.close();
    assert.equal(m.stale + m.orphanTags, 0);
    assert.equal(compact(path.join(dir, 'missing.db'), { log: () => {} }).reason, 'missing');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
