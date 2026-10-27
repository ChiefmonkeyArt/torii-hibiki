# Hibiki — Master TODO

> Source of truth for Hibiki tasks. Continuum, Quest and Base tasks live in their own repos.

### Active tasks

- **HIBIKI-P1-INSTALL (v0.2.2):** the owner runs the install command on the VPS, signs in at `/hibiki/` with their NIP-07 signer and checks: the feed fills from the circle, images load with no third-party requests, a reply/reaction asks for confirmation then appears on the shared relay, and `systemctl status hibiki-feed` shows it under its memory cap.
- **HIBIKI-P1-ACCEPT:** phone acceptance (warm load under 2 s, panel sheet, tap-to-play) and a week of real use to tune the default weights and spam features.
- **HIBIKI-P4-RELAY-ADR (later):** a Torii Suite ADR for the additive relay write rule (accept 30382/30383 from bound service keys) before P4.

### Next (P1 polish, v0.2.x)

- Video posters: take the `image` field from `imeta` where present; otherwise the blurred author picture stays.
- Live streams (kind 30311) in Watch with a "live" badge.
- Zaps: show NIP-57 zap totals (counted already) and add zapping through the shell (needs an LNURL flow and owner confirmation).
- Search box: search loaded posts; later node-side search.
- Quarantine bucket for low spam-score posts (visible on request).

### Backlog

- P2 private taste (sealed signals, NIP-46, Applesauce signers in the shell) · P3 optional embeddings · P4 publish assertions · P5 peer cooperation + FIPS · P6 mounts/interop (see `docs/roadmap.md`).
- Align the owner→node binding with the node-relay binding if it is finalised first.

### Done

- HIBIKI-P0 (v0.1.0) preview card. HIBIKI-ADR-ACCEPT: ADR-0001 revision 4 and the event model accepted 2026-10-27. HIBIKI-P1 build (v0.2.0). v0.2.1: image fallback for CPUs without x86-64-v2 (the v0.2.0 install on chiefmonkey.art rolled back cleanly because sharp could not load); installed on chiefmonkey.art. v0.2.2: every reply in the right panel in priority order, replies from anyone in the peek, free extractive TL;DR for news links, in-place likes (no page jump), optional no-confirm likes.
