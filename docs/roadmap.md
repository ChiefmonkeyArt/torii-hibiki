# Implementation roadmap

Each phase ships as its own tagged release through a merged PR. VPS updates are owner-run (`sudo ./install.sh` from the tag). Each phase needs its own acceptance evidence. A phase isn't done because the code exists.

| Phase | Version | Delivers | Acceptance |
|---|---|---|---|
| P0 Preview card | v0.1.0 | Static preview page at `/hibiki/`, Base homepage card, ADR, event model, roadmap | Card visible on the launcher. Page loads with zero third-party requests. Strict CSP. Tests pass. |
| P1 Circle feed | v0.2.x | **v0.2.0 built; v0.2.1 adds an image fallback for older CPUs.** Trusted shell + opaque-origin sandboxed napplet (`connect-src 'none'`). NIP-07 + NIP-98 sign-in (owner only, HttpOnly session). Feed service `hibiki-feed` on loopback (systemd-sandboxed, memory cap, Applesauce v7 relay pool + `applesauce-sqlite` on `node:sqlite`). Reads the shared node relay first, then follows' NIP-65 outbox relays. Follows + 2-hop. Originals only, circle reply peek. Sections Today, Circle, News, Watch, Listen, Read, Your signal. Glint "why" popovers, signal presets and sliders (weights stay in the browser). Right panel for media, replies and links. Signed same-origin image proxy (WebP, EXIF stripped, SSRF-safe, bounded cache), tap-to-play media proxy, link previews. Confirm-and-sign replies, reactions and reposts. | Feed loads <2 s from warm cache on a phone. No signer prompt without a user action. Napplet has no network access (CSP + tests). Untrusted text rendered via DOM nodes only (tests). Zero browser requests to third-party hosts (CSP `'self'` only, tests). Size budget enforced in tests (shell ≤ 8 KB gzip, napplet ≤ 32 KB gzip). Proxy rejects private-address, unsigned and tampered URLs (tests). **Open:** owner install on the VPS and phone acceptance. |
| P2 Private taste | v0.3.x | Client-sealed signals. Taste neighbours from public reactions. Lexical/hashtag relevance. Sliders. More/less like this. 10–15% exploration. Sealed multi-device sync. | Owner labels 50 items. Top-20 hit rate beats a chronological feed. At least 20% of liked items come from outside follows. The node never stores plaintext preferences (test). |
| P3 Embeddings (optional) | v0.4.x | Local small embedding model for public notes, gated on host RAM via a Suite capacity check. Bounded per-hour budget. | Measured hit-rate gain over P2 on the same labels, or the model stays off. CPU/RAM within the budget. |
| P4 Publish assertions | v0.5.x | Feed service keys. Owner-signed NIP-78 binding + kind 0. 30382/30383 published to the own relay. Change-only republish. | A third-party NIP-85 client reads our scores. Revocation tested. No owner key on the server. |
| P5 Peer cooperation | v0.6.x | Encrypted 10040 peer list. Peer suggestions. Weighted, capped, decaying combination. Two-operator hide quorum. Collusion check. FIPS-first peer sync. | Real two-node test with an **independent operator**, over FIPS by default with automatic `wss://` fallback; latency, success rate and bandwidth recorded for both paths. A peer's false positives decay. A single peer cannot hide content. FIPS path and relay fallback both pass. |
| P6 Mounts and interop | v0.7.x | `nap-torii-feed@1` mounted in Continuum, a Quest NAP-zone board and Torii DE. Optional output adapter for other clients. | The same bundle hash runs in two hosts. Contract docs ready to propose to the NAP registry. |

## Cross-cutting rules

- **Self-contained:** no external fonts or CDNs. System fonts or bundled FOSS fonts only.
- **Small footprint:** the napplet bundle stays under 150 KB gzipped through P2 (v0.2.0: about 21 KB). The feed service is a single Node process with an explicit memory cap.
- **Consent for every write:** like, repost, zap, report and publish each need a user action and signer approval.
- **The owner approves their own VPS updates:** new versions are announced and never force-deployed.
- **Metrics stay on the node:** hit rate, discovery rate (liked items from outside follows), spam leak rate, false-hide rate, p95 load time and bytes per session. Never shared.

## Optional Continuum hook (after P2)

Continuum's owner agent may call `feed.tune` through the shell, so chat requests like "more dry humour, less price talk" adjust the sliders. This is optional and lives behind the contract. The feed never depends on Continuum.
