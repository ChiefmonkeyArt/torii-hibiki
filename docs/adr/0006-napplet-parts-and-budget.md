# ADR-0006: The napplet is a core file plus one file per section; first load ≤ 32 KB, all ≤ 42 KB

- **Status:** Accepted (2026-11-12; shipped in v0.2.13)
- **Applies to:** `web/napplet.js`, `web/sec-*.js`, the size test in `tools/test.mjs` and the installer preflight.
- **Replaces:** the "napplet ≤ 32 KB gzip" budget recorded in the handoff and roadmap. Amends ADR-0001 (section on the size budget), whose 150 KB ceiling stays as the outer limit.

## Context

The napplet was one file holding every section. By v0.2.12 it was 32,023 bytes gzipped, at the 32 KB budget, so each new News feature would have pushed it over. The 32 KB figure was a self-chosen target (a phone on a slow link draws the first screen in under 2 seconds); ADR-0001 allows 150 KB. A reader who opens only Today was still downloading the code for the reader, the zap sheet, Your signal and every other section.

For comparison, the JavaScript each comparable Nostr web client transferred on first load, measured in a headless browser on 2026-11-12: primal.net 5,429 KB, iris.to 3,429 KB, nostrudel.ninja 1,120 KB, jumble.social 707 KB, snort.social 705 KB, coracle.social 604 KB.

## Decision

1. **Core plus parts.** `web/napplet.js` keeps shared state, the card and story renderers, navigation and the message bridge with the shell. Each section lives in `web/sec-<name>.js` (today, circle, news, watch, listen, read, signal, person, zap) and registers with `HibikiNap.def('<name>', function (K) { ... })`, taking what it needs from a fixed kit `K`.
2. **Loaded on first use.** `need(name)` adds one `<script src="sec-<name>.js">` and caches the result. Names come only from the fixed `PARTS` list; unknown names are refused. Files are relative and same-origin, so the napplet CSP (`script-src 'self'`) is unchanged. When a section opens, its data and its part load in parallel.
3. **Budgets, enforced in tests (gzip):** first load (napplet.html, napplet.js, rank.js, napplet.css, hibiki.css) ≤ 32 KB; each part ≤ 8 KB; all napplet files together ≤ 42 KB. ADR-0001's 150 KB stays the outer ceiling; raising 42 KB needs a new note here.
4. **Checks.** A repo test confirms `PARTS` matches the files, there is one loader, every name a part takes from `K` is in the kit, and every function a part calls is defined or taken from the kit. The installer refuses to install if a part file is missing or is a symlink.

## Consequences

- v0.2.13 first load: 26,050 bytes (was 32,023) even after the new News features; all napplet files 40,305 bytes.
- Opening a section for the first time costs one small extra request (0.4-3 KB), made at the same time as its data request.
- Splitting adds a kit of names that parts must use; the repo test catches a missing one, which it did once during the split.
