// Pulling readable paragraphs out of a fetched page.
//
// Why: a search result's snippet is 120 to 160 characters, usually cut mid-sentence
// and often stuffed with the site's own boilerplate. The number or the date that
// would settle a claim is frequently on the page but not in the snippet, and the
// evidence score and the model then both report "unclear" about a source that in
// fact says something definite.
//
// This runs in the service worker, which has no DOM: no DOMParser, no innerText.
// So the parsing is deliberately crude text work rather than a pretend DOM. It only
// has to be good enough to recover paragraphs, and anything it gets wrong falls
// back to the snippet that was already there.
//
// Nothing here fetches. The caller does that, so this stays pure and testable.

// Regions that are never the article. Removed with their contents.
const CHROME_TAGS = /<(script|style|noscript|svg|template|iframe|form|nav|header|footer|aside|figure|figcaption|button|select)\b[^>]*>[\s\S]*?<\/\1>/gi;
const SELF_CLOSING_CHROME = /<(script|style|noscript|svg|template|iframe)\b[^>]*\/>/gi;
const COMMENTS = /<!--[\s\S]*?-->/g;

// A paragraph, or a list item, which is where many outlets put the numbers.
const BLOCK = /<(p|li|h[1-4])\b[^>]*>([\s\S]*?)<\/\1>/gi;

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–',
  mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  hellip: '…', deg: '°', pound: '£', euro: '€', middot: '·',
};

export function decodeEntities(text) {
  return String(text || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    const named = ENTITIES[body.toLowerCase()];
    return named === undefined ? whole : named;
  });
}

// Lines that are furniture on every news site. Deliberately short: the point is to
// avoid feeding a model a cookie notice as evidence, not to be a content classifier.
const FURNITURE = /^(sign up|subscribe|share this|advertisement|related|read more|follow us|by |photo|image|getty|reuters\/|copyright|all rights reserved|cookie|we use cookies|accept all|your privacy)/i;

export function extractParagraphs(html, opts = {}) {
  const minChars = opts.minChars ?? 80;
  const limit = opts.limit ?? 60;

  const body = String(html || '')
    .replace(COMMENTS, ' ')
    .replace(SELF_CLOSING_CHROME, ' ')
    .replace(CHROME_TAGS, ' ');

  const out = [];
  const seen = new Set();
  let m;
  BLOCK.lastIndex = 0;
  while ((m = BLOCK.exec(body)) !== null) {
    const text = decodeEntities(m[2].replace(/<[^>]*>/g, ' '))
      .replace(/\s+/g, ' ')
      .trim();
    if (text.length < minChars) continue;
    if (FURNITURE.test(text)) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue; // the same line often appears twice in a template
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

const STOPWORDS = new Set(('a an the and or but if then than that this these those of in on at to for with '
  + 'from by as is are was were be been being it its he she they we you i his her their our your not '
  + 'no do does did has have had will would could should may might can said says according also more most')
  .split(' '));

export function keywords(text) {
  return new Set((String(text || '').toLowerCase().match(/[a-z0-9]+(?:[.'-][a-z0-9]+)*/g) || [])
    .filter((w) => (/\d/.test(w) || w.length > 2) && !STOPWORDS.has(w)));
}

// Which paragraphs actually bear on the claim. Numbers count double, for the same
// reason they do in the evidence score: a factual claim usually turns on one.
export function scoreParagraph(claimWords, paragraph) {
  if (!claimWords.size) return 0;
  const have = keywords(paragraph);
  let total = 0;
  let hit = 0;
  for (const w of claimWords) {
    const weight = /\d/.test(w) ? 2 : 1;
    total += weight;
    if (have.has(w)) hit += weight;
  }
  return total ? hit / total : 0;
}

// The excerpt handed to the evidence score and the model: the few paragraphs of a
// page that mention what the claim is about, in the order they appear, capped so a
// long article cannot dominate a prompt. Returns '' when nothing is relevant, and
// the caller then keeps the snippet it already had.
export function relevantExcerpt(claim, paragraphs, opts = {}) {
  const max = opts.max ?? 3;
  const maxChars = opts.maxChars ?? 1200;
  const minScore = opts.minScore ?? 0.15;

  const claimWords = keywords(claim);
  const scored = paragraphs
    .map((text, index) => ({ text, index, score: scoreParagraph(claimWords, text) }))
    .filter((p) => p.score >= minScore)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, max)
    .sort((a, b) => a.index - b.index);

  let out = '';
  for (const p of scored) {
    const next = out ? `${out} … ${p.text}` : p.text;
    if (next.length > maxChars) {
      if (!out) out = p.text.slice(0, maxChars);
      break;
    }
    out = next;
  }
  return out;
}
