import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sniff, stripJpeg, stripPng, stripWebp, loadImager, VIPS_PATHS } from '../src/imaging.mjs';

const seg = (m, data) => { const b = Buffer.alloc(4 + data.length); b[0] = 0xff; b[1] = m; b.writeUInt16BE(data.length + 2, 2); Buffer.from(data).copy(b, 4); return b; };
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe0, 'JFIF\0'), seg(0xe1, 'Exif\0\0GPS-SECRET'), seg(0xed, 'Photoshop IPTC'), seg(0xfe, 'comment'), seg(0xe2, 'ICC_PROFILE\0'), seg(0xdb, 'qt'), Buffer.from([0xff, 0xda, 0, 2, 1, 2, 3, 0xff, 0xd9])]);
const chunk = (t, d) => { const b = Buffer.alloc(12 + d.length); b.writeUInt32BE(d.length, 0); b.write(t, 4, 'latin1'); Buffer.from(d).copy(b, 8); return b; };
const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', 'x'.repeat(13)), chunk('tEXt', 'GPS\0secret'), chunk('eXIf', 'MM'), chunk('IDAT', 'data'), chunk('IEND', '')]);
const wchunk = (t, d) => { const pad = d.length & 1; const b = Buffer.alloc(8 + d.length + pad); b.write(t, 0, 'latin1'); b.writeUInt32LE(d.length, 4); Buffer.from(d).copy(b, 8); return b; };
const vp8x = Buffer.alloc(10); vp8x[0] = 0x0c;
const wbody = Buffer.concat([wchunk('VP8X', vp8x), wchunk('VP8 ', 'imagedata'), wchunk('EXIF', 'GPS-SECRET'), wchunk('XMP ', '<x/>')]);
const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), wbody]); webp.writeUInt32LE(wbody.length + 4, 4);

test('sniff identifies rasters by magic bytes only', () => {
  assert.equal(sniff(jpeg), 'image/jpeg'); assert.equal(sniff(png), 'image/png'); assert.equal(sniff(webp), 'image/webp');
  assert.equal(sniff(Buffer.from('GIF89a......')), 'image/gif');
  assert.equal(sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">')), null, 'SVG is never served');
  assert.equal(sniff(Buffer.from('<html><script>')), null);
});

test('metadata stripping removes EXIF, GPS, XMP and comments but keeps image data', () => {
  const j = stripJpeg(jpeg);
  assert.ok(!j.includes('GPS-SECRET') && !j.includes('IPTC') && !j.includes('comment'));
  assert.ok(j.includes('JFIF') && j.includes('ICC_PROFILE') && j.includes(Buffer.from([0xff, 0xda])));
  const p = stripPng(png);
  assert.ok(!p.includes('secret') && !p.includes('eXIf') && p.includes('IDAT') && p.includes('IEND'));
  const w = stripWebp(webp);
  assert.ok(!w.includes('GPS-SECRET') && !w.includes('XMP ') && w.includes('imagedata'));
  assert.equal(w.readUInt32LE(4), w.length - 8, 'RIFF size rewritten');
  assert.equal(w[20] & 0x0c, 0, 'VP8X EXIF/XMP flags cleared');
  assert.throws(() => stripJpeg(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff])));
});

test('copy backend: strips and refuses non-rasters (works on any CPU)', async () => {
  const im = await loadImager('copy');
  assert.equal(im.name, 'copy');
  const r = await im.render(jpeg, 640);
  assert.equal(r.type, 'image/jpeg'); assert.ok(!r.body.includes('GPS-SECRET'));
  await assert.rejects(im.render(Buffer.from('<svg/>.......'), 640), /not a raster/);
});

test('auto picks a working backend and never throws', async () => {
  const notes = [];
  const im = await loadImager('auto', (...a) => notes.push(a.join(' ')));
  assert.ok(['sharp', 'vips', 'copy'].includes(im.name));
});

const hasVips = VIPS_PATHS.some((p) => fs.existsSync(p));
test('vips backend re-encodes to bounded WebP without metadata', { skip: !hasVips && 'libvips-tools not installed' }, async () => {
  const sharpless = await loadImager('vips');
  assert.equal(sharpless.name, 'vips');
  // A real 1200x800 JPEG with EXIF (made with sharp when it runs here).
  const src = await (await import('sharp')).default({ create: { width: 1200, height: 800, channels: 3, background: '#c33' } })
    .withExif({ IFD0: { Copyright: 'GPS-SECRET' } }).jpeg().toBuffer().catch(() => null);
  if (!src) return;
  const r = await sharpless.render(src, 320);
  assert.equal(r.type, 'image/webp');
  assert.equal(r.body.readUInt32LE(4) + 8, r.body.length);
  assert.ok(!r.body.includes('GPS-SECRET'));
  await assert.rejects(sharpless.render(Buffer.from('not an image at all'), 320), /could not decode/);
});
