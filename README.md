# Hibiki (響)

**What resonates with you.** Hibiki is a personal Nostr discovery feed. It's a standalone Torii napplet that finds people and posts beyond your circle, tuned to your own taste and humour. Torii nodes cooperate to score spam, and their scores are signed and advisory.

Status: **v0.2.3, first working feed.** Your circle's original posts, news, video, audio and long reads, gathered by your own node and ranked in your browser. Replies from everyone line up under each post (people you know first, then the most popular), videos show preview frames and play in a big player with the post, actions and replies beside them, and news links get a free TL;DR picked from the article by your node (no AI, no sats). Images and links come through your node, so outside hosts never see you reading.

## Documents

- [ADR-0001: personalised discovery as a standalone napplet](docs/adr/0001-personalised-discovery.md) — Accepted (revision 4)
- [Node-to-node trust and spam-scoring event model](docs/event-model.md) — Accepted. Reuses NIP-85, NIP-51, NIP-56 and NIP-78, and adds no new kinds
- [ADR-0002: owner-approved deploys run by the agent](docs/adr/0002-agent-deploys-from-tags.md) — Proposed
- [Implementation roadmap](docs/roadmap.md) — P0 preview → P6 mount anywhere
- Continuity: [strategy](hibiki-strategy.md), [todo](hibiki-todo.md), [progress](hibiki-progress.md), [handoff](hibiki-handoff.md)

## Principles

- **Standalone:** Hibiki is not part of Continuum, Quest or Base, but any of them can mount it later through `nap-torii-feed@1`.
- **Privacy split:** public compute runs on the node. Private taste stays in the browser and is stored only as sealed ciphertext.
- **Signed advice, not control:** peers' scores are signed and advisory. No single peer can hide anything from you.
- **FIPS first between nodes:** relays and HTTPS stay the universal fallback.
- **Self-contained:** no external fonts, CDNs or trackers.

## How it works

- **Web app** (`web/`): a small trusted shell (`index.html`, `shell.js`) signs you in with your NIP-07 signer and asks you to confirm anything before it is signed (you can turn this off for likes only). The feed itself (`napplet.html`, `napplet.js`, `rank.js`) runs in a sandboxed iframe with no network access; it only talks to the shell.
- **Feed service** (`service/`, `hibiki-feed`): a single Node process on loopback. It reads who you follow and where they post (NIP-65), starting with your node's shared relay, keeps 14 days of their public posts and reactions in SQLite, computes public features (circle, friend-of-friend, reactions, zaps, spam), and proxies images, video and link previews. It relays only events you signed. It holds no keys.
- **Ranking** happens in your browser with your own weights, which never leave it.

## Install on a Torii Base node (owner-run)

Needs Node 22.13+ with npm. On CPUs without x86-64-v2 support (some older or emulated VPS CPUs) the installer also installs `libvips-tools` for image resizing.

```bash
cd ~/torii-hibiki 2>/dev/null || { git clone https://github.com/ChiefmonkeyArt/torii-hibiki.git ~/torii-hibiki && cd ~/torii-hibiki; }; git fetch --tags && git checkout v0.2.3 && sudo ./install.sh && curl -s https://chiefmonkey.art/hibiki/api/health
```

The installer finds your npub from the Torii Suite or Continuum settings (or pass it: `sudo ./install.sh npub1...`). It installs the release to `/apps/hibiki/`, creates the `hibiki` user, `/etc/hibiki/hibiki.env` and `/var/lib/hibiki`, installs the sandboxed `hibiki-feed` service, writes `/opt/torii/nginx-fragments/hibiki.conf`, validates nginx, health-checks the service (rolling everything back on failure) and registers the **Hibiki** launcher card.

To remove it: `sudo systemctl disable --now hibiki-feed && sudo rm -f /etc/systemd/system/hibiki-feed.service && sudo torii unregister hibiki && sudo rm -f /opt/torii/nginx-fragments/hibiki.conf && sudo torii reload && sudo rm -rf /apps/hibiki /etc/hibiki /var/lib/hibiki`.

## Develop

```bash
cd service && npm ci && cd ..
HIBIKI_DEV=1 HIBIKI_OWNER=npub1... HIBIKI_SECRET=$(openssl rand -hex 32) HIBIKI_DATA=/tmp/hibiki HIBIKI_ORIGIN=http://127.0.0.1:8790 HIBIKI_PRIMARY_RELAY=wss://relay.example node service/src/server.mjs &
node tools/dev-server.mjs   # http://127.0.0.1:8790/hibiki/
```

`HIBIKI_DEV=1` skips sign-in for loopback requests only. Never set it on a server.

## Test

```bash
npm test   # repo checks + service tests (Node 22.13+, after npm ci in service/)
```

## Licence

GPL-3.0-or-later, matching Torii Continuum, Torii Quest, Torii Suite and Plebeian Market. See [LICENSE](LICENSE).
