# Hibiki — Master TODO

> Source of truth for Hibiki tasks. Continuum, Quest and Base tasks live in their own repos.

### Active tasks

- **HIBIKI-P0 (v0.1.0):** preview page, launcher card, ADR-0001, event model and roadmap. Remaining: the owner runs the install command on the VPS, then verifies the card and `/hibiki/` live.
- **HIBIKI-ADR-REVIEW:** the owner reviews ADR-0001 and the event model, then marks them Accepted or requests changes. Nothing past P0 starts before then.

### Next (P1, v0.2.x) — Circle feed

- Host shell + sandboxed napplet (`srcdoc`, `allow-scripts`, network-denying CSP); NIP-07 sign-in.
- Loopback feed service (systemd, memory cap): own relay + NIP-65 outbox reads, follows + 2-hop WoT, ingest spam features, quarantine bucket.
- "Why am I seeing this" chips; click-to-load media; `textContent`-only rendering.

### Backlog

- P2 private taste · P3 optional embeddings · P4 publish assertions · P5 peer cooperation + FIPS · P6 mounts/interop (see `docs/roadmap.md`).
- Choose the repository licence.
- Align the owner→node binding with the node-relay binding if it is finalised first.
