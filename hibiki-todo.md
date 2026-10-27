# Hibiki — Master TODO

> Source of truth for Hibiki tasks. Continuum, Quest and Base tasks live in their own repos.

### Active tasks

- **HIBIKI-P1-INSTALL (v0.2.3 done, ongoing checks):** the owner runs the install command on the VPS, signs in at `/hibiki/` with their NIP-07 signer and checks: the feed fills from the circle, images load with no third-party requests, a reply/reaction asks for confirmation then appears on the shared relay, and `systemctl status hibiki-feed` shows it under its memory cap.
- **HIBIKI-ZAP-ACCEPT (v0.2.5):** the owner zaps a real post with a small amount, once with a WebLN wallet (Alby) and once by scanning the QR, and checks the bolt total updates. Some wallet servers hash the zap request differently; v0.2.5 refuses those invoices rather than pay an unchecked one, so note any wallet that fails.
- **HIBIKI-P1-ACCEPT:** phone acceptance (warm load under 2 s, panel sheet, tap-to-play) and a week of real use to tune the default weights and spam features.
- **HIBIKI-P4-RELAY-ADR (later):** a Torii Suite ADR for the additive relay write rule (accept 30382/30383 from bound service keys) before P4.

### Next (P1 polish, v0.2.x)

- Live streams (kind 30311) in Watch with a "live" badge.
- Search box: search loaded posts; later node-side search.
- Quarantine bucket for low spam-score posts (visible on request).

### Backlog

- P2 private taste (sealed signals, NIP-46, Applesauce signers in the shell) · P3 optional embeddings · P4 publish assertions · P5 peer cooperation + FIPS · P6 mounts/interop (see `docs/roadmap.md`).
- Align the owner→node binding with the node-relay binding if it is finalised first.

### Done

- HIBIKI-P0 (v0.1.0) preview card. HIBIKI-ADR-ACCEPT: ADR-0001 revision 4 and the event model accepted 2026-10-27. HIBIKI-P1 build (v0.2.0). v0.2.1: image fallback for CPUs without x86-64-v2 (the v0.2.0 install on chiefmonkey.art rolled back cleanly because sharp could not load); installed on chiefmonkey.art. v0.2.2: every reply in the right panel in priority order, replies from anyone in the peek, free extractive TL;DR for news links, in-place likes (no page jump), optional no-confirm likes. v0.2.2 installed on chiefmonkey.art. v0.2.3: Watch preview frames (imeta poster or a frame loaded through the node) and a viewport-sized player with the post, actions and replies beside it. v0.2.3 installed on chiefmonkey.art. v0.2.4: ADR-0002 accepted; owner-approved agent deploys (forced-command key, root-owned tag-checking deploy script, manual workflow). HIBIKI-DEPLOY-SETUP: owner ran the v0.2.4 setup 2026-10-27 and the agent status run passed. v0.2.5: zaps through the shell with node-checked invoices and QR/WebLN payment, profile pages, inline replies, fast publish, duplicate-reply collapse.
