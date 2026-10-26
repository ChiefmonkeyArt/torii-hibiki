# Node-to-node trust and spam-scoring event model (v1 draft)

Status: **Proposed**, together with ADR-0001. Design rule: reuse standard kinds first. This model introduces **no new event kinds**. The only Torii-specific parts are namespaced tags on NIP-85 assertions and two NIP-78 `d` tags.

## Keys and roles

| Key | Holder | Signs | Never signs |
|---|---|---|---|
| Owner key | Owner's signer (NIP-07, external signer). Never on the server. | Service binding, owner picks (NIP-51), reports (NIP-56), reactions, 10040 provider choices | Automated assertions |
| Feed service key | Node feed service, one per algorithm (`torii-feed-spam/1`, `torii-feed-quality/1`) | NIP-85 assertions, kind 0 of the service key | Anything on the owner's behalf |

NIP-85 requires different service keys for distinct algorithms, and a key per user for personalised views ([NIP-85](https://github.com/nostr-protocol/nips/blob/master/85.md)). Torii only publishes non-personalised node views (from the operator's trust position), so one key per algorithm per node is enough. Personalised scores are never published.

## 1. Service binding (owner → node service key)

The owner signs an addressable NIP-78 event declaring that a service key speaks for their node. Peers ignore assertions from service keys without a live binding.

```json
{
  "kind": 30078,
  "pubkey": "<owner pubkey>",
  "tags": [
    ["d", "torii-feed/service/<service pubkey>"],
    ["p", "<service pubkey>"],
    ["alg", "torii-feed-spam", "1"],
    ["relay", "wss://<node>/relay"],
    ["fips", "<optional FIPS node address>"],
    ["status", "active"],
    ["expiration", "<unix, ≤ 90 days ahead>"]
  ],
  "content": ""
}
```

- **Revocation:** republish the same `d` with `["status","revoked"]`. Because the event is addressable, it replaces the old one. Peers drop that key's assertions from their next scoring pass.
- **Rotation:** bind the new key, then revoke the old one. Assertions are recomputed, never copied across keys.
- **Expiry:** bindings expire within 90 days and must be re-signed by the owner. This keeps abandoned nodes from keeping influence. Peers check expiry locally and do not rely on relay NIP-40 enforcement.
- If the node-relay owner/node binding is finalised first, this event becomes a capability entry on that binding instead.

## 2. Service key profile (kind 0)

Per NIP-85's appendix, each service key publishes a kind 0 naming the operator and algorithm: `name`, `about` (inputs used and version), `website`. Its `about` must state that the scores are advisory.

## 3. User assertions (kind 30382)

One per scored pubkey, published to the node's own relay. This is the main spam signal: one event covers everything a key posts.

```json
{
  "kind": 30382,
  "pubkey": "<feed service key>",
  "tags": [
    ["d", "<subject pubkey>"],
    ["p", "<subject pubkey>", "<relay hint>"],
    ["rank", "72"],
    ["spam_score", "4"],
    ["reports_cnt_recd", "0"],
    ["first_created_at", "1690000000"],
    ["wot_hops", "2"],
    ["t", "bitcoin"], ["t", "art"],
    ["v", "torii-feed/1"]
  ],
  "content": ""
}
```

- `rank` and `reports_cnt_recd` are NIP-85 standard tags. `spam_score` (0–100, higher means more likely spam), `wot_hops` (distance from the operator's follows, 0–9, 9 meaning none) and `v` are Torii extensions. Clients that don't know these tags ignore them.
- **Publish only when a value changes.** NIP-85 asks providers not to republish identical results.
- **Bounded set:** a node scores only keys it has actually seen in candidate pools, not the whole network.

## 4. Event assertions (kind 30383)

Used sparingly, for notes from keys that are otherwise fine: a single spam post, or a note that peers rate highly.

```json
{
  "kind": 30383,
  "pubkey": "<feed service key>",
  "tags": [
    ["d", "<event id>"],
    ["e", "<event id>", "<relay hint>"],
    ["rank", "85"],
    ["spam_score", "2"],
    ["reaction_cnt", "41"],
    ["zap_amount", "21000"],
    ["v", "torii-feed/1"]
  ],
  "content": ""
}
```

Kinds 30384 (long-form and other addressable events) and 30385 (hashtags and URLs via NIP-73) follow the same tag set in a later version.

## 5. Choosing peers (kind 10040)

Each node's owner publishes a 10040 listing which peers' service keys they read. By default the list is **NIP-44-encrypted in `content`**, so the peer graph isn't public. Owners may choose to make it public, which helps others discover good peers.

```json
{
  "kind": 10040,
  "pubkey": "<owner pubkey>",
  "tags": [],
  "content": "nip44(JSON.stringify([
    [\"30382:spam_score\", \"<peer service key>\", \"wss://peer/relay\"],
    [\"30382:rank\", \"<peer service key>\", \"wss://peer/relay\"],
    [\"30383:rank\", \"<peer service key>\", \"wss://peer/relay\"]
  ]))"
}
```

**Peer discovery:** read the public 10040 events of the owner's follows, and the service bindings of operators within 2 hops. Show them as suggestions. Adding a peer is always an owner action.

## 6. Human inputs (owner-signed)

- **NIP-56 kind 1984 reports:** the strongest local spam evidence. Published only after the owner explicitly confirms.
- **NIP-51 kind 10000 mutes:** local hide, and an input to spam scoring.
- **NIP-51 kind 30004 curation set** `d=torii-feed/picks`: "Node picks", hand-picked by the owner. Peers treat it as a curator input weighted by hit rate.
- **Private "less like this" and "not spam" corrections:** never published. They live in the sealed profile.

## 7. Private state (not events)

| State | Storage | Shared |
|---|---|---|
| Taste vector, private signals, sliders | Client-sealed ciphertext on the node, NIP-44 to self | Never |
| Peer weight table | Node, encrypted at rest | Never |
| Candidate cache and assertion inbox | Node, bounded and expiring | Never; recomputable |

Export/import uses an encrypted bundle with a manifest bound to the exact item set (the same pattern as Continuum MEMORY-1).

## 8. How a node combines peer scores

For a subject `s`, local spam evidence `L(s)` and peer scores `P_i(s)` from bound, unexpired peers with weights `w_i`:

\[ S(s) = \alpha\,L(s) + (1-\alpha)\,\frac{\sum_i \min(w_i, c)\,P_i(s)}{\sum_i \min(w_i, c)} \]

- **Cap:** `c` limits any single peer to 25% of the peer term, even if it's the only one with an opinion.
- **Initial weight:** 0.2 for peers whose operator is within 2 hops of the owner; 0 otherwise, including peers outside the trust graph.
- **Learning:** a peer's weight rises when its verdicts match what the owner does (mutes, reports, likes, "not spam") and falls when they conflict.
- **Decay:** weight halves every 30 days without confirmations.
- **Actions:** above 60 → downrank. Above 85 and local evidence present → hide. Above 85 with no local evidence → hide only if ≥2 peers from **different operators** agree; otherwise downrank. Hidden items stay viewable along with the reason.
- **Collusion check:** peers whose verdicts are near-identical across many subjects count as one operator for the quorum rule.

## 9. Ingest-time spam features (local, v1)

Feed service only; the shared relay's write policy is unchanged:
- **No trust path:** keys with no web-of-trust path go into a quarantine bucket.
- **Proof-of-work:** NIP-13 PoW and account age (`first_created_at`) raise trust for unknown keys.
- **Rate checks:** per-key bursts, duplicate or near-duplicate text, and mention/hashtag flooding.
- **Link checks:** link-only posts to domains that peers flag.

## 10. Transport

- **Baseline:** publish assertions to the node's own relay. Peers subscribe with `{"kinds":[30382,30383],"authors":[<bound service keys>]}`, plus `since` for incremental sync.
- **FIPS:** when both nodes advertise a `fips` tag in their binding, the feed service may sync over FIPS instead. It still uses the same signed events and runs the same verification, so the transport adds no trust of its own.
- **Bounds:** limits per peer per hour, maximum events held per peer, and discard of assertions older than their binding.

## Validation rules (peer-side, all mandatory)

1. Verify the signature.
2. Check that a **live, unexpired, owner-signed** binding exists for the service key, with a matching `alg`.
3. Check that `v` is supported.
4. Check value ranges (`rank` and `spam_score` 0–100).
5. Ignore any tag the node doesn't understand.
6. Never act on assertions from a revoked key, even if they were cached earlier.
