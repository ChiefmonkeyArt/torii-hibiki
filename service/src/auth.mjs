// auth.mjs — NIP-98 HTTP auth (kind 27235) for owner sign-in. The browser's
// signer signs a one-off event bound to this URL and method; the node checks
// it and issues an HttpOnly session cookie. The node never sees a key.
import { verifyEvent } from 'nostr-tools/pure';

export function verifyNip98(header, { url, method, owner, seen, now = Date.now() / 1000 }) {
  const m = /^Nostr ([A-Za-z0-9+/=_-]{40,8000})$/.exec(header || '');
  if (!m) return { ok: false, why: 'missing Nostr authorization' };
  let ev;
  try { ev = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')); } catch { return { ok: false, why: 'bad encoding' }; }
  if (!ev || ev.kind !== 27235 || !Array.isArray(ev.tags)) return { ok: false, why: 'wrong kind' };
  if (Math.abs(now - Number(ev.created_at)) > 60) return { ok: false, why: 'stale' };
  const u = ev.tags.find((t) => t[0] === 'u')?.[1];
  const meth = ev.tags.find((t) => t[0] === 'method')?.[1];
  if (u !== url) return { ok: false, why: 'url mismatch' };
  if (String(meth).toUpperCase() !== method) return { ok: false, why: 'method mismatch' };
  if (seen && seen.has(ev.id)) return { ok: false, why: 'replayed' };
  if (!verifyEvent(ev)) return { ok: false, why: 'bad signature' };
  if (ev.pubkey !== owner) return { ok: false, why: 'not the owner of this node' };
  if (seen) { seen.set(ev.id, now); for (const [k, t] of seen) if (now - t > 120) seen.delete(k); }
  return { ok: true, pubkey: ev.pubkey };
}

/** Kinds the owner may publish through the node, after the confirm step. */
export const PUBLISH_KINDS = new Set([1, 6, 7, 10000, 30004, 30078]);

export function checkPublish(ev, owner) {
  if (!ev || typeof ev !== 'object') return 'not an event';
  if (!PUBLISH_KINDS.has(ev.kind)) return `kind ${ev.kind} not allowed`;
  if (ev.pubkey !== owner) return 'not signed by the owner';
  if (JSON.stringify(ev).length > 64 * 1024) return 'too large';
  if (Math.abs(Date.now() / 1000 - ev.created_at) > 600) return 'created_at too far from now';
  // Verify a clean copy: nostr-tools caches a verified flag on the object itself.
  const { id, pubkey, created_at, kind, tags, content, sig } = ev;
  if (!verifyEvent({ id, pubkey, created_at, kind, tags, content, sig })) return 'bad signature';
  return null;
}
