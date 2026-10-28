# Hibiki — Handoff

**Repo:** `ChiefmonkeyArt/torii-hibiki` (public). **Route:** `/hibiki/`. **Registry name:** `hibiki`. **Version markers:** `VERSION`, `package.json`, `service/package.json`, `service/package-lock.json`, the footer of `web/index.html` and the README (all checked by `npm test`).

**Release rule:** land through a merged PR, tag `v<VERSION>` on the merge commit, and the owner installs from the tag:

```bash
cd ~/torii-hibiki 2>/dev/null || { git clone https://github.com/ChiefmonkeyArt/torii-hibiki.git ~/torii-hibiki && cd ~/torii-hibiki; }; git fetch --tags && git checkout v0.2.6 && sudo ./install.sh && curl -s https://chiefmonkey.art/hibiki/api/health
```

The installer finds the owner npub in the Suite `.env` (`CONTINUUM_ADMIN_NPUB`) or Continuum's `admin_npub`; pass it as the first argument otherwise. It needs Node 22.13+ and npm.

**VPS layout:** `/apps/hibiki/{current,releases/<ts>}` (five kept; each has `web/`, `service/` with its own `node_modules`, `VERSION`), `/opt/torii/nginx-fragments/hibiki.conf`, `/etc/hibiki/hibiki.env` (0640 root:hibiki: owner, HMAC secret kept across upgrades, port 8795, origin, relays), `/var/lib/hibiki` (0700: `events.db`, image `cache/`), unit `hibiki-feed.service` (user `hibiki`, loopback only, `MemoryMax=320M`, `ProtectSystem=strict`).

**What the service does:** reads the owner's follows and where they post (NIP-65), stores 14 days of their public posts and reactions in SQLite, works out public features (circle, friend-of-friend, reactions, zaps, spam), and proxies images, video and link previews so third-party hosts never see the reader. It relays only events the owner signed in their own signer after confirming. It holds no keys.

**Live check:** `curl -s https://chiefmonkey.art/hibiki/api/health` returns `"version":"0.2.6"` and `"img"` (the image backend); `curl -s https://chiefmonkey.art/torii/apps.json` lists `hibiki` at 0.2.4. Logs: `journalctl -u hibiki-feed -n 50`.

**Development:** `HIBIKI_DEV=1` (with owner, secret, data dir and origin in env) lets loopback requests skip sign-in; never set it on a VPS (the installer never writes it). Run `node service/src/server.mjs` and `node tools/dev-server.mjs` (serves `web/` with the production headers on :8790 and proxies the API). Tests: `npm test` (needs Node 22.13+ and `npm ci` in `service/`).

**Images:** re-encoded to WebP by sharp where the CPU supports its prebuilt binaries (x86-64-v2 or arm64); otherwise by the distro's libvips CLI (`libvips-tools`, installed by the installer when needed; chiefmonkey.art's CPU needs this); otherwise served unresized with metadata stripped. `HIBIKI_IMG_BACKEND=auto|sharp|vips|copy` overrides.

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

**v0.2.2:** right panel is one column (post, photos or link TL;DR, then every reply; order in `orderReplies`, `service/src/feed.mjs`); TL;DR is `service/src/tldr.mjs` (extractive, local; link cache key `link2|`); likes and reposts patch the card in place; the owner's own reactions come back as `me` and do not boost ranking; the shell's like confirm can be switched off (`hibiki.skip7` in shell storage, toggle on Your signal). The signer extension's own prompt is separate: use its "remember" / "always allow" option for kind 7.

**v0.2.3:** Watch cards show a poster from imeta `image` (now read for kind 1 too) or else a preview frame: the browser loads only the video's metadata through the node (`#t=0.5`, `preload=metadata`, lazy, at most three at once). Clicking opens `watchModal`: the video fills a viewport-sized stage, with the panel (author, post, Reply/Repost/Like/zap total, replies, composer) beside it on desktop and below it on phones. Zapping itself is still a todo.

**Agent deploys (ADR-0002, v0.2.4):** once the owner has run `sudo ./ops/install-deploy-access.sh` on chiefmonkey.art, the agent installs a release only after the owner asks for that version in the session:

```bash
gh workflow run deploy.yml -R ChiefmonkeyArt/torii-hibiki -f action=deploy -f tag=vX.Y.Z && sleep 5 && gh run watch -R ChiefmonkeyArt/torii-hibiki $(gh run list -R ChiefmonkeyArt/torii-hibiki -w deploy.yml -L 1 --json databaseId -q '.[0].databaseId')
```

`-f action=status` prints the installed release and health with no sudo. Secrets: `HIBIKI_DEPLOY_SSH_KEY` (private half exists only there), `HIBIKI_DEPLOY_HOST`, `HIBIKI_DEPLOY_KNOWN_HOSTS` (pinned; fingerprints in the ADR). VPS side: forced-command key in `ubuntu`'s `authorized_keys` → `/usr/local/sbin/hibiki-deploy-hook` → `sudo -n /usr/local/sbin/hibiki-deploy <tag>` (root-owned clone `/opt/torii/src/torii-hibiki`; refuses unless the tag is annotated, at origin/main HEAD, and matches `VERSION`). Journal tags: `hibiki-deploy-hook`, `hibiki-deploy`. Revoke: `sudo sed -i '/hibiki-deploy-hook/d' ~/.ssh/authorized_keys && sudo rm -f /etc/sudoers.d/hibiki-deploy`. Quest's keys never touch Hibiki.

**v0.2.5:** zaps (NIP-57), profiles, inline replies. `service/src/zap.mjs` resolves the recipient's lud16/lud06 on the node (same SSRF-guarded fetch as images), accepts only NIP-57 wallets (`allowsNostr`, `nostrPubkey`), caps at 1,000,000 sats, checks the owner-signed 9734 (signature, recipient, amount, public `wss` relays, lnurl), then fetches the invoice and refuses it unless its amount matches exactly (v0.2.6: a description-hash mismatch is allowed and flagged `bound:false`, because Primal ignores it). `service/src/qr.mjs` draws the invoice QR (byte/alphanumeric, ECC M/L, v1–25, checked with zxing). The shell confirms every zap (never skippable), signs 9734, pays with WebLN if present, else returns the invoice for QR / Open wallet / Copy; the napplet polls `zap/receipt` (wallet-signed 9735 whose description id matches). The node never holds funds or keys. Publishing returns on the first relay OK or after 3 s (`firstAccepted` in `ingest.mjs`; the rest finish in the background), and the napplet shows your reply at once. Names open a profile page (`author/<hex>`, `?live=1` fetches their recent posts). Reply under a comment opens a form under that comment; the bottom box replies to the post. Identical replies from one author collapse to one with "posted N times". Watch cards have small reply/like/zap icons. New shell messages: `feed.author`, `feed.zap`, `feed.zapcheck`, `feed.lightning`, `feed.copy` (invoice or npub only).

**v0.2.6:** first real zap (Daniel Prince, princey@primal.net) failed with "upstream 500". Wallet server replies are now read even on errors, so the owner sees the host and its LNURL `reason`; a 5xx, timeout or dropped connection is retried once; zap failures are logged. Primal's invoices never carry the NIP-57 description hash (checked on four live invoices), so v0.2.5 would have refused every Primal address. v0.2.6 allows them with the amount still enforced, and the pay sheet notes the wallet may not confirm and offers Close. The VPS log is not reachable over deploy access, so the exact 500 cause is unconfirmed; the next failure is logged with the wallet's own reason.

**Next:** owner tests a real zap (WebLN and QR), then phone acceptance and the rest of P1 polish (live streams, quarantine, node-side search; see `hibiki-todo.md`).
