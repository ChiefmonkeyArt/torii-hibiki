// eventdb.mjs — the node's event database: applesauce's native SQLite store with
// NIP-01 replacement enforced inside the insert transaction (ADR-0003).
//
// Why: applesauce-core's EventStore removes losing versions with
// `database.remove(event)`, but the native database's remove() takes an id and
// swallows the bind error, so old versions were never deleted (kind 3 follow
// lists piled up with all their tag rows). Here the winner check, the insert
// and the delete of every losing version (and its event_tags rows) are one
// transaction, so the store holds exactly one version per replaceable slot:
//   - replaceable kinds 0, 3, 10000-19999: one per (pubkey, kind)
//   - addressable kinds 30000-39999: one per (pubkey, kind, d tag)
//   - newest created_at wins; on a tie the lowest id wins
//   - an older version arriving later is ignored (the stored winner is returned)
// remove() is left as upstream on purpose: the same bug stops NIP-09 deletions
// reaching the database, and fixing that is a separate retention change (ADR-0003).
// GPL-3.0-or-later.
import { NativeSqliteEventDatabase } from 'applesauce-sqlite/native';
import { getIndexableTags, getReplaceableIdentifier } from 'applesauce-core/helpers';

export const isReplaceableKind = (k) => k === 0 || k === 3 || (k >= 10000 && k < 20000);
export const isAddressableKind = (k) => k >= 30000 && k < 40000;
/** NIP-01: does a beat b? Newer created_at, then lower id. */
export const beats = (a, b) => a.created_at > b.created_at || (a.created_at === b.created_at && a.id < b.id);

export class HibikiEventDatabase extends NativeSqliteEventDatabase {
  constructor(file, options) {
    if (options?.search) throw new Error('HibikiEventDatabase does not support search');
    super(file, options);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000');
    const p = (sql) => this.db.prepare(sql);
    this.q = {
      slot: p('SELECT id, created_at FROM events WHERE kind = ? AND pubkey = ?'),
      addr: p('SELECT id, created_at FROM events WHERE kind = ? AND pubkey = ? AND identifier = ?'),
      ins: p('INSERT OR IGNORE INTO events (id, kind, pubkey, created_at, content, tags, sig, identifier) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
      tag: p('INSERT OR IGNORE INTO event_tags (event_id, tag_name, tag_value) VALUES (?, ?, ?)'),
      untag: p('DELETE FROM event_tags WHERE event_id = ?'),
      del: p('DELETE FROM events WHERE id = ?'),
    };
  }

  add(event) {
    const k = event.kind;
    if (!isReplaceableKind(k) && !isAddressableKind(k)) return super.add(event);
    // Replaceable kinds ignore any stray d tag: the slot is (pubkey, kind), stored with identifier ''.
    const d = isAddressableKind(k) ? getReplaceableIdentifier(event) : '';
    const q = this.q;
    let winner = null;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows = isAddressableKind(k) ? q.addr.all(k, event.pubkey, d) : q.slot.all(k, event.pubkey);
      if (rows.some((r) => r.id === event.id)) { this.db.exec('COMMIT'); return event; }
      for (const r of rows) if (beats(r, event) && (!winner || beats(r, winner))) winner = r;
      if (!winner) {
        q.ins.run(event.id, k, event.pubkey, event.created_at, event.content, JSON.stringify(event.tags), event.sig, d);
        for (const s of getIndexableTags(event) || []) {
          const i = s.indexOf(':'), name = s.slice(0, i), value = s.slice(i + 1);
          if (name && value) q.tag.run(event.id, name, value);
        }
        for (const r of rows) { q.untag.run(r.id); q.del.run(r.id); }
      }
      this.db.exec('COMMIT');
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw e;
    }
    return winner ? (this.getEvent(winner.id) || event) : event;
  }
}
