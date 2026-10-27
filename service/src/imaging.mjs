// imaging.mjs — image re-encoding with a fallback chain, so the proxy works on
// any x86-64 or arm64 VPS:
//   1. sharp  — fastest; its prebuilt binaries need an x86-64-v2 (or arm64) CPU.
//   2. vips   — the distro's libvips CLI (`libvips-tools`), built for baseline
//               CPUs. Bytes go through stdin/stdout, no temp files.
//   3. copy   — no re-encoder available: serve the original after checking its
//               magic bytes and stripping metadata (EXIF/GPS, XMP, comments)
//               in JS. No resizing.
// Every backend strips metadata and returns { body, type }.
import { execFile } from 'node:child_process';
import fs from 'node:fs';

export const VIPS_PATHS = ['/usr/bin/vips', '/usr/local/bin/vips'];

/** Detect a raster type from magic bytes; null if not one we serve. */
export function sniff(b) {
  if (!b || b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a) return 'image/png';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (b.toString('latin1', 0, 6) === 'GIF87a' || b.toString('latin1', 0, 6) === 'GIF89a') return 'image/gif';
  if (b.toString('latin1', 4, 8) === 'ftyp' && /^(avif|avis)$/.test(b.toString('latin1', 8, 12))) return 'image/avif';
  return null;
}

/** JPEG: keep APP0 (JFIF), APP2 (ICC) and APP14 (Adobe colour); drop other APPn and COM. */
export function stripJpeg(b) {
  const out = [b.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) throw new Error('bad jpeg');
    const m = b[i + 1];
    if (m === 0xda) { out.push(b.subarray(i)); return Buffer.concat(out); } // start of scan: rest is image data
    if (m === 0xff) { i++; continue; } // fill byte
    const len = b.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > b.length) throw new Error('bad jpeg');
    const app = m >= 0xe0 && m <= 0xef;
    if (!((app && m !== 0xe0 && m !== 0xe2 && m !== 0xee) || m === 0xfe)) out.push(b.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  throw new Error('bad jpeg');
}

/** PNG: drop text, EXIF and time chunks. */
export function stripPng(b) {
  const DROP = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);
  const out = [b.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= b.length) {
    const len = b.readUInt32BE(i), type = b.toString('latin1', i + 4, i + 8), end = i + 12 + len;
    if (end > b.length) throw new Error('bad png');
    if (!DROP.has(type)) out.push(b.subarray(i, end));
    i = end;
    if (type === 'IEND') return Buffer.concat(out);
  }
  throw new Error('bad png');
}

/** WebP: drop EXIF and XMP chunks and clear their VP8X flags. */
export function stripWebp(b) {
  const parts = [];
  let i = 12;
  while (i + 8 <= b.length) {
    const type = b.toString('latin1', i, i + 4), len = b.readUInt32LE(i + 4), end = i + 8 + len + (len & 1);
    if (end > b.length) throw new Error('bad webp');
    if (type !== 'EXIF' && type !== 'XMP ') {
      const c = Buffer.from(b.subarray(i, end));
      if (type === 'VP8X') c[8] &= ~0x0c; // EXIF (0x08) and XMP (0x04) flags
      parts.push(c);
    }
    i = end;
  }
  const body = Buffer.concat(parts), head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1'); head.writeUInt32LE(body.length + 4, 4); head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body]);
}

/** GIF carries no EXIF/GPS; served as-is (first frame decoding needs a re-encoder). */
const stripGif = (b) => b;

function copyBackend() {
  return {
    name: 'copy',
    async render(body) {
      const type = sniff(body);
      if (!type) throw Object.assign(new Error('not a raster image'), { status: 415 });
      const fn = { 'image/jpeg': stripJpeg, 'image/png': stripPng, 'image/webp': stripWebp, 'image/gif': stripGif }[type];
      if (!fn) throw Object.assign(new Error(`${type} needs a re-encoder`), { status: 415 });
      return { body: fn(body), type };
    },
  };
}

function vipsBackend(bin) {
  const env = { PATH: '/usr/bin:/bin', VIPS_BLOCK_UNTRUSTED: '1', VIPS_CONCURRENCY: '1' };
  return {
    name: 'vips',
    render(body, w) {
      return new Promise((resolve, reject) => {
        const child = execFile(bin, ['thumbnail_source', '[descriptor=0]', '.webp[Q=74,strip]', String(w), '--height', String(w * 2), '--size', 'down'],
          { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024, timeout: 20000, killSignal: 'SIGKILL', env },
          (err, stdout) => {
            if (err || !stdout?.length || sniff(stdout) !== 'image/webp') return reject(Object.assign(new Error('vips could not decode image'), { status: 415 }));
            resolve({ body: stdout, type: 'image/webp' });
          });
        child.stdin.on('error', () => {});
        child.stdin.end(body);
      });
    },
  };
}

async function sharpBackend() {
  const sharp = (await import('sharp')).default;
  sharp.cache(false);
  sharp.concurrency(1);
  // Prove the native binary actually runs on this CPU before relying on it.
  await sharp({ create: { width: 2, height: 2, channels: 3, background: '#000' } }).webp().toBuffer();
  return {
    name: 'sharp',
    async render(body, w) {
      const out = await sharp(body, { limitInputPixels: 40e6, animated: false, failOn: 'error' })
        .rotate().resize({ width: w, height: w * 2, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 74, effort: 3 }).toBuffer();
      return { body: out, type: 'image/webp' };
    },
  };
}

/** Pick the best working backend. `prefer` = auto | sharp | vips | copy. */
export async function loadImager(prefer = 'auto', log = () => {}) {
  if (prefer === 'auto' || prefer === 'sharp') {
    try { return await sharpBackend(); }
    catch (e) { log('imaging', `sharp unavailable: ${String(e.message).split('\n')[0]}`); if (prefer === 'sharp') throw e; }
  }
  if (prefer === 'auto' || prefer === 'vips') {
    const bin = VIPS_PATHS.find((p) => fs.existsSync(p));
    if (bin) return vipsBackend(bin);
    if (prefer === 'vips') throw new Error('vips not installed');
    log('imaging', 'libvips not found; serving originals with metadata stripped (install libvips-tools to resize)');
  }
  return copyBackend();
}
