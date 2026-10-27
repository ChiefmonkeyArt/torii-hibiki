# Node-to-node trust and spam-scoring event model (v1 draft)

Status: **Accepted** (2026-10-27, with ADR-0001 revision 4), revision 2. Nothing in it is published before P4. Design rule: reuse standard kinds first. This model introduces **no new event kinds**. The only Torii-specific parts are namespaced tags on NIP-85 assertions and two NIP-78 `d` tags.

## Keys and roles

| Key | Holder | Signs | Never signs |
|---|---|---|---|
| Owner key | Owner's signer (NIP-07, external signer). Never on the server. | Service binding, owner picks (NIP-51), reports (NIP-56), reactions, 10040 provider choices | Automated assertions |
| Feed service key | Node feed service, one per algorithm (`torii-feed-spam/1`, `torii-feed-quality/1`) | NIP-85 assertions, kind 0 of the service key | Anything on the owner's behalf |

NIP-85 requires different service keys for distinct algorithms, and a key per user for personalised views ([NIP-85](https://github.com/nostr-protocol/nips/blob/master/85.md)). Torii only publishes non-personalised node views (from the operator's trust position), so one key per algorithm per node is enough. **v1 assumes single-owner nodes.** A node that serves several people must use a separate service key per person, as NIP-85 requires. Personalised scores are never published.

## 1. Service binding (owner ↔ node service key)

The binding is **mutual**. The owner signs an addressable NIP-78 event declaring that a service key speaks for their node. The service key's kind 0 (section 2) names the owner in return. Peers ignore assertions unless both directions match. Without the return link, anyone could publish a binding claiming someone else's service key and borrow its reputation.

Discovery doesn't need the owner's pubkey in advance. Peers query `{"kinds":[30078],"#p":["<service pubkey>"]}` and accept only an event whose author matches the owner named in that service key's kind 0.

```json
{
  "kind": 30078,
  "pubkey": "<owner pubkey>",
  "tags": [
    ["d", "torii-feed/service/<service pubkey>"],
    ["p", "<service pubkey>"],
    ["alg", "torii-feed-spam", "1"],
    ["relay", "wss://<node>/relay"],
    ["fips", "<optional FIPS node address — omit to keep it private>"],
    ["status", "active"],
    ["expiration", "<unix, ≤ 90 days ahead>"]
  ],
  "content": ""
}
```

- **Revocation:** republish the same `d` with `["status","revoked"]`. Because the event is addressable, it replaces the old one. Peers drop that key's assertions from their next scoring pass.
- **Rotation:** bind the new key, then revoke the old one. Assertions are recomputed, never copied across keys.
- **Expiry:** bindings expire within 90 days and must be re-signed by the owner. This keeps abandoned nodes from keeping influence. Peers check expiry locally and do not rely on relay NIP-40 enforcement.
- **FIPS address:** publishing it reveals how to reach the node. Leave it out unless the owner wants open FIPS peering. Peers that already trust each other can swap addresses privately later.
- If the node-relay owner/node binding is finalised first, this event becomes a capability entry on that binding instead.

## 2. Service key profile (kind 0)

Per NIP-85's appendix, each service key publishes a kind 0 naming the operator and algorithm: `name`, `about` (inputs used and version), `website`. Its `about` must state that the scores are advisory. It must also carry `["p", "<owner pubkey>"]` and `["alg", "<name>", "<version>"]` tags, the return half of the binding. The binding is valid only if this tag set matches the owner's 30078.

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
- **Local evidence only (no laundering):** a node's published scores come only from its own ingest features and its owner's actions. Peer scores it received are never mixed in. Otherwise one node's opinion could echo around the network, amplifying itself and hiding where it came from.
- **Negative scores need strong evidence:** `spam_score` ≥ 60 is published only when the owner muted or reported the key, or when at least two independent ingest features fire (for example a burst plus near-duplicate text). An owner can turn negative publication off completely. Every negative score is a public claim about a person, signed by their node.
- **`first_created_at` is approximate:** it means "earliest event this node has seen", not the account's true creation time. Peers should treat it as a weak signal.
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

Two separate things are needed here:

- **Working peer list (on the node):** the list of peers the feed service actually reads. The owner sets it through the authenticated owner session, and the node stores it encrypted at rest. A NIP-44 list encrypted to the owner can't be read by the node, because the node never holds the owner's key. So the node must not depend on decrypting a 10040.
- **Portable declaration (kind 10040):** optional. It is published so other NIP-85 clients the owner uses can apply the same providers. It is **NIP-44-encrypted in `content` by default**, so the peer graph isn't public. Owners may choose to publish it in public tags instead, which helps others discover good peers.

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

For subject `s`, each peer `i` with a valid binding sends a score `P_i(s)` (0–100). Its effective weight is `m_i = min(w_i, c)`, where `w_i` is the learned weight and `c = 0.5`. The peer term is pulled toward a neutral score of 0 by a prior mass `k = 0.5`:

\[ S_{peer}(s) = \frac{\sum_i m_i\,P_i(s)}{\sum_i m_i + k} \]

The final score is \( S(s) = \max\big(I(s),\, S_{peer}(s)\big) \), where `I(s)` is the node's own ingest score (section 9). **An explicit owner verdict overrides both.** Mute or report sets the score to 100; "not spam" sets it to 0 and lowers the weight of every peer that disagreed.

- **Why there's a prior:** without `k`, a single peer's score passes through at 100% whatever its cap. That was the bug in revision 1. With `k`, one fully trusted peer can contribute at most 50, which is below the downrank threshold. Two such peers reach 67, and six are needed to reach 85.
- **Initial weight:** 0.2 for peers whose operator is within 2 hops of the owner, so a new peer contributes at most about 29. Peers outside the trust graph start at 0.
- **Learning:** a peer's weight rises when its verdicts match what the owner does (mutes, reports, likes, "not spam") and falls when they conflict.
- **Decay:** weight halves every 30 days without confirmations.
- **Actions:**
  - `S` ≥ 60 → downrank.
  - Owner verdict, or `I(s)` ≥ 85 → hide.
  - Hide on peer evidence alone only if all three hold: `S_peer` ≥ 60, at least 2 quorum-eligible peers each send `P_i` ≥ 90 (two full-weight peers at 90 give exactly 60), and those peers belong to different operators.
  - Hidden items stay viewable along with the reason.
- **Quorum eligibility (anti-collusion):** a peer counts only if the owner added it personally, it has its own owner key and mutual binding, and its binding is at least 30 days old. Several service keys under one owner count as one operator. Honest Torii nodes run the same algorithm and will often agree, so agreement is not treated as collusion. Repeated conflict with the owner's verdicts is the signal instead.

## 9. Ingest-time spam features (local, v1)

Feed service only; the shared relay's write policy is unchanged:
- **No trust path:** keys with no web-of-trust path go into a quarantine bucket.
- **Proof-of-work:** NIP-13 PoW and account age (`first_created_at`) raise trust for unknown keys.
- **Rate checks:** per-key bursts, duplicate or near-duplicate text, and mention/hashtag flooding.
- **Link checks:** link-only posts to domains that peers flag.

## 10. Transport

- **Baseline:** publish assertions to the node's own relay. **This needs one additive write rule on the shared relay:** accept kinds 30382/30383 from this node's bound service keys. The relay also serves Plebeian Market and Quest, so the rule ships with P4 under a separate Torii Suite ADR and isn't assumed here. Peers subscribe with `{"kinds":[30382,30383],"authors":[<bound service keys>]}`, plus `since` for incremental sync.
- **FIPS first:** when both nodes are FIPS-reachable (an advertised `fips` tag, or an address exchanged privately), the feed service syncs over FIPS by default and falls back to `wss://` automatically. It's the same Applesauce subscription over a different route, with the same signed events and verification, so the transport adds no trust of its own.
- **Client library:** subscriptions, the event store and NIP-85/10040 parsing use Applesauce (`applesauce-relay`, `applesauce-sqlite`, `applesauce-common`). See ADR-0001 section 8.
- **Bounds:** limits per peer per hour, maximum events held per peer, and discard of assertions older than their binding.

## Validation rules (peer-side, all mandatory)

1. Verify the signature.
2. Check that a **live, unexpired, mutual** binding exists for the service key: an owner-signed 30078 plus a service kind 0 naming that owner, with matching `alg`.
3. Check that `v` is supported.
4. Check value ranges (`rank` and `spam_score` 0–100).
5. Ignore any tag the node doesn't understand.
6. Never act on assertions from a revoked key, even if they were cached earlier.
7. Never republish or fold received peer scores into the node's own assertions.
