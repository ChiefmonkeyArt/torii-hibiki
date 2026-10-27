# Hibiki — Strategy

Living document.

**Standalone napplet (2026-10-26):** Hibiki is a separate add-on to a Torii node, not a Continuum feature. The first host is its own page at `/hibiki/` with a Base launcher card. Continuum, Quest and Torii DE may mount it later through `nap-torii-feed@1`. See `docs/adr/0001-personalised-discovery.md`.

**Discovery thesis:** follows describe who you know, while reactions describe what you enjoy. Reach past the circle through taste neighbours (strangers with overlapping public reactions), similar content, curators weighted by hit rate and a permanent 10–15% exploration slot. Make every item explainable and every weight steerable.

**Privacy boundary (load-bearing):** the node does public compute only. Private signals, the taste vector and final ranking live in the browser. Private state is stored on the node as client-sealed ciphertext and is never published.

**Cooperation:** nodes publish signed NIP-85 assertions from dedicated feed service keys bound to the owner. Peer evidence alone can only downrank. Hiding needs local evidence or a two-operator quorum. Peer weights are capped, learned and decaying. FIPS is an optional transport.

**Footprint:** no ML model is required through P2. Optional embeddings are gated on host capacity and must prove a measured gain.

**Plumbing (2026-10-26):** Applesauce v7 is the Nostr client layer in the shell and the service, matching Quest ADR-0140. FIPS is the default node-to-node route wherever both ends support it, with relays/HTTPS as the universal fallback.

**Content first (2026-10-27, ADR-0001 rev 4):** Hibiki is a curator of interesting and entertaining Nostr content from your circle and its news, across notes, pictures, video, audio, long reads and live streams. Social sections show original posts, not replies. The algorithm stays in the background: subtle, explainable on request, and beautiful to adjust. The Japanese for curator, 目利き (mekiki), names the curated picks in News.
