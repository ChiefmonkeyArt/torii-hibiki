// schema.mjs — Hibiki's own layout for the event store's tag table (ADR-0004).
// One copy of each tag row: a WITHOUT ROWID table keyed the way every tag
// filter reads it, no event_id index and no foreign key (HibikiEventDatabase
// deletes tag rows by primary key). The empty partial index takes the name
// applesauce-sqlite creates on every open, so its CREATE INDEX IF NOT EXISTS
// is a no-op. Follow lists (kind 3) get no tag rows. No dependencies, so the
// installer's compact.mjs can run it with the service stopped.
// GPL-3.0-or-later.

export const UNTAGGED_KINDS = new Set([3]);

const CREATE = `CREATE TABLE event_tags (
    tag_name TEXT NOT NULL,
    tag_value TEXT NOT NULL,
    event_id TEXT NOT NULL,
    PRIMARY KEY (tag_name, tag_value, event_id)
  ) WITHOUT ROWID`;
const PLACEHOLDER = 'CREATE INDEX event_tags_name_value_event_idx ON event_tags(tag_name) WHERE 0';

const tableSql = (db) => db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'event_tags'").get()?.sql || '';

/** Is the tag table already in the lean layout? */
export const isLean = (db) => /WITHOUT ROWID/i.test(tableSql(db));

/**
 * Create or migrate the tag table. Returns { created } for a new store,
 * { migrated, kept, dropped } after a migration, or {} when already lean.
 */
export function prepareSchema(db) {
  const old = tableSql(db);
  if (/WITHOUT ROWID/i.test(old)) {
    // Keep the placeholder in place, or the upstream open would build the full index again.
    const idx = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'event_tags_name_value_event_idx'").get()?.sql || '';
    if (!/WHERE 0$/.test(idx)) db.exec(`DROP INDEX IF EXISTS event_tags_name_value_event_idx; ${PLACEHOLDER}`);
    return {};
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!old) {
      db.exec(`${CREATE}; ${PLACEHOLDER}`);
      db.exec('COMMIT');
      return { created: true };
    }
    const before = Object.values(db.prepare('SELECT count(*) FROM event_tags').get())[0];
    const skip = [...UNTAGGED_KINDS].join(', ');
    db.exec(`CREATE TABLE event_tags_lean (
        tag_name TEXT NOT NULL,
        tag_value TEXT NOT NULL,
        event_id TEXT NOT NULL,
        PRIMARY KEY (tag_name, tag_value, event_id)
      ) WITHOUT ROWID`);
    // Keep rows whose event exists and is not an untagged kind; orphans go too.
    db.exec(`INSERT OR IGNORE INTO event_tags_lean (tag_name, tag_value, event_id)
      SELECT t.tag_name, t.tag_value, t.event_id FROM event_tags t JOIN events e ON e.id = t.event_id
       WHERE e.kind NOT IN (${skip})`);
    const kept = Object.values(db.prepare('SELECT count(*) FROM event_tags_lean').get())[0];
    db.exec('DROP TABLE event_tags');
    db.exec('ALTER TABLE event_tags_lean RENAME TO event_tags');
    db.exec(PLACEHOLDER);
    db.exec('COMMIT');
    return { migrated: true, kept, dropped: before - kept };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw e;
  }
}
