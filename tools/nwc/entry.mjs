// Source for web/nwc.js (built by tools/build-nwc.mjs from the service's pinned
// nostr-tools). Only the pieces the shell needs to talk to a wallet over NIP-47
// with its own connection key: sign, NIP-44 v2 and NIP-04. GPL-3.0-or-later.
import { finalizeEvent, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { v2 } from 'nostr-tools/nip44';
import { encrypt as e04, decrypt as d04 } from 'nostr-tools/nip04';
// Copies keep inputs plain (no cached verified flag, no foreign prototypes).
const plain = (e) => ({ kind: e.kind, created_at: e.created_at, tags: (e.tags || []).map((x) => x.map(String)), content: String(e.content) });
const hex = (h) => Uint8Array.from(h.match(/../g), (b) => parseInt(b, 16));
self.HibikiNWC = Object.freeze({
  pubkey: (sk) => getPublicKey(hex(sk)),
  sign: (t, sk) => finalizeEvent(plain(t), hex(sk)),
  verify: (ev) => { try { return verifyEvent({ ...plain(ev), id: ev.id, pubkey: ev.pubkey, sig: ev.sig }); } catch { return false; } },
  enc: (scheme, sk, pk, text) => scheme === 'nip44_v2' ? v2.encrypt(text, v2.utils.getConversationKey(hex(sk), pk)) : e04(hex(sk), pk, text),
  dec: (scheme, sk, pk, data) => scheme === 'nip44_v2' ? v2.decrypt(data, v2.utils.getConversationKey(hex(sk), pk)) : d04(hex(sk), pk, data),
});
