# ADR-0001: Hibiki — personalised Nostr discovery as a standalone Torii napplet

Date: 2026-10-26. Status: **Accepted**, revision 4 (accepted by the owner 2026-10-27, first built in v0.2.0). Revision 2 followed review, revision 3 added Applesauce and made FIPS the preferred node path, and revision 4 records the content-first UX and the as-built P1 boundaries (section 9). Licence: GPL-3.0-or-later, matching Continuum, Plebeian Market, Quest and Suite.

## Context

Nostr feeds offer four ways to find things: people you follow, lists someone else curated, what is popular and what is trending. None of them helps you find content outside your circle that fits your own humour, interests and taste. Follow lists describe who you know. Reactions describe what you enjoy, and that second signal is the one that reaches past your circle.

Spam is the second problem. A feed that looks outside your follows has to judge unknown keys, and no single node sees enough of the network to do that well alone.

The ecosystem already has building blocks. NIP-85 Trusted Assertions (kinds 30382–30385, plus 10040 for choosing providers) standardise signed scores about users, events and identifiers. NIP-85 standardises the outputs and leaves each provider free to choose its algorithm ([NIP-85](https://github.com/nostr-protocol/nips/blob/master/85.md)). NIP-56 reports, NIP-51 lists and NIP-13 proof-of-work are established inputs. Torii already has node-owned relays, owner/node key separation, FIPS peer reachability and a sandboxed napplet runtime.

## Decision

### 1. A standalone napplet, not a Continuum feature

The feed is its own project and repository. It is an add-on to a Torii node, not part of Continuum, Quest or Base.

- **First host:** a standalone page at `/hibiki/`, registered with Torii Base so it gets a homepage card. Until the feed exists, that card points to a static preview.
- **Napplet split:** following the Torii napplet architecture (Quest trusted shell), the feed UI is a sandboxed `srcdoc` iframe (`sandbox="allow-scripts"`, network-denying CSP). A trusted host shell owns the signer, relay connections and any publishing. The napplet only receives snapshots and sends proposals.
- **Later hosts:** Continuum, Quest (for example a NAP-zone noticeboard) or Torii DE can mount the same bundle through the same contract. None of them is required.
- **Proposed contract:** `nap-torii-feed@1` with namespace `feed.*`: `feed.query`, `feed.explain`, `feed.signal`, `feed.tune` and `feed.propose`. Any like, repost, zap or report the napplet requests becomes a cleartext proposal that the shell asks the user to approve and then signs.

### 2. Public compute on the node, private compute in the client

This is the main privacy boundary, and it shouldn't change without a new ADR.

| Work | Where | Why |
|---|---|---|
| Ingest, spam scoring, web-of-trust distance, taste-neighbour discovery from public reactions, candidate pools, optional public-note embeddings | Node feed service | Uses only public data. Heavy work needs an always-on host. |
| Private signals (dwell time, skips, "less like this"), taste vector, final ranking, slider settings | Browser, inside the trusted shell | This is preference data. Plaintext exists only in the owner's open session. |
| Persistence of private state | Node, as client-sealed ciphertext (NIP-44 to self) | Allows multiple devices without the node reading the data. Never published to relays. |

The node sees which candidates it served. It does not see which ones the owner liked privately, lingered on or rejected.

- **Bounded client work:** the browser ranks a pool of at most 500 candidates with compact features (ids, scores, a few topic terms, optional quantised vectors). Each refresh stays well under 200 KB, and ranking stays fast on a phone.
- **Signer requirement:** sealing needs NIP-44 support in the owner's signer. If the signer lacks it, private signals stay in memory for that session only and are never sent to the node unsealed.

### 3. Candidate sources

Every candidate passes the spam gate first. The pool then mixes:

1. **Circle:** follows, plus 2–3 hop web-of-trust distance, minus mutes.
2. **Taste neighbours:** keys whose public reactions and zaps overlap the owner's public ones. Only keys that pass the web-of-trust gate count, so fake-account rings cannot invent neighbours.
3. **Similar content:** notes whose features (hashtags and terms in v1, optional embeddings later) match what the owner engaged with.
4. **Weighted curators:** NIP-51 lists and peer-node picks, weighted by each curator's past hit rate for this owner.
5. **Exploration:** 10–15% of slots go to high-quality items from outside all of the above. This is always on, so the feed cannot collapse into a bubble.

### 4. Explainable, steerable ranking

Score = relevance + social proximity + peer quality − spam + freshness decay. Weights are owner-adjustable sliders: close ↔ far, familiar ↔ new, serious ↔ playful. Every item carries "why you're seeing this" chips, and every hidden item can be shown with its reason. Humour and tone are learned from behaviour (for example 😂 reactions and "more like this"), not from a fixed classifier.

### 5. Node-to-node cooperation through signed assertions

Each node publishes its own public judgements as NIP-85 assertions, signed by a dedicated feed service key, never the owner's key. Nodes choose which peers to read. Peer opinion is advisory and decays. See `docs/event-model.md`.

- **Never transmitted:** taste profiles, private signals and peer-weight tables. They stay on the node.
- **A single peer can only lower an item's rank, never hide it.** Hiding needs local evidence (the owner's mutes or reports, or strong ingest evidence) or a quorum of at least two eligible peers run by different operators.
- **No score laundering:** a node's published scores come only from its own evidence. Scores received from peers are never republished or mixed in, so opinions can't echo through the network.
- **Negative claims are restrained:** a public spam score is a signed claim about a person. Nodes publish one only with strong local evidence, and owners can turn negative publication off.
- **No peer dominates:** one peer's contribution is capped, and its weight drifts back toward zero unless the owner's own actions keep confirming it.

This follows Torii Cooperation's three tests: opt in and out at will, signed and verifiable, and locally interpreted.

### 6. FIPS is the preferred node-to-node path

FIPS is Torii's founding-layer transport (Quest ADR-0111). Hibiki uses it **by default wherever both ends support it**, and falls back automatically to `wss://`/HTTPS everywhere else.

| Link | Path | Why |
|---|---|---|
| Node ↔ peer node: assertion sync, peer relay reads, candidate fetches | **FIPS first**, `wss://` fallback | Works behind NAT, with dynamic IPs and with no domain, so home nodes can be full peers |
| Owner's devices ↔ own node | HTTPS today; FIPS from mobile clients when the mobile path (fips2go/Capacitor) is ready | Browsers can't run FIPS yet (staged per the founding stack) |
| Node ↔ ordinary public Nostr relays and image hosts | `wss://`/HTTPS only | They aren't on FIPS |

- **Layering:** FIPS sits under the relay connection. The Applesauce relay pool (section 8) connects to a peer's relay through the local FIPS daemon exactly as it would over `wss://`. Signed events are verified the same way on both paths, so FIPS adds reachability, not trust.
- **Keys:** keys never pass through FIPS, and browsers never run a FIPS daemon.
- **Without FIPS:** the feature must still work with no FIPS at all.
- **Measured:** P5 records FIPS vs `wss://` latency, success rate and bandwidth per peer.

### 7. Shared-relay boundary

In P0–P3, spam filtering happens in the feed service's ingest path, and the shared node relay's write policy is unchanged. That relay also serves Plebeian Market and Quest presence. P4 needs one additive rule: accept kinds 30382/30383 from this node's bound service keys. That rule ships under a separate Torii Suite ADR. Hibiki never adds rejection rules to the shared relay.

### 8. Applesauce is the Nostr client layer

Hibiki uses [Applesauce](https://github.com/hzrd149/applesauce) v7 (MIT, GPL-compatible) for relay and event plumbing in both the trusted shell (browser) and the feed service (Node), instead of hand-rolled WebSocket code. Quest's gateway already adopted it under ADR-0140, with measured speed gains and an enforced size budget.

| Need | Applesauce package |
|---|---|
| Pooled relay connections, NIP-42 auth, streaming with "relay failed" vs "nothing found" | `applesauce-relay` |
| Shared event store, NIP-65 outbox routing | `applesauce-core` |
| Follow graph to N hops, timelines, reactions and zaps for taste neighbours | `applesauce-loaders` (`social-graph`, `timeline`, `reactions`, `zaps`) |
| NIP-85 trusted assertions and 10040 provider lists | `applesauce-common` (trusted-assertion helpers and casts, trusted-provider list factory), `applesauce-actions` |
| Mutes, bookmarks and other lists | `applesauce-common` models |
| Persistent event store on the node | `applesauce-sqlite` with Node's built-in `node:sqlite` backend (`applesauce-sqlite/native`, no native compile) |
| Parsing note content: links, media, mentions, for the image-proxy rewrite | done on the node in v0.2 (small NIP-10/NIP-92 helpers); `applesauce-content` when richer parsing is needed |
| NIP-07 / NIP-46 signing and NIP-44 sealing | NIP-07 directly in v0.2; `applesauce-signers`/`applesauce-accounts` when NIP-46 and sealing arrive (P2). Shell only, never the service |

- **Trust stays ours:** Applesauce only fetches, stores and parses. Hibiki's own checks still run on every event: mutual service bindings, quorum rules, the no-laundering rule and consent gates.
- **The napplet doesn't bundle Applesauce:** it has no network access, so it receives snapshots from the shell. That keeps it small.
- **Pinned and wrapped:** exact versions, matching Quest's pins where they overlap, behind one thin adapter file each in the shell and the service, so a major upstream release costs one file.
- **Size budget, enforced in tests:** shell Applesauce chunks ≤ 60 KB gzip (Quest measured 52 KB). Napplet bundle ≤ 150 KB gzip, with Applesauce excluded.

### 9. Revision 4: content first, and the P1 boundaries as built

**Product focus.** Hibiki is first a place to find interesting and entertaining things from your circle and its news: notes, pictures, video, audio, long reads and live streams. The algorithm is not the headline. Its controls stay subtle (a small "signal" pill, a glint on each card that explains why it is there, an orb for your settings) but are always one tap away and pleasant to use.

- **Originals first.** Social sections show root posts only (NIP-10: no reply markers, positional e-tags count as replies, mentions and quotes do not). A card may show a peek of one or two replies from people in your circle.
- **Sections:** Today (hero plus picks), Circle, News (link-led posts and curators, "Mekiki" 目利き), Watch, Listen, Read (kind 30023) and Your signal.
- **Right panel** on desktop, full-screen sheet on phones: Media, Replies (with an inline composer) and Link, chosen per post.
- **Link previews** are fetched by the node under the same SSRF guard as images, parsed as text only, and shown as cards.

**Boundaries as built (these refine sections 1, 2 and 8).**

- **Applesauce lives on the node only in v0.2.** The node's feed service uses `applesauce-relay`, `applesauce-core` and `applesauce-sqlite`. The browser never connects to relays, so relays do not see the reader's IP either. The shell is plain code (under 5 KB gzip) that does NIP-07 sign-in and signs what the owner approves. The shell budget in section 8 therefore applies from P2, when sealing and NIP-46 bring Applesauce signers into the browser.
- **Napplet loading:** a same-origin file (`napplet.html`) in an iframe with `sandbox="allow-scripts"`, and the response header CSP carries `sandbox allow-scripts` and `connect-src 'none'`. The napplet runs with an opaque origin, cannot fetch, cannot read cookies or storage, and talks to the shell only through `postMessage`. Section 1's `srcdoc` wording is superseded.
- **Media authorisation:** the node rewrites every image, video and audio URL into a path signed with an HMAC key that never leaves the node (`/hibiki/img/<sig>/<width>/<url>`, `/hibiki/media/<sig>/<url>`). Only the signed-in owner receives these paths, and the napplet's renderer drops any `src` that is not one. Requests from the opaque-origin napplet cannot carry the session cookie, so the signature is the authorisation. This refines "serves only to the signed-in owner session".
- **Video and audio** are proxied too, tap-to-play, streamed with Range requests and a MIME allowlist, never cached on disk. This replaces the earlier "fetch directly when tapped" exception, so no third-party host ever sees the reader.
- **Ranking split:** the node computes public features per post (in circle, friend-of-friend, circle and wider reactions, zaps, age, spam score, media) and returns them with a default order. The browser re-ranks with the owner's weights, which are stored only in the browser. The same `rank.js` runs in both places. Private signals beyond the sliders are P2.
- **Writes:** replies, reactions and reposts are proposals from the napplet. The shell shows exactly what will be signed, asks the signer, then posts the signed event to the node, which checks it is owner-signed and an allowed kind (1, 6, 7, 10000, 30004, 30078) before relaying it to the shared node relay and the owner's write relays. The node holds no keys.
- **Shared relay first:** the node reads from and writes to the Suite relay on loopback (`ws://127.0.0.1:7777`, the same relay Continuum, the Torii Suite and Plebeian use), then the follows' NIP-65 outbox relays chosen greedily under a cap (24), and public index relays only to discover relay lists.
- **Footprint:** one Node 22.13+ process on loopback, systemd-sandboxed as its own user, memory-capped, 14-day retention, bounded image cache (512 MB default).

## Consequences

- No Continuum, Quest or Base code changes are needed to start. Base registration is reused as is.
- The node needs a small always-on service (`hibiki-feed`, from v0.2.0). Embeddings are optional and gated on host capacity. v1 runs without an ML model.
- A new long-lived key (the feed service key) is introduced. It is bound to the owner by a signed declaration and can be revoked.
- **Media goes through the node, loads automatically.** Avatars, banners and images in notes point at arbitrary third-party hosts. A direct browser fetch reveals the reader's IP and viewing time to whoever runs that host, so a hostile avatar URL works like a tracking pixel. Instead, the feed service runs a same-origin image proxy, part of P1, not an optional extra. Images load automatically and outside hosts only ever see the VPS address. The proxy:
  - Accepts only `https`. Refuses private, loopback and link-local addresses, re-checking after DNS and on redirects, to prevent SSRF.
  - Accepts only raster images (JPEG, PNG, WebP, GIF, AVIF; no SVG), with an 8 MB input cap and 10 s timeout.
  - Re-encodes to small WebP thumbnails (avatars 96/192 px, note images up to 1080 px wide), which also strips EXIF metadata.
  - Keeps a bounded LRU disk cache (default 512 MB, owner-adjustable), keyed by a hash of the URL. Blossom blobs are verified against their hash.
  - Serves only to the signed-in owner session, so it can't be used as an open proxy.
- **Video and audio** are tap-to-play and streamed through the node as well (revision 4, section 9), so there is no direct third-party load at all.
- **If the proxy is unavailable**, the feed shows generated identicons and image placeholders. It never falls back silently to direct third-party loads.
- The napplet never fetches media itself. The node hands it signed same-origin proxy paths, so the napplet's network-denying CSP holds.
- v1 targets single-owner nodes. Shared or team nodes need per-person service keys and permission rules first.
- Quality depends on how many independent nodes participate. A single node still works: circle, taste neighbours and exploration need no peers.

## Alternatives considered

- **Build into Continuum:** rejected by the owner. Discovery is useful without the AI workspace and should install separately.
- **NIP-90 discovery jobs (kinds 5300–5303):** widely used for algorithmic feeds ([D-Central](https://d-central.tech/nostr-data-vending-machines/)), but the shared developer guide now marks the DVM pattern as unrecommended ([nostrcg devguide](https://github.com/nostrcg/devguide/wiki/Social-Graph)). Kept as a possible later output adapter only.
- **Publish taste vectors for federated matching:** rejected, because they leak interests. Nodes share public judgements only.
- **One global reputation score:** rejected. It turns the biggest node into the rule-maker.
- **Relay-level hard blocking from peer lists:** rejected for v1. It is irreversible for the reader and affects other apps on the shared relay.

## Open questions

1. ~~Final product name and route slug.~~ Resolved 2026-10-26: **Hibiki** (響, resonance), route `/hibiki/`, repo `ChiefmonkeyArt/torii-hibiki`. An unrelated self-hosted social-content tool also uses the name Hibiki; keep "Torii Hibiki" in descriptions where it might be confused.
2. ~~Licence for the public repository.~~ Resolved 2026-10-26: GPL-3.0-or-later.
3. Exact owner→node-key binding: reuse the node-relay binding event if one is finalised, otherwise the NIP-78 binding in `docs/event-model.md`.
4. Whether `nap-torii-feed@1` should be filed with the shared NAP registry once v0.3 proves it.
