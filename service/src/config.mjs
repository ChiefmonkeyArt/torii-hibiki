// config.mjs — environment parsing. All settings come from /etc/hibiki/hibiki.env
// (written by install.sh) or the process environment in development.
import { nip19 } from 'nostr-tools';

const HEX64 = /^[0-9a-f]{64}$/;

export function decodePubkey(v) {
  v = String(v || '').trim();
  if (HEX64.test(v)) return v;
  if (v.startsWith('npub1')) {
    const d = nip19.decode(v);
    if (d.type === 'npub' && HEX64.test(d.data)) return d.data;
  }
  return null;
}

function list(v, dflt) {
  const out = String(v ?? dflt).split(/[\s,]+/).filter(Boolean);
  for (const u of out) if (!/^wss?:\/\/[^\s/]+/.test(u)) throw new Error(`bad relay url ${u}`);
  return out;
}

export function loadConfig(env = process.env) {
  const owner = decodePubkey(env.HIBIKI_OWNER);
  if (!owner) throw new Error('HIBIKI_OWNER must be an npub or 64-char hex pubkey');
  const secret = String(env.HIBIKI_SECRET || '');
  if (!/^[0-9a-f]{64,}$/.test(secret)) throw new Error('HIBIKI_SECRET must be >=32 random bytes in hex');
  const port = Number(env.HIBIKI_PORT || 8795);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('bad HIBIKI_PORT');
  const dev = env.HIBIKI_DEV === '1';
  return Object.freeze({
    owner,
    secret: Buffer.from(secret, 'hex'),
    host: '127.0.0.1', // loopback only, nginx fronts it
    port,
    dataDir: env.HIBIKI_DATA || '/var/lib/hibiki',
    // Shared node relay first (the Suite strfry), then public index relays used
    // only to discover NIP-65 lists the node relay does not have yet.
    primaryRelay: env.HIBIKI_PRIMARY_RELAY || 'ws://127.0.0.1:7777',
    publicRelay: env.HIBIKI_PUBLIC_RELAY || '',
    indexRelays: list(env.HIBIKI_INDEX_RELAYS, 'wss://purplepag.es wss://relay.damus.io wss://nos.lol'),
    origin: (env.HIBIKI_ORIGIN || '').replace(/\/+$/, ''), // e.g. https://chiefmonkey.art
    basePath: '/hibiki',
    imgCacheBytes: Number(env.HIBIKI_IMG_CACHE_MB || 512) * 1024 * 1024,
    retainDays: Number(env.HIBIKI_RETAIN_DAYS || 14),
    syncMinutes: Number(env.HIBIKI_SYNC_MINUTES || 5),
    maxOutboxRelays: Number(env.HIBIKI_MAX_RELAYS || 24),
    dev, // dev: skips NIP-98 login on loopback; never set on a VPS
  });
}
