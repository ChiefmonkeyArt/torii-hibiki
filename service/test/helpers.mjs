import { bech32Encode, convertBits } from '../src/zap.mjs';

/** Builds a structurally valid BOLT11 invoice (dummy signature) with the given hrp and description hash. */
export function fakeInvoice(hrp, hashHex) {
  const field = (type, bytes) => { const d = convertBits([...bytes], 8, 5, true); return [type, d.length >> 5, d.length & 31, ...d]; };
  const ts = []; let t = Math.floor(Date.now() / 1000); for (let i = 0; i < 7; i++) { ts.unshift(t & 31); t = Math.floor(t / 32); }
  const words = [...ts, ...field(1, Buffer.alloc(32, 7)), ...field(23, Buffer.from(hashHex, 'hex')), ...new Array(104).fill(0)];
  return bech32Encode(hrp, words);
}
