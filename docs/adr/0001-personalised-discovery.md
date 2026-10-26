# ADR-0001: Hibiki — personalised Nostr discovery as a standalone Torii napplet

Date: 2026-10-26. Status: **Proposed**, revision 2 (reviewed 2026-10-26). Target first slice: v0.1.0 (preview card only). Licence: GPL-3.0-or-later, matching Continuum, Plebeian Market, Quest and Suite.

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

### 6. FIPS is optional transport

FIPS helps node-to-node exchange: assertion sync and candidate fetches between peers behind NAT or without a domain. The feed service uses it when both nodes run it and falls back to `wss://` relays otherwise. Browsers never run FIPS, and keys never pass through it. Relays remain the baseline. The feature must work with no FIPS at all.

### 7. Shared-relay boundary

In P0–P3, spam filtering happens in the feed service's ingest path, and the shared node relay's write policy is unchanged. That relay also serves Plebeian Market and Quest presence. P4 needs one additive rule: accept kinds 30382/30383 from this node's bound service keys. That rule ships under a separate Torii Suite ADR. Hibiki never adds rejection rules to the shared relay.

## Consequences

- No Continuum, Quest or Base code changes are needed to start. Base registration is reused as is.
- The node needs a small always-on service (planned from v0.2). Embeddings are optional and gated on host capacity. v1 runs without an ML model.
- A new long-lived key (the feed service key) is introduced. It is bound to the owner by a signed declaration and can be revoked.
- Media in notes, **and profile pictures and banners**, can leak the reader's IP to third-party hosts. They are click-to-load by default, with an optional node media proxy later. The napplet never fetches media itself: the shell hands it already-approved blob URLs, so the napplet's network-denying CSP holds.
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
