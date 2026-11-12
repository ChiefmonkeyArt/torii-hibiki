# ADR-0004: A lean event store — one copy of each tag, honoured deletions, shorter engagement window

- **Status:** Accepted (2026-11-12; shipped in v0.2.11)
- **Applies to:** the feed service's event store (`/var/lib/hibiki/events.db`) and its retention.
- **Relates to:** ADR-0003 (one version per replaceable event; this ADR takes up its "Later" list), ADR-0001 (Applesauce v7 and `applesauce-sqlite` on the node).

## Context

After ADR-0003 the store on chiefmonkey.art is 446 MB: 124,534 events and 610,969 tag rows. Measured on the compacted development copy (26,350 events, 190 MB), the tag rows still take three copies of the same three columns:

| Object | Size |
|---|---|
| `event_tags` (rowid table) | 46.6 MB |
| `sqlite_autoindex_event_tags_1` (primary key: event_id, tag_name, tag_value) | 46.6 MB |
| `event_tags_name_value_event_idx` (tag_name, tag_value, event_id) | 46.7 MB |
| `events` | 41.6 MB |

Of 345,000 tag rows, 270,914 (78%) are the `p` tags of follow lists (kind 3). Hibiki never filters the store by a follow list's tags. It reads follow lists whole with `getReplaceable(3, pubkey)`. The store's tag filters are only `#e` (replies, reactions, reposts, zaps), `#a` (highlights) and `#p` on zap receipts.

Deletions (NIP-09, kind 5) are not honoured. Hibiki never asks relays for them. If one did arrive, applesauce's `EventStore` would:

- keep it only in memory, so a restart forgets it;
- skip signature verification;
- fail to delete the target from SQLite, because of the `remove(event)` bug in ADR-0003.

So posts their authors deleted can stay in the feed.

Engagement from other people (reactions, reposts, zap receipts) is kept as long as posts (`HIBIKI_RETAIN_DAYS`, 14). But the feed only counts it for posts inside its 7-day Watch and News windows. Reactions alone (kind 7) are the largest kind by count.

## Decision

### 1. One copy of each tag row

`service/src/schema.mjs` owns the tag table:

```sql
CREATE TABLE event_tags (
  tag_name TEXT NOT NULL, tag_value TEXT NOT NULL, event_id TEXT NOT NULL,
  PRIMARY KEY (tag_name, tag_value, event_id)
) WITHOUT ROWID;
CREATE INDEX event_tags_name_value_event_idx ON event_tags(tag_name) WHERE 0;
```

- **One copy.** The primary key is the table itself, in the order every tag filter uses (`tag_name = ? AND tag_value IN (...)`).
- **No event_id index and no foreign key.** Either would hold a second full copy, because a `WITHOUT ROWID` index also stores the primary key. `HibikiEventDatabase` instead deletes an event's tag rows by primary key, worked out from the event's own tags. It does this in `add` (replaced versions), `remove` and `removeByFilters`, inside the same transaction as the event delete.
- **The empty index.** `applesauce-sqlite` runs `CREATE INDEX IF NOT EXISTS event_tags_name_value_event_idx` on every open. Because a `WHERE 0` partial index with that name already exists, the statement does nothing and the redundant copy never comes back. The empty index holds no rows and is never used.
- **Columns.** The upstream insert names its columns, so its `INSERT OR IGNORE INTO event_tags (event_id, tag_name, tag_value)` still works.
- **Migration.** One transaction, run when the database opens (`prepareSchema`) or by `compact.mjs` from the installer with the service stopped. It copies tag rows into the new table, then drops the old table with its two indexes and renames the new one. The next VACUUM gives the space back. It runs once; afterwards the schema check is a single `sqlite_master` read.

### 2. No tag rows for follow lists

Kind 3 events are stored whole (`events.tags` keeps every `p`) but get no `event_tags` rows. The migration drops the existing ones. A filter like `{kinds: [3], '#p': [x]}` against the node's store would now return nothing. Hibiki has no such query; a repo check and a test record the rule.

### 3. Deletions are honoured

- **Fetched:** the sync asks the circle's relays for kind 5 by the owner and follows since the last sync. It also adds kind 5 to the engagement request on recent posts. Profile pages fetch the person's recent deletions with their posts.
- **Verified:** `withDeletions(store)` checks every kind 5 signature before it can delete anything. `DeleteManager` still enforces that an author can only delete their own events.
- **Persisted:** kind 5 events are stored in SQLite. On start, the stored deletions are replayed into the store's delete manager, so a deleted event fetched again after a restart is still refused.
- **Removed:** `HibikiEventDatabase.remove` accepts an event as well as an id (the ADR-0003 bug), so the target and its tag rows are actually deleted.
- **Retention:** deletions are kept 90 days, longer than anything they can delete is normally kept.

### 4. Shorter window for other people's engagement

`HIBIKI_ENGAGE_DAYS` (default 7) prunes reactions (7), reposts (6, 16) and zap receipts (9735) older than that. Engagement the owner made, or that tags the owner (`p` or `P`, for example reactions to the owner's posts and the owner's zaps), keeps the normal `HIBIKI_RETAIN_DAYS` window. Posts and every other kind are unchanged.

### 5. Upstream

The `remove(event)` bug (ADR-0003) is reported to applesauce as [issue #122](https://github.com/hzrd149/applesauce/issues/122), along with the note that kind 5 deletions are not persisted. When upstream fixes it, the remove override can go. The tag layout is Hibiki's own and stays in `schema.mjs`.

## Consequences

- Tag storage drops from three copies of every row to one copy of about a fifth of the rows. On the development copy the tag table went from about 140 MB to 8.5 MB (338,935 rows to 67,671) and the whole file from 190.2 MB to 58.7 MB in 1.2 s; a second run had nothing to do. On chiefmonkey.art that suggests 446 MB down to roughly 140–200 MB (measured in the deploy log).
- Deleting an event touches only its own tag rows. Without an event_id index, a tag row whose event is gone can only be found by a full scan, so `compact.mjs` clears any such orphans on each deploy.
- An `applesauce-sqlite` upgrade that changes the tag table or its delete path must be checked against `schema.mjs`. The tests cover tag filters, deletes, prune and the empty index through the stock `EventStore`.
- Engagement counts on posts older than 7 days (only long-form articles stay visible that long) may fall. Your own engagement and engagement on your posts is kept.

## Later (options, not decided)

- Index only the tag names Hibiki queries (`e`, `a`, `p`, `P`). The rest (`t`, `r`, `k` and others) is about 3% of tag rows today.
- Store event ids as integers in `event_tags` (needs the upstream queries rewritten).
