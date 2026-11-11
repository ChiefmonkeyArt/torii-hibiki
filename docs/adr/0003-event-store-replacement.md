# ADR-0003: One stored version per replaceable event, and a one-off store compaction

- **Status:** Accepted (2026-11-11; shipped in v0.2.8; amended in v0.2.9: no backup)
- **Applies to:** the feed service's event store (`/var/lib/hibiki/events.db`) and the installer's release retention.
- **Relates to:** ADR-0001 (Applesauce v7 and `applesauce-sqlite` on the node), ADR-0002 (owner-approved deploys).

## Context

On 2026-11-11 the owner measured `events.db` on chiefmonkey.art at 1,003 MB, with no free pages. It held 125,941 events. Almost all of them were less than 90 days old, so age-based retention could not shrink it.

| Object | Size |
|---|---|
| `sqlite_autoindex_event_tags_1` (event_tags primary key) | 265 MB |
| `event_tags_name_value_event_idx` | 260 MB |
| `event_tags` (1,638,388 rows) | 226 MB |
| `events` | 202 MB |
| `replaceable_idx`, `pubkey_kind_created_at_idx`, `pubkey_created_at_idx`, `sqlite_autoindex_events_1` | about 12 MB each |

The store also held versions that a newer one had already replaced: 1,397 old kind-3 follow lists, 143 old kind-0 profiles and 92 old kind-10002 relay lists. The old follow lists alone accounted for 1,027,567 tag rows, 63% of `event_tags`, because each follow list has one `p` tag per follow.

### Root cause

`applesauce-core` 7.0.3's `EventStore.add` works out the NIP-01 winner correctly and calls `this.remove(old)` for each losing version. `remove()` then calls `database.remove(event)` with the event object. `applesauce-sqlite` 7.0.0's `NativeSqliteEventDatabase.remove(id)` binds that object into `DELETE FROM events WHERE id = ?`. The bind throws, the error is caught, and `remove` returns `false`. So the memory store was replaced, but the SQLite store kept every old version. `replaceable_idx` only indexes rows. It does not enforce uniqueness.

The same `remove(event)` call is used for NIP-09 deletions (`handleDeleteNotification`), so deleted events also stay in SQLite. Removal on expiry passes an id, so it works.

## Decision

### 1. Enforce replacement in the database (`service/src/eventdb.mjs`)

`HibikiEventDatabase` extends `NativeSqliteEventDatabase`, and the service uses it in place of the stock class. For replaceable and addressable kinds, `add()` does the following in one `BEGIN IMMEDIATE` transaction:

- Read the slot:
  - kinds 0, 3 and 10000–19999: (pubkey, kind). A stray `d` tag is ignored and stored as the identifier `''`, so these lookups still find the event.
  - kinds 30000–39999: (pubkey, kind, `d` tag).
- If the same id is already stored, do nothing.
- If a stored version wins (newer `created_at`, or the same `created_at` and a lower id), ignore the incoming event and return the stored winner. An older event arriving later never overwrites a newer one.
- Otherwise insert the event and its tag rows, then delete every older version and its `event_tags` rows.

The transaction makes the insert and the delete atomic. Foreign keys are on, so deleting by id also cascades. All other kinds use the upstream path unchanged.

`remove()` is deliberately left as upstream. Fixing it would also make NIP-09 deletions start removing events, which is a separate retention change (see "Later").

### 2. One-off compaction (`service/src/compact.mjs`, run by the installer)

`install.sh` stops `hibiki-feed` before the flip and runs `compact.mjs` as the `hibiki` user, with `SQLITE_TMPDIR` set to the data directory. The script:

1. Records the size, event and tag counts, and free disk.
2. Finds old versions using the same rules as section 1, plus tag rows whose event no longer exists.
3. Stops with "nothing to do" if there are none and little free space inside the file. This is what makes it safe to re-run.
4. Requires free disk of twice the file size plus 256 MB (VACUUM's copy and the rollback journal). Without that it changes nothing and logs why.
5. Takes no backup (v0.2.9; see the amendment below).
6. Deletes the old versions' tag rows, the old versions and the orphaned tag rows in one transaction, then runs `VACUUM`.
7. Logs the counts per kind, the size before and after, and the free disk, in the deploy log.

No other event is touched and no retention rule changes. If the compaction fails, the installer logs a warning and finishes the deploy with the store as it was.

Rehearsal on the development copy (26,809 events): 459 old versions removed (kind 3: 337, kind 0: 78, kind 10002: 44) with 259,779 tag rows; 370.6 MB down to 190.2 MB in about 6 s; the second run did nothing. The owner's figures predict about 1 GB down to about 450 MB on chiefmonkey.art.

### 3. Release retention

The installer keeps the current release plus one spare (`KEEP_RELEASES=2`, previously 5; each release is about 75 MB with its own `node_modules`). The current release is never removed. The first v0.2.8 deploy trims the existing five down to two.

## Consequences

- The store stays at one version per slot, so follow lists no longer grow by one copy and about 700 tag rows each time someone updates their follows.
- One deploy stops the service for the length of the compaction (seconds to a few minutes). 
- The fix lives in one subclass, so it can be dropped when upstream fixes `remove(event)`. A test fails when the stock class stops leaving old versions behind.

## Amendment (v0.2.9, 2026-11-11): no backup

v0.2.8 took a checked `VACUUM INTO` copy before compacting; on chiefmonkey.art that was 921 MB. The owner pointed out that `events.db` is a cache: everything in it comes from relays, and a fresh install fills it again. The code lives on GitHub and ngit, and the owner's own events (including the wallet record, kind 30078) live on their relays. So the copy protected nothing that cannot be fetched again, and it cost about as much disk as the store itself.

- `compact.mjs` no longer takes a backup, and needs only twice the file size plus 256 MB free.
- On every run, including when the store is already clean, it deletes the v0.2.8 copies (`<data>/backups/events-<UTC>.db` and any journal), then removes the folder if it is empty. Other files are left alone.
- If a compaction fails part-way, the worst case is a store that has to refill from relays. The delete is one transaction and VACUUM is atomic, so in practice the store stays as it was.

## Later (options, not decided)

- **`event_tags` stored three times:** the table, its primary-key index (event_id, tag_name, tag_value) and `event_tags_name_value_event_idx` (tag_name, tag_value, event_id) hold the same columns. A `WITHOUT ROWID` table keyed on (tag_name, tag_value, event_id) with a small event_id index could save about 150–200 MB at today's size. This needs a schema migration that the upstream library does not know about.
- **Time limits for other people's engagement:** posts and engagement already share the `HIBIKI_RETAIN_DAYS` prune (`ingest.mjs`, by `created_at`). Other people's reactions (kind 7, about 63,000 rows), reposts (6, 16) and zap receipts (9735) could get a shorter window of their own, keeping the owner's own.
- **NIP-09 deletions:** deleted events stay in SQLite for the same `remove(event)` reason. Removing them is a retention change and needs its own decision.
- **Upstream:** report `remove(event)` against `applesauce-sqlite` / `applesauce-core`.
