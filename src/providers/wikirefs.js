// The sources a Wikipedia article is built on, rather than the article itself.
//
// Wikipedia is the keyless default, and on its own it answers the wrong question. A
// reader checking "inflation reached 8.2 percent in June" was handed the article
// called Inflation: true, encyclopedic, and no help at all in deciding whether that
// figure is right. What would help is the thing the article cites for it, which is
// usually a statistics office or a newspaper.
//
// Those citations are in the wikitext, inline, immediately after the sentence they
// support. So finding the passage that matches the claim and taking the references
// inside it gives the sources for that claim specifically, not a bag of everything
// the article ever cited. On the Inflation article that is a choice among 172.
//
// Most references are {{cite web}}, {{cite news}}, {{cite journal}} or {{cite book}}
// templates, which carry a title, an address, a publisher, a date and often the
// authors: a complete citation, better than anything that could be scraped from the
// source page itself.
//
// Pure: no DOM, no network, no chrome.*. The provider does the fetching.

import { relevance } from '../shared/evidence.js';

const MAX_WIKITEXT = 400000;
const MAX_REFS = 400;
const TOP_PASSAGES = 6;

function tidy(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

// --- reading a template --------------------------------------------------------------

// Wikitext nests: a parameter's value can hold [[a link]] or another {{template}},
// and splitting naively on the pipe cuts those in half. This walks the string and
// only splits at the top level.
function splitParams(body) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < body.length; i++) {
    const two = body.slice(i, i + 2);
    if (two === '{{' || two === '[[') { depth++; current += two; i++; continue; }
    if (two === '}}' || two === ']]') { depth--; current += two; i++; continue; }
    if (body[i] === '|' && depth <= 0) { parts.push(current); current = ''; continue; }
    current += body[i];
  }
  parts.push(current);
  return parts;
}

// [[Office for National Statistics|the ONS]] -> the ONS; ''italics'' -> italics.
function plainValue(text) {
  return tidy(String(text || '')
    .replace(/\[\[([^\]|]{0,200})\|([^\]]{0,200})\]\]/g, '$2')
    .replace(/\[\[([^\]]{0,200})\]\]/g, '$1')
    .replace(/'{2,5}/g, '')
    .replace(/<[^>]{0,200}>/g, ' '));
}

// The first {{cite ...}} in a reference, as a map of its parameters.
export function citeTemplate(ref) {
  const at = ref.search(/\{\{\s*[Cc]ite[\s_]/);
  if (at === -1) return null;

  let depth = 0;
  let end = -1;
  for (let i = at; i < ref.length && i < at + 6000; i++) {
    if (ref.slice(i, i + 2) === '{{') { depth++; i++; continue; }
    if (ref.slice(i, i + 2) === '}}') { depth--; i++; if (depth === 0) { end = i + 1; break; } }
  }
  if (end === -1) return null;

  const parts = splitParams(ref.slice(at + 2, end - 2));
  const kind = tidy(parts.shift()).replace(/^cite[\s_]+/i, '').toLowerCase();
  const params = { kind };
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = tidy(part.slice(0, eq)).toLowerCase();
    if (key) params[key] = plainValue(part.slice(eq + 1));
  }
  return params;
}

// Authors, however the template chose to say it: author, author1..n, or last/first
// pairs. Returned as plain names, which is what a citation wants.
function authorsFrom(params) {
  const out = [];
  if (params.author) out.push(params.author);
  for (let i = 1; i <= 8; i++) {
    if (params[`author${i}`]) out.push(params[`author${i}`]);
    else if (params[`last${i}`]) {
      out.push(params[`first${i}`] ? `${params[`first${i}`]} ${params[`last${i}`]}` : params[`last${i}`]);
    }
  }
  if (!out.length && params.last) {
    out.push(params.first ? `${params.first} ${params.last}` : params.last);
  }
  return out.filter(Boolean).slice(0, 8);
}

const ARTICLE_KINDS = new Set(['journal', 'conference', 'thesis']);

// A reference turned into the shape the rest of the extension already understands.
export function refToSource(ref) {
  const params = citeTemplate(ref);

  if (params) {
    const url = tidy(params.url || (params.doi ? `https://doi.org/${params.doi.replace(/^doi:/i, '')}` : ''));
    const title = plainValue(params.title || params.chapter || '');
    if (!title && !url) return null;
    return {
      title: title || url,
      url,
      doi: params.doi ? `https://doi.org/${params.doi.replace(/^doi:/i, '')}` : '',
      kind: ARTICLE_KINDS.has(params.kind) ? 'article' : 'web',
      siteName: plainValue(params.work || params.website || params.newspaper || params.publisher || params.journal || ''),
      venue: plainValue(params.journal || ''),
      authors: authorsFrom(params),
      date: tidy(params.date || params.year || ''),
    };
  }

  // Not a template: a bare external link, which is how older references were written.
  const link = /\[(https?:\/\/[^\s\]]{1,500})\s{0,4}([^\]]{0,300})\]/.exec(ref);
  if (link) return { title: plainValue(link[2]) || link[1], url: link[1], kind: 'web', authors: [] };

  const bare = /(https?:\/\/[^\s<|\]}]{1,500})/.exec(ref);
  if (bare) return { title: bare[1], url: bare[1], kind: 'web', authors: [] };

  return null;
}

// --- finding the passage the claim is about ---------------------------------------------

const REF_BLOCK = /<ref[^>]{0,300}>[\s\S]{1,6000}?<\/ref>|<ref[^>]{0,300}\/>/gi;

// Everything except the references, so a passage can be scored on what it says.
function passageText(chunk) {
  return plainValue(chunk
    .replace(REF_BLOCK, ' ')
    .replace(/\{\{[^{}]{0,2000}\}\}/g, ' ')
    .replace(/^[=*#:;]+/gm, ' '));
}

// The article, split into the passages a reader would call paragraphs, each carrying
// the references that sit inside it.
export function passages(wikitext) {
  const text = String(wikitext || '').slice(0, MAX_WIKITEXT);
  const out = [];
  for (const chunk of text.split(/\n\s*\n/)) {
    if (chunk.length < 40) continue;
    const refs = chunk.match(REF_BLOCK) || [];
    if (!refs.length) continue;
    out.push({ text: passageText(chunk), refs: refs.slice(0, 40) });
    if (out.length >= 400) break;
  }
  return out;
}

// The sources an article cites for the passages that actually bear on the claim.
//
// Ordered by how well the passage matches, then deduplicated by address, so the
// first few are the ones the article offers for this particular sentence rather
// than for the topic in general.
//
// avoid holds the addresses already shown under other claims on the same page. Two
// flags about one conflict find one article, and the article offers the same few
// references for both, so the panel showed the same sources twice. A source that
// is already on the page gives way to the next one that bears on the claim, and
// is shown again only when nothing else does: a repeat is still worth more than a
// blank.
export function refsForClaim(claim, wikitext, { limit = 6, article = '', avoid = [] } = {}) {
  const candidates = [];
  const shown = new Set(avoid);
  let parsed = 0;

  for (const passage of passages(wikitext)) {
    const context = relevance(claim, passage.text);
    for (const ref of passage.refs) {
      if (parsed++ > MAX_REFS) break;
      const source = refToSource(ref);
      if (!source) continue;

      // Both halves matter, and they fail in different ways. The passage says what
      // the article was talking about when it cited this, which is the only thing
      // that ties a reference to a sentence. The reference's own title and publisher
      // say what it is about, which is what rescues a specific claim from a general
      // article: on the Inflation page, scoring the passage alone answered a question
      // about a UK figure with a textbook chapter on how inflation is measured.
      //
      // The title is weighted higher because it is the more direct evidence, and a
      // long passage dilutes any single sentence in it.
      const own = relevance(claim, `${source.title} ${source.siteName || ''}`);
      const score = context + 1.8 * own;
      if (score <= 0) continue;

      candidates.push({ source, passage, score, hasUrl: Boolean(source.url) });
    }
  }

  candidates.sort((a, b) => (b.score - a.score) || (Number(b.hasUrl) - Number(a.hasUrl)));

  // Best first, but anything already on the page after everything that is not.
  const fresh = candidates.filter((c) => !shown.has(c.source.url));
  const repeats = candidates.filter((c) => shown.has(c.source.url));

  const seen = new Set();
  const out = [];
  for (const { source, passage } of [...fresh, ...repeats]) {
    const key = source.url || source.title.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);

    out.push({
      ...source,
      source: source.siteName || hostOf(source.url) || 'cited by Wikipedia',
      // Where it came from and what it was cited for. This is the context a reader
      // needs to judge whether the source bears on their sentence at all.
      snippet: [
        article ? `Cited by Wikipedia's article on ${article}` : 'Cited by Wikipedia',
        trim(passage.text, 200),
      ].filter(Boolean).join(', for: '),
      fromWikipedia: true,
    });
    if (out.length >= limit) break;
  }
  return out;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function trim(text, max) {
  const t = tidy(text);
  return t.length <= max ? t : `${t.slice(0, max).replace(/\s+\S*$/, '')}…`;
}
