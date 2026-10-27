# Hibiki — Handoff

**Repo:** `ChiefmonkeyArt/torii-hibiki` (public). **Route:** `/hibiki/`. **Registry name:** `hibiki`. **Version markers:** `VERSION`, `package.json`, `service/package.json`, `service/package-lock.json`, the footer of `web/index.html` and the README (all checked by `npm test`).

**Release rule:** land through a merged PR, tag `v<VERSION>` on the merge commit, and the owner installs from the tag:

```bash
cd ~/torii-hibiki 2>/dev/null || { git clone https://github.com/ChiefmonkeyArt/torii-hibiki.git ~/torii-hibiki && cd ~/torii-hibiki; }; git fetch --tags && git checkout v0.2.0 && sudo ./install.sh && curl -s https://chiefmonkey.art/hibiki/api/health
```

The installer finds the owner npub in the Suite `.env` (`CONTINUUM_ADMIN_NPUB`) or Continuum's `admin_npub`; pass it as the first argument otherwise. It needs Node 22.13+ and npm.

**VPS layout:** `/apps/hibiki/{current,releases/<ts>}` (five kept; each has `web/`, `service/` with its own `node_modules`, `VERSION`), `/opt/torii/nginx-fragments/hibiki.conf`, `/etc/hibiki/hibiki.env` (0640 root:hibiki: owner, HMAC secret kept across upgrades, port 8795, origin, relays), `/var/lib/hibiki` (0700: `events.db`, image `cache/`), unit `hibiki-feed.service` (user `hibiki`, loopback only, `MemoryMax=320M`, `ProtectSystem=strict`).

**What the service does:** reads the owner's follows and where they post (NIP-65), stores 14 days of their public posts and reactions in SQLite, works out public features (circle, friend-of-friend, reactions, zaps, spam), and proxies images, video and link previews so third-party hosts never see the reader. It relays only events the owner signed in their own signer after confirming. It holds no keys.

**Live check:** `curl -s https://chiefmonkey.art/hibiki/api/health` returns `"version":"0.2.0"`; `curl -s https://chiefmonkey.art/torii/apps.json` lists `hibiki` at 0.2.0. Logs: `journalctl -u hibiki-feed -n 50`.

**Development:** `HIBIKI_DEV=1` (with owner, secret, data dir and origin in env) lets loopback requests skip sign-in; never set it on a VPS (the installer never writes it). Run `node service/src/server.mjs` and `node tools/dev-server.mjs` (serves `web/` with the production headers on :8790 and proxies the API). Tests: `npm test` (needs Node 22.13+ and `npm ci` in `service/`).

**Built in v0.2.0 (ADR-0001 rev 4, section 9):** Applesauce runs on the node only for now; the browser never connects to relays. The napplet is opaque-origin with `connect-src 'none'`; every media URL it gets is an HMAC-signed node path. Ranking weights stay in the browser; `web/rank.js` is shared by node and browser.

**Settled plumbing (ADR-0001 rev 3, PR #4; refined by rev 4):**
- **Applesauce v7 (MIT)** is the Nostr client layer: on the node since v0.2.0, in the shell from P2 (signers, sealing). It covers the relay pool, NIP-42, outbox routing, social-graph/timeline/reactions/zaps loaders, NIP-85 and 10040 helpers, the `applesauce-sqlite` store on the node, and content parsing. Signers stay shell-only.
  - Pin exact versions, matching Quest's ADR-0140 pins where they overlap.
  - Use one thin adapter file each in the shell and the service, so a major upstream release costs one file.
  - The napplet never bundles it.
  - Budget, enforced in tests: shell ≤ 8 KB and napplet ≤ 32 KB gzip today (ceilings 60 KB and 150 KB once Applesauce enters the shell).
  - Hibiki's own checks (bindings, quorum, no laundering, consent) run on every event, whatever library fetched it.
- **FIPS** is the default node↔node route wherever both ends support it, with automatic `wss://` fallback. It sits under the Applesauce relay connection and adds reachability, not trust.
  - Browsers, public relays and image hosts stay on `wss://` or HTTPS.
  - Owner devices move to FIPS once the mobile path (fips2go/Capacitor) is ready.
  - P5 measures FIPS against `wss://` per peer.

**Next:** owner installs v0.2.0 and does phone acceptance, then P1 polish (see `hibiki-todo.md`).
