# Hibiki — Master TODO

> Source of truth for Hibiki tasks. Continuum, Quest and Base tasks live in their own repos.

### Active tasks

- **HIBIKI-P0 (v0.1.0):** preview page, launcher card, ADR-0001, event model and roadmap. Remaining: the owner runs the install command on the VPS, then verifies the card and `/hibiki/` live.
- **HIBIKI-ADR-ACCEPT:** revision 2 incorporates the 2026-10-26 review. The owner marks ADR-0001 and the event model Accepted or requests changes. Nothing past P0 starts before then.
- **HIBIKI-P4-RELAY-ADR (later):** a Torii Suite ADR for the additive relay write rule (accept 30382/30383 from bound service keys) before P4.

### Next (P1, v0.2.x) — Circle feed

- Host shell + sandboxed napplet (`srcdoc`, `allow-scripts`, network-denying CSP); NIP-07 sign-in.
- Applesauce v7 (pinned, thin adapter, size budget test) in the shell and the service.
- Loopback feed service (systemd, memory cap, `applesauce-sqlite` store): own relay + NIP-65 outbox reads, follows + 2-hop WoT, ingest spam features, quarantine bucket.
- "Why am I seeing this" chips; same-origin image proxy (auto-load thumbnails, SSRF-safe, bounded cache; video tap-to-play); `textContent`-only rendering.

### Backlog

- P2 private taste · P3 optional embeddings · P4 publish assertions · P5 peer cooperation + FIPS · P6 mounts/interop (see `docs/roadmap.md`).
- Align the owner→node binding with the node-relay binding if it is finalised first.
