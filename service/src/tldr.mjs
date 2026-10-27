// tldr.mjs — free, local, extractive article summaries ("TL;DR") for link
// previews. No AI model and no third-party service: the node already fetches the
// page for its preview, so it pulls out the article text (JSON-LD articleBody,
// else <article>/<main> paragraphs) and picks the 3-4 most representative
// sentences by word frequency, position and overlap with the title (a light
// TextRank-style method). Output is plain text only.

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ', mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', rsquo: '\u2019', lsquo: '\u2018', rdquo: '\u201d', ldquo: '\u201c' };
export const unent = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)); return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''; }
  return ENT[e.toLowerCase()] ?? m;
});
const squash = (s) => unent(s.replace(/<[^>]*>/g, ' ')).replace(/\s*\[\s*(\d+|[a-z]|citation needed|note \d+)\s*\]/gi, '').replace(/\s+([,.;:!?])/g, '$1').replace(/\s+/g, ' ').trim();

const STOP = new Set(('a about above after again against all also am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if in into is it its itself just me more most my myself no nor not now of off on once only or other our ours out over own same she should so some such than that the their theirs them then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours said says one two new like get got make made many much may might must per via yet ' +
  'der die das und ist nicht ein eine mit auf für von den dem des sich auch als wie bei aus nach le la les un une des et est pas pour dans que qui sur avec el los las por para con del una que es son').split(' '));

const BOILER = /cookie|subscribe|newsletter|sign up|log in|all rights reserved|advertis|javascript|your browser|privacy policy|terms of (use|service)|click here|read more|share this|follow us/i;

/** Main article text as paragraphs. */
export function articleText(html) {
  html = String(html || '').slice(0, 1_500_000);
  // 1. JSON-LD articleBody (most news sites provide it).
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    const body = /"articleBody"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(m[1]);
    if (body) {
      let raw = '';
      try { raw = JSON.parse(`"${body[1]}"`); } catch { continue; }
      const paras = raw.split(/\n+/).map(squash).filter((t) => t.length >= 40);
      if (paras.join(' ').split(' ').length > 120) return paras;
    }
  }
  // 2. Paragraphs inside the largest <article>, else <main>, else <body>.
  let scope = html.replace(/<(script|style|noscript|svg|template|iframe|form|nav|header|footer|aside|figure|button|select)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  const arts = [...scope.matchAll(/<article\b[\s\S]*?<\/article>/gi)].map((m) => m[0]).sort((a, b) => b.length - a.length);
  const main = /<main\b[\s\S]*?<\/main>/i.exec(scope);
  if (arts.length && arts[0].length > 2000) scope = arts[0]; else if (main) scope = main[0];
  const out = [];
  for (const m of scope.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    const t = squash(m[1]);
    if (t.length >= 60 && !BOILER.test(t) && /[.!?\u3002\uff01\uff1f"\u201d)]$/.test(t)) out.push(t);
  }
  return out;
}

export function sentences(paras) {
  const out = [];
  for (const p of paras) {
    for (const s of p.split(/(?<=[.!?\u3002\uff01\uff1f]["\u201d\u2019)]?)\s+(?=["\u201c\u2018(]?[\p{Lu}\p{N}])/u)) {
      const t = s.trim();
      const t2 = t.replace(/^\d+\s+(?=\p{Lu})/u, '');
      if (t2.length >= 40 && t2.length <= 360) out.push(t2);
    }
  }
  return out;
}

const words = (s) => (s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).filter((w) => !STOP.has(w));

/**
 * Summarise an HTML page. Returns { tldr: string[], words, minutes } or null
 * when there is not enough article text (then the preview shows its description).
 */
export function summarize(html, title = '') {
  const paras = articleText(html);
  const text = paras.join(' ');
  const total = (text.match(/\S+/g) || []).length;
  if (total < 120) return null;
  const sents = sentences(paras).slice(0, 400);
  if (sents.length < 3) return null;
  const freq = new Map();
  for (const s of sents) for (const w of new Set(words(s))) freq.set(w, (freq.get(w) || 0) + 1);
  const maxF = Math.max(1, ...freq.values());
  const tw = new Set(words(title));
  const scored = sents.map((s, i) => {
    const ws = words(s);
    if (ws.length < 5) return { s, i, v: -1, ws };
    let v = 0;
    for (const w of ws) v += (freq.get(w) || 0) / maxF;
    v /= Math.sqrt(ws.length);
    v += ws.filter((w) => tw.has(w)).length * 0.15;
    if (i === 0) v += 0.6; else if (i < 3) v += 0.3; else if (i < 8) v += 0.1; // news ledes lead
    if (/^(but|and|so|however|this|that|these|it|he|she|they)\b/i.test(s)) v -= 0.25; // dangling references read badly alone
    if (/\?$/.test(s)) v -= 0.2;
    return { s, i, v, ws };
  }).sort((a, b) => b.v - a.v);
  const k = total > 900 ? 4 : 3, pick = [];
  for (const c of scored) {
    if (c.v < 0 || pick.length >= k) break;
    const set = new Set(c.ws);
    if (pick.some((p) => { const o = p.ws.filter((w) => set.has(w)).length; return o / Math.min(p.ws.length, set.size) > 0.6; })) continue;
    pick.push(c);
  }
  if (pick.length < 2) return null;
  let budget = 900;
  const tldr = pick.sort((a, b) => a.i - b.i).map((c) => c.s).filter((s) => (budget -= s.length) >= 0);
  return { tldr, words: total, minutes: Math.max(1, Math.round(total / 230)) };
}
