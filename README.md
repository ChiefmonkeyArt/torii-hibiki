# Hibiki (響)

**What resonates with you.** Hibiki is a personal Nostr discovery feed. It's a standalone Torii napplet that finds people and posts beyond your circle, tuned to your own taste and humour. Torii nodes cooperate to score spam, and their scores are signed and advisory.

Status: **v0.1.0 preview.** It ships the design documents and a static preview page with its homepage card. There's no feed yet.

## Documents

- [ADR-0001: personalised discovery as a standalone napplet](docs/adr/0001-personalised-discovery.md) — Proposed
- [Node-to-node trust and spam-scoring event model](docs/event-model.md) — Proposed. Reuses NIP-85, NIP-51, NIP-56 and NIP-78, and adds no new kinds
- [Implementation roadmap](docs/roadmap.md) — P0 preview → P6 mount anywhere
- Continuity: [strategy](hibiki-strategy.md), [todo](hibiki-todo.md), [progress](hibiki-progress.md), [handoff](hibiki-handoff.md)

## Principles

- **Standalone:** Hibiki is not part of Continuum, Quest or Base, but any of them can mount it later through `nap-torii-feed@1`.
- **Privacy split:** public compute runs on the node. Private taste stays in the browser and is stored only as sealed ciphertext.
- **Signed advice, not control:** peers' scores are signed and advisory. No single peer can hide anything from you.
- **FIPS is optional:** relays are the baseline transport.
- **Self-contained:** no external fonts, CDNs or trackers.

## Install the preview on a Torii Base node (owner-run)

```bash
git clone https://github.com/ChiefmonkeyArt/torii-hibiki.git && cd torii-hibiki && git checkout v0.1.0 && sudo ./install.sh
```

This installs the static page to `/apps/hibiki/`, writes `/opt/torii/nginx-fragments/hibiki.conf`, validates nginx (rolling back on failure) and registers the **Hibiki** card on the launcher. It changes nothing else.

To remove it: `sudo torii unregister hibiki && sudo rm -f /opt/torii/nginx-fragments/hibiki.conf && sudo torii reload && sudo rm -rf /apps/hibiki`.

## Test

```bash
npm test
```
