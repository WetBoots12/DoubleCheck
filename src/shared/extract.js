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

// Bounded tag tokens and a forward-only scan avoid retrying an unclosed region
// from every opening tag. Malformed source HTML must not monopolize the worker.
const OMIT_TAGS = new Set('script style noscript svg template iframe form nav header footer aside figure figcaption button select'.split(' '));
const PARAGRAPH_TAGS = new Set(['p', 'li', 'h1', 'h2', 'h3', 'h4']);
const MAX_HTML_CHARS = 400000;

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–',
  mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  hellip: '…', deg: '°', pound: '£', euro: '€', middot: '·',

  // Accented letters, because the names of the people who write things have them.
  // An undecoded &eacute; is not merely ugly: it ends in a semicolon, and anything
  // downstream that treats a semicolon as a separator will cut a name in half. That
  // is a citation with an author called "Jos" in it.
  aacute: 'á', agrave: 'à', acirc: 'â', atilde: 'ã', auml: 'ä', aring: 'å', aelig: 'æ',
  ccedil: 'ç', eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë',
  iacute: 'í', igrave: 'ì', icirc: 'î', iuml: 'ï', ntilde: 'ñ',
  oacute: 'ó', ograve: 'ò', ocirc: 'ô', otilde: 'õ', ouml: 'ö', oslash: 'ø',
  uacute: 'ú', ugrave: 'ù', ucirc: 'û', uuml: 'ü', yacute: 'ý', yuml: 'ÿ',
  szlig: 'ß', ccaron: 'č', scaron: 'š', zcaron: 'ž',
  Aacute: 'Á', Agrave: 'À', Acirc: 'Â', Atilde: 'Ã', Auml: 'Ä', Aring: 'Å', AElig: 'Æ',
  Ccedil: 'Ç', Eacute: 'É', Egrave: 'È', Ecirc: 'Ê', Euml: 'Ë',
  Iacute: 'Í', Igrave: 'Ì', Icirc: 'Î', Iuml: 'Ï', Ntilde: 'Ñ',
  Oacute: 'Ó', Ograve: 'Ò', Ocirc: 'Ô', Otilde: 'Õ', Ouml: 'Ö', Oslash: 'Ø',
  Uacute: 'Ú', Ugrave: 'Ù', Ucirc: 'Û', Uuml: 'Ü', Yacute: 'Ý',
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
    // Case matters for the accented names: &Aring; is A-ring and &aring; is a-ring,
    // so the exact spelling is tried first. The lowercase fallback is for the ones
    // where case carries no meaning, which pages write every way imaginable
    // (&AMP;, &Nbsp;).
    const named = ENTITIES[body] ?? ENTITIES[body.toLowerCase()];
    return named === undefined ? whole : named;
  });
}

// Lines that are furniture on every news site. Deliberately short: the point is to
// avoid feeding a model a cookie notice as evidence, not to be a content classifier.
const FURNITURE = /^(sign up|subscribe|share this|advertisement|related|read more|follow us|by |photo|image|getty|reuters\/|copyright|all rights reserved|cookie|we use cookies|accept all|your privacy)/i;

export function extractParagraphs(html, opts = {}) {
  const minChars = opts.minChars ?? 80;
  const limit = opts.limit ?? 60;

  const body = String(html || '').slice(0, MAX_HTML_CHARS);
  const out = [];
  const seen = new Set();
  const tags = /<!--|<\/?([a-z][a-z0-9]*)\b[^<>]{0,4096}>/gi;
  let blocked = null;
  let depth = 0;
  let paragraph = null;
  let chunks = [];
  let cursor = 0;
  let m;
  while ((m = tags.exec(body)) !== null) {
    if (paragraph && !blocked) chunks.push(body.slice(cursor, m.index));
    if (m[0] === '<!--') {
      const end = body.indexOf('-->', tags.lastIndex);
      tags.lastIndex = end < 0 ? body.length : end + 3;
      cursor = tags.lastIndex;
      continue;
    }
    cursor = tags.lastIndex;
    const tag = m[1].toLowerCase();
    const closing = m[0][1] === '/';
    const selfClosing = /\/\s*>$/.test(m[0]);
    if (blocked) {
      if (tag === blocked) {
        if (closing) { if (--depth === 0) blocked = null; }
        else if (!selfClosing) depth++;
      }
      continue;
    }
    if (OMIT_TAGS.has(tag)) {
      if (!closing && !selfClosing) { blocked = tag; depth = 1; }
      continue;
    }
    if (PARAGRAPH_TAGS.has(tag)) {
      if (!closing) { paragraph = tag; chunks = []; }
      else if (paragraph === tag) {
        // A tag the bounded token pattern skipped (one over 4 KB, such as an inline
        // data URI) is still markup. [^<>]* stops at the next bracket, so this is linear.
        const text = decodeEntities(chunks.join(' ').replace(/<[^<>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
        const key = text.toLowerCase();
        if (text.length >= minChars && !FURNITURE.test(text) && !seen.has(key)) {
          seen.add(key);
          out.push(text);
        }
        paragraph = null;
        chunks = [];
        if (out.length >= limit) break;
      }
    }
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
