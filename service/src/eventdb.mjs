// eventdb.mjs — the node's event database: applesauce's native SQLite store
// with NIP-01 replacement in the insert transaction (ADR-0003) and a lean tag
// table with honoured deletions (ADR-0004).
//
// Replacement (ADR-0003): applesauce-core removes losing versions with
// `database.remove(event)`, but the native database's remove() takes an id
// and swallows the bind error. Here the winner check, the insert and the
// delete of every losing version (and its tag rows) are one transaction:
//   - replaceable kinds 0, 3, 10000-19999: one per (pubkey, kind)
//   - addressable kinds 30000-39999: one per (pubkey, kind, d tag)
//   - newest created_at wins; on a tie the lowest id wins
//   - an older version arriving later is ignored (the stored winner is returned)
//
// Tags (ADR-0004): one copy per row (schema.mjs), no foreign key, so every
// delete here removes the event's own tag rows by primary key. Follow lists
// get no tag rows. remove() takes an event or an id; withDeletions() makes
// NIP-09 deletions verified, persistent across restarts and effective.
// GPL-3.0-or-later.
import { DatabaseSync } from 'node:sqlite';
import { NativeSqliteEventDatabase } from 'applesauce-sqlite/native';
import { getIndexableTags, getReplaceableIdentifier } from 'applesauce-core/helpers';
import { verifyEvent } from 'nostr-tools/pure';
import { prepareSchema, UNTAGGED_KINDS } from './schema.mjs';

export const isReplaceableKind = (k) => k === 0 || k === 3 || (k >= 10000 && k < 20000);
export const isAddressableKind = (k) => k >= 30000 && k < 40000;
/** NIP-01: does a beat b? Newer created_at, then lower id. */
export const beats = (a, b) => a.created_at > b.created_at || (a.created_at === b.created_at && a.id < b.id);
export const ENGAGE_PRUNE_KINDS = [6, 7, 16, 9735];
export const DELETE_KIND = 5;

/** The [name, value] rows an event has in event_tags. */
export function tagRows(event) {
  if (UNTAGGED_KINDS.has(event.kind)) return [];
  const out = [];
  for (const s of getIndexableTags(event) || []) {
    const i = s.indexOf(':'), name = s.slice(0, i), value = s.slice(i + 1);
    if (name && value) out.push([name, value]);
  }
  return out;
}

export class HibikiEventDatabase extends NativeSqliteEventDatabase {
  constructor(file = ':memory:', options) {
    if (options?.search) throw new Error('HibikiEventDatabase does not support search');
    const db = typeof file === 'string' ? new DatabaseSync(file) : file;
    db.exec('PRAGMA busy_timeout = 5000');
    // Before the upstream open, so its CREATE ... IF NOT EXISTS finds our tag table.
    const schema = prepareSchema(db);
    super(db, options);
    this.schema = schema;
    const p = (sql) => this.db.prepare(sql);
    this.q = {
      slot: p('SELECT id, created_at, kind, tags FROM events WHERE kind = ? AND pubkey = ?'),
      addr: p('SELECT id, created_at, kind, tags FROM events WHERE kind = ? AND pubkey = ? AND identifier = ?'),
      one: p('SELECT id, kind, tags FROM events WHERE id = ?'),
      ins: p('INSERT OR IGNORE INTO events (id, kind, pubkey, created_at, content, tags, sig, identifier) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
      tag: p('INSERT OR IGNORE INTO event_tags (tag_name, tag_value, event_id) VALUES (?, ?, ?)'),
      untag: p('DELETE FROM event_tags WHERE tag_name = ? AND tag_value = ? AND event_id = ?'),
      del: p('DELETE FROM events WHERE id = ?'),
    };
  }

  /** Run fn in one write transaction. */
  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); this.db.exec('COMMIT'); return r; }
    catch (e) { try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ } throw e; }
  }

  /** Delete a stored row ({id, kind, tags}) and its tag rows; inside a transaction. */
  drop(row) {
    const ev = { kind: row.kind, tags: typeof row.tags === 'string' ? JSON.parse(row.tags || '[]') : row.tags || [] };
    for (const [n, v] of tagRows(ev)) this.q.untag.run(n, v, row.id);
    return this.q.del.run(row.id).changes > 0;
  }

  add(event) {
    const k = event.kind;
    if (!isReplaceableKind(k) && !isAddressableKind(k)) {
      // Upstream insert; its tag insert names columns, so it fits the lean table.
      return super.add(event);
    }
    // Replaceable kinds ignore any stray d tag: the slot is (pubkey, kind), stored with identifier ''.
    const d = isAddressableKind(k) ? getReplaceableIdentifier(event) : '';
    const q = this.q;
    let winner = null;
    const dup = this.tx(() => {
      const rows = isAddressableKind(k) ? q.addr.all(k, event.pubkey, d) : q.slot.all(k, event.pubkey);
      if (rows.some((r) => r.id === event.id)) return true;
      for (const r of rows) if (beats(r, event) && (!winner || beats(r, winner))) winner = r;
      if (winner) return false;
      q.ins.run(event.id, k, event.pubkey, event.created_at, event.content, JSON.stringify(event.tags), event.sig, d);
      for (const [n, v] of tagRows(event)) q.tag.run(n, v, event.id);
      for (const r of rows) this.drop(r);
      return false;
    });
    if (dup) return event;
    return winner ? (this.getEvent(winner.id) || event) : event;
  }

  /** Delete by id or event (applesauce-core passes events; ADR-0003/0004). */
  remove(idOrEvent) {
    const id = typeof idOrEvent === 'string' ? idOrEvent : idOrEvent?.id;
    if (!id) return false;
    return this.tx(() => { const row = this.q.one.get(id); return row ? this.drop(row) : false; });
  }

  removeByFilters(filters) {
    const rows = this.getByFilters(filters);
    if (!rows.length) return 0;
    return this.tx(() => { let n = 0; for (const r of rows) if (this.drop(r)) n++; return n; });
  }

  /**
   * ADR-0004: drop other people's reactions, reposts and zap receipts older than
   * `until`, keeping the owner's own and any that tag the owner (p or P).
   */
  pruneEngagement(until, owner) {
    const kinds = ENGAGE_PRUNE_KINDS.join(', ');
    const rows = this.db.prepare(`SELECT id, kind, tags FROM events
      WHERE kind IN (${kinds}) AND created_at < ? AND pubkey != ?
        AND NOT EXISTS (SELECT 1 FROM event_tags WHERE tag_name = 'p' AND tag_value = ? AND event_id = events.id)
        AND NOT EXISTS (SELECT 1 FROM event_tags WHERE tag_name = 'P' AND tag_value = ? AND event_id = events.id)`).all(until, owner, owner, owner);
    if (!rows.length) return 0;
    return this.tx(() => { let n = 0; for (const r of rows) if (this.drop(r)) n++; return n; });
  }
}

/**
 * NIP-09 for the node (ADR-0004). applesauce-core's EventStore keeps kind 5
 * only in memory and does not verify it. This checks the signature, stores the
 * deletion, then lets the store act on it; stored deletions are replayed on
 * start so a deleted event fetched again after a restart is still refused.
 */
export function withDeletions(store, { verify = verifyEvent } = {}) {
  const db = store.database;
  const add = store.add.bind(store);
  store.add = (event, fromRelay) => {
    if (event?.kind !== DELETE_KIND) return add(event, fromRelay);
    if (!verify(event)) return null;
    db.add(event);
    return add(event, fromRelay);
  };
  let replayed = 0;
  for (const e of db.getByFilters({ kinds: [DELETE_KIND] })) { store.deletes.add(e); replayed++; }
  return { replayed };
}
