# Hibiki — Handoff

**Repo:** `ChiefmonkeyArt/torii-hibiki` (public). **Route:** `/hibiki/`. **Registry name:** `hibiki`. **Version marker:** `VERSION`, `package.json` and the footer of `web/index.html` (checked by `npm test`).

**Release rule:** land through a merged PR, tag `v<VERSION>` on the merge commit, and the owner installs from the tag:

```bash
cd ~/torii-hibiki 2>/dev/null || { git clone https://github.com/ChiefmonkeyArt/torii-hibiki.git ~/torii-hibiki && cd ~/torii-hibiki; }; git fetch --tags && git checkout v0.1.0 && sudo ./install.sh
```

**VPS layout:** `/apps/hibiki/{current,releases/<ts>}` with five releases kept, plus `/opt/torii/nginx-fragments/hibiki.conf`. No service yet, no data directory, no secrets.

**Live check:** `curl -s https://chiefmonkey.art/torii/apps.json` lists `hibiki` at 0.1.0, and `curl -s https://chiefmonkey.art/hibiki/VERSION` returns `0.1.0`.

**Settled plumbing (ADR-0001 rev 3, PR #4):**
- **Applesauce v7 (MIT)** is the Nostr client layer in the shell and the feed service. It covers the relay pool, NIP-42, outbox routing, social-graph/timeline/reactions/zaps loaders, NIP-85 and 10040 helpers, the `applesauce-sqlite` store on the node, and content parsing. Signers stay shell-only.
  - Pin exact versions, matching Quest's ADR-0140 pins where they overlap.
  - Use one thin adapter file each in the shell and the service, so a major upstream release costs one file.
  - The napplet never bundles it.
  - Budget, enforced in tests: shell ≤ 60 KB gzip, napplet ≤ 150 KB gzip.
  - Hibiki's own checks (bindings, quorum, no laundering, consent) run on every event, whatever library fetched it.
- **FIPS** is the default node↔node route wherever both ends support it, with automatic `wss://` fallback. It sits under the Applesauce relay connection and adds reachability, not trust.
  - Browsers, public relays and image hosts stay on `wss://` or HTTPS.
  - Owner devices move to FIPS once the mobile path (fips2go/Capacitor) is ready.
  - P5 measures FIPS against `wss://` per peer.

**Next:** UX mockups review, then P1 (see `hibiki-todo.md`).
