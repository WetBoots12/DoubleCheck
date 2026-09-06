// What a page says about itself: who wrote it, what it is called, and who published
// it. Read from the HTML we already fetch for the page's text, so a citation can be
// built from the publisher's own declaration rather than from a search result's
// truncated title and a bare domain.
//
// The governing rule is that a wrong author is worse than no author. Every candidate
// has to survive a set of rejections before it is believed, and when nothing
// survives the caller is told the field is missing rather than handed a guess. That
// is the same principle as the classifier's explanations: no model means no
// explanation, never an invented one. shared/citation.js knows how to cite an
// unauthored page in all four styles, so an empty answer is a correct one.
//
// Every pattern here is bounded. An unbounded [^>]+ between a tag and its attribute
// made the date patterns quadratic on a page full of unclosed tags, which is a
// service worker frozen for minutes on HTML a stranger chose. See shared/dates.js.
//
// Pure: no DOM, no network, no chrome.*.

import { decodeEntities } from './extract.js';
import { publishedDateFromHtml } from './dates.js';

// A publisher declares all of this in the head. The bound keeps the cost flat no
// matter how large a page a search result points at.
const SEARCH_CHARS = 200000;

// The gap between a tag name and the attribute being looked for. Three hundred is
// about four times the longest real one.
const ATTR = '[^>]{0,300}';

function tidy(text) {
  return decodeEntities(String(text || '')).replace(/\s+/g, ' ').trim();
}

function escapeForPattern(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A meta tag's content, whichever order the page wrote its attributes in.
function metaValue(html, key, attr = 'name') {
  const k = escapeForPattern(key);
  const forward = new RegExp(`<meta${ATTR}${attr}=["']${k}["']${ATTR}content=["']([^"']{1,300})["']`, 'i');
  const backward = new RegExp(`<meta${ATTR}content=["']([^"']{1,300})["']${ATTR}${attr}=["']${k}["']`, 'i');
  const m = html.match(forward) || html.match(backward);
  return m ? tidy(m[1]) : '';
}

// --- rejecting a candidate before believing it -----------------------------------

// Values a content-management system leaves behind when nobody set a real byline.
const PLACEHOLDERS = new Set([
  'admin', 'administrator', 'editor', 'editors', 'staff', 'user', 'users', 'guest',
  'author', 'authors', 'wordpress', 'wp-admin', 'root', 'test', 'unknown', 'none',
  'null', 'undefined', 'n/a', 'na', 'anonymous', 'webmaster', 'default',
]);

// Returns the name to use, or '' if it should not be believed.
//
// The "by" strip requires whitespace after it, so Byron and Byrne keep their names.
export function plausibleAuthor(value) {
  let n = tidy(value).replace(/^(?:written\s+)?by[:\s]\s*/i, '').trim();
  n = n.replace(/^[-–—,\s]+/, '').replace(/[-–—,\s]+$/, '');
  if (!n) return '';

  if (n.length > 80) return '';                       // a sentence, not a byline
  if (/^https?:\/\//i.test(n) || n.startsWith('//') || /^www\./i.test(n)) return '';
  if (/\S+@\S+\.[a-z]{2,}/i.test(n)) return '';       // an address, not a person
  if (!/[a-z]/i.test(n)) return '';                   // no letters at all
  if (PLACEHOLDERS.has(n.toLowerCase())) return '';
  return n;
}

// --- JSON-LD ----------------------------------------------------------------------
//
// The most trustworthy of the lot, because it is structured, explicit, and says
// whether an author is a person or an organisation. That last part matters: it is
// what stops "BBC News" being inverted to "News, BBC" in a citation.

const ARTICLE_TYPES = new Set([
  'article', 'newsarticle', 'blogposting', 'report', 'scholarlyarticle', 'techarticle',
  'opinionnewsarticle', 'reportagenewsarticle', 'analysisnewsarticle',
  'backgroundnewsarticle', 'reviewnewsarticle', 'liveblogposting', 'webpage',
]);

const MAX_BLOCKS = 20;
const MAX_NODES = 300;
const MAX_DEPTH = 6;

function jsonLdBlocks(html) {
  const out = [];
  // The lazy quantifier is bounded, so a page with an unclosed script tag cannot
  // make this scan the document repeatedly.
  const re = /<script[^>]{0,300}type=["']application\/ld\+json["'][^>]{0,300}>([\s\S]{1,200000}?)<\/script>/gi;
  let m;
  while (out.length < MAX_BLOCKS && (m = re.exec(html)) !== null) {
    try {
      out.push(JSON.parse(m[1]));
    } catch {
      // A malformed block is skipped; several pages ship one alongside good ones.
    }
  }
  return out;
}

// Every object in the structure, flattened. @graph is the common wrapper, but real
// pages nest articles inside pages inside lists, so this walks values generally,
// with a depth and a count bound so a hostile document cannot make it expensive.
function flattenNodes(value, depth, acc) {
  if (acc.length >= MAX_NODES || depth > MAX_DEPTH || !value || typeof value !== 'object') return acc;
  if (Array.isArray(value)) {
    for (const v of value) flattenNodes(v, depth + 1, acc);
    return acc;
  }
  acc.push(value);
  for (const v of Object.values(value)) {
    if (v && typeof v === 'object') flattenNodes(v, depth + 1, acc);
  }
  return acc;
}

function typesOf(node) {
  const t = node['@type'];
  return (Array.isArray(t) ? t : [t]).filter(Boolean).map((x) => String(x).toLowerCase());
}

// author can be a string, an object, or a list of either.
function namesFrom(value) {
  const out = [];
  for (const entry of Array.isArray(value) ? value : [value]) {
    if (!entry) continue;
    if (typeof entry === 'string') {
      const name = plausibleAuthor(entry);
      if (name) out.push({ name });
      continue;
    }
    if (typeof entry !== 'object') continue;
    const name = plausibleAuthor(entry.name);
    if (!name) continue;
    // The page said which it is, so nothing has to be guessed from the words.
    const organisation = typesOf(entry).includes('organization');
    out.push(organisation ? { name, organisation: true } : { name });
  }
  return out;
}

function fromJsonLd(html) {
  const nodes = [];
  for (const block of jsonLdBlocks(html)) flattenNodes(block, 0, nodes);

  const articles = nodes.filter((n) => typesOf(n).some((t) => ARTICLE_TYPES.has(t)));
  const ordered = [...articles, ...nodes]; // an article node first, anything else after

  const found = { authors: [], title: '', siteName: '' };
  for (const node of ordered) {
    if (!found.authors.length) {
      const names = namesFrom(node.author || node.creator);
      if (names.length) found.authors = names;
    }
    if (!found.title) found.title = tidy(node.headline || '');
    if (!found.siteName) {
      const p = node.publisher;
      if (p && typeof p === 'object') found.siteName = tidy(p.name || '');
      else if (typeof p === 'string') found.siteName = tidy(p);
    }
    if (found.authors.length && found.title && found.siteName) break;
  }
  return found;
}

// --- the meta tags ------------------------------------------------------------------
//
// In the order they deserve to be trusted. article:author is last and conditional
// because its value is very often a profile URL rather than a name, which
// plausibleAuthor rejects.

function authorFromMeta(html) {
  const candidates = [
    metaValue(html, 'author'),
    metaValue(html, 'byl'),              // the New York Times
    metaValue(html, 'dc.creator'),
    metaValue(html, 'DC.creator'),
    metaValue(html, 'citation_author'),  // journals and repositories
    metaValue(html, 'parsely-author'),
    metaValue(html, 'article:author', 'property'),
  ];
  for (const c of candidates) {
    // A page may list several in one tag. Not split on a semicolon: a named entity
    // the decoder does not know ends in one, and cutting there turns Jose Garcia
    // into three authors, one of them called "a". Semicolon-separated bylines are
    // rare; mangled names would not be.
    const parts = String(c).split(/\s*(?:,| and | & )\s*/i).filter(Boolean);
    const names = parts.map(plausibleAuthor).filter(Boolean);
    if (names.length) return names.map((name) => ({ name }));
  }
  return [];
}

const TITLE_TAG = /<title[^>]{0,200}>([\s\S]{1,500}?)<\/title>/i;

// "Headline | The Guardian" is a headline and a site name stuck together. Once the
// site name is known, the tail it forms can come off.
function stripSiteTail(title, siteName) {
  if (!title || !siteName) return title;
  const site = escapeForPattern(siteName);
  const re = new RegExp(`\\s*[|\\u2013\\u2014\\u00b7:-]\\s*${site}\\s*$`, 'i');
  const stripped = title.replace(re, '').trim();
  return stripped || title;
}

// --- the one entry point --------------------------------------------------------------

// Returns { authors, title, siteName, date }, each empty when the page did not say.
// authors are { name, organisation? } so a citation never has to guess which it is.
export function metadataFromHtml(html) {
  const text = String(html || '').slice(0, SEARCH_CHARS);
  const empty = { authors: [], title: '', siteName: '', date: '' };
  if (!text) return empty;

  const ld = fromJsonLd(text);

  const authors = ld.authors.length ? ld.authors : authorFromMeta(text);

  const siteName = ld.siteName
    || metaValue(text, 'og:site_name', 'property')
    || metaValue(text, 'application-name')
    || '';

  const titleTag = TITLE_TAG.exec(text);
  const rawTitle = metaValue(text, 'og:title', 'property')
    || ld.title
    || (titleTag ? tidy(titleTag[1].replace(/<[^>]{0,300}>/g, ' ')) : '');

  return {
    authors,
    title: stripSiteTail(rawTitle, siteName),
    siteName,
    // Already solved, and its patterns are already bounded for the same reason.
    date: publishedDateFromHtml(text),
  };
}
