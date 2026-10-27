// qr.mjs — minimal QR Code encoder (ISO/IEC 18004), for showing Lightning
// invoices. Byte and alphanumeric modes, ECC level M (L if needed), versions
// 1–25. Follows the structure of Project Nayuki's reference encoder (MIT).
// Returns rows of '0'/'1'; the napplet draws them as one SVG path.

const ECC_CW = { // codewords per block, index = version
  L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26],
  M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28],
};
const BLOCKS = {
  L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12],
  M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21],
};
const FORMAT_ECL = { L: 1, M: 0 };
const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
const MAX_VER = 25;

function rawModules(v) {
  let r = (16 * v + 128) * v + 64;
  if (v >= 2) { const n = Math.floor(v / 7) + 2; r -= (25 * n - 10) * n - 55; if (v >= 7) r -= 36; }
  return r;
}
const dataCodewords = (v, e) => Math.floor(rawModules(v) / 8) - ECC_CW[e][v] * BLOCKS[e][v];

function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; }
  return z & 0xff;
}
function rsDivisor(deg) {
  const r = new Array(deg).fill(0); r[deg - 1] = 1;
  let root = 1;
  for (let i = 0; i < deg; i++) {
    for (let j = 0; j < deg; j++) { r[j] = gfMul(r[j], root); if (j + 1 < deg) r[j] ^= r[j + 1]; }
    root = gfMul(root, 2);
  }
  return r;
}
function rsRemainder(data, div) {
  const r = new Array(div.length).fill(0);
  for (const b of data) {
    const f = b ^ r.shift(); r.push(0);
    div.forEach((c, i) => { r[i] ^= gfMul(c, f); });
  }
  return r;
}

function segmentBits(text) {
  const alnum = [...text].every((c) => ALNUM.includes(c));
  const bytes = alnum ? null : [...Buffer.from(text, 'utf8')];
  const n = alnum ? text.length : bytes.length;
  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  if (alnum) {
    for (let i = 0; i + 1 < n; i += 2) push(ALNUM.indexOf(text[i]) * 45 + ALNUM.indexOf(text[i + 1]), 11);
    if (n % 2) push(ALNUM.indexOf(text[n - 1]), 6);
  } else for (const b of bytes) push(b, 8);
  return { alnum, n, bits };
}
const countBits = (alnum, v) => (alnum ? (v <= 9 ? 9 : v <= 26 ? 11 : 13) : (v <= 9 ? 8 : 16));

/** Encodes `text`; returns { size, rows } or throws if it does not fit. */
export function encodeQR(text) {
  const seg = segmentBits(String(text));
  let ver = 0, ecl = null;
  for (const e of ['M', 'L']) {
    for (let v = 1; v <= MAX_VER; v++) {
      const need = 4 + countBits(seg.alnum, v) + seg.bits.length;
      if (seg.n < 2 ** countBits(seg.alnum, v) && need <= dataCodewords(v, e) * 8) { ver = v; ecl = e; break; }
    }
    if (ver) break;
  }
  if (!ver) throw new Error('too long for a QR code');
  const cap = dataCodewords(ver, ecl) * 8;
  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  push(seg.alnum ? 2 : 4, 4); push(seg.n, countBits(seg.alnum, ver)); bits.push(...seg.bits);
  push(0, Math.min(4, cap - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) push(pad, 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));

  // Error correction and interleaving.
  const nb = BLOCKS[ecl][ver], eccLen = ECC_CW[ecl][ver], raw = Math.floor(rawModules(ver) / 8);
  const nShort = nb - (raw % nb), shortLen = Math.floor(raw / nb), div = rsDivisor(eccLen);
  const blocks = [];
  for (let i = 0, k = 0; i < nb; i++) {
    const d = data.slice(k, k + shortLen - eccLen + (i < nShort ? 0 : 1)); k += d.length;
    const ecc = rsRemainder(d, div);
    if (i < nShort) d.push(0);
    blocks.push(d.concat(ecc));
  }
  const words = [];
  for (let i = 0; i < blocks[0].length; i++) blocks.forEach((b, j) => { if (i !== shortLen - eccLen || j >= nShort) words.push(b[i]); });

  // Matrix with function patterns.
  const size = ver * 4 + 17;
  const mod = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => { mod[y][x] = dark; fn[y][x] = true; };
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const d = Math.max(Math.abs(dx), Math.abs(dy)), x = cx + dx, y = cy + dy;
      if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  const align = [];
  if (ver > 1) {
    const n = Math.floor(ver / 7) + 2, step = Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
    align.push(6);
    for (let p = size - 7; align.length < n; p -= step) align.splice(1, 0, p);
  }
  const last = align.length - 1;
  align.forEach((ax, i) => align.forEach((ay, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }));
  const format = (mask) => {
    const d = (FORMAT_ECL[ecl] << 3) | mask;
    let r = d; for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
    const b = ((d << 10) | r) ^ 0x5412, bit = (i) => ((b >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  format(0);
  if (ver >= 7) {
    let r = ver; for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25);
    const b = (ver << 12) | r;
    for (let i = 0; i < 18; i++) { const d = ((b >>> i) & 1) === 1, a = size - 11 + (i % 3), c = Math.floor(i / 3); set(a, c, d); set(c, a, d); }
  }

  // Codewords in the zigzag order.
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - vert : vert;
      if (!fn[y][x] && i < words.length * 8) { mod[y][x] = ((words[i >>> 3] >>> (7 - (i & 7))) & 1) === 1; i++; }
    }
  }

  // Pick the mask with the lowest penalty.
  const MASKS = [
    (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];
  const applyMask = (m) => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && MASKS[m](x, y)) mod[y][x] = !mod[y][x]; };
  let best = 0, bestP = Infinity;
  for (let m = 0; m < 8; m++) {
    applyMask(m); format(m);
    const p = penalty(mod, size);
    if (p < bestP) { bestP = p; best = m; }
    applyMask(m);
  }
  applyMask(best); format(best);
  return { size, version: ver, ecl, rows: mod.map((r) => r.map((d) => (d ? '1' : '0')).join('')) };
}

function penalty(mod, size) {
  let p = 0, dark = 0;
  const lines = [];
  for (let y = 0; y < size; y++) { lines.push(mod[y]); lines.push(mod.map((r) => r[y])); }
  const FIND = [/10111010000/g, /00001011101/g];
  for (const l of lines) {
    let run = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && l[i] === l[i - 1]) run++;
      else { if (run >= 5) p += run - 2; run = 1; }
    }
    const s = l.map((d) => (d ? '1' : '0')).join('');
    for (const re of FIND) p += 40 * (s.match(re) || []).length;
  }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (mod[y][x]) dark++;
    if (x < size - 1 && y < size - 1) { const c = mod[y][x]; if (c === mod[y][x + 1] && c === mod[y + 1][x] && c === mod[y + 1][x + 1]) p += 3; }
  }
  const total = size * size;
  p += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;
  return p;
}
