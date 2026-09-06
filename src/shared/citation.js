// Citations, in the four styles a reader is most likely to be asked for.
//
// What this is: a draft citation good enough to paste into a works cited page and
// then check. It is not a citation authority. Style manuals disagree with
// themselves at the edges, real bylines are messier than any rule, and deciding
// which word of a name is the surname cannot be done reliably by a program. Where
// this has to guess, it guesses conservatively and says so rather than inventing.
//
// Everything here is pure: no DOM, no network, no chrome.*, so every rule is
// unit-tested against the shape a real source actually arrives in.
//
// A citation is built as segments rather than a string, because MLA, APA, Chicago
// and Harvard all italicise something and plain text cannot. toPlainText flattens
// them for the clipboard; an RTF or HTML writer can use the same segments and keep
// the italics. See toPlainText below.

export const FORMATS = [
  { id: 'mla', label: 'MLA 9' },
  { id: 'apa', label: 'APA 7' },
  { id: 'chicago', label: 'Chicago 17' },
  { id: 'harvard', label: 'Harvard' },
];

export const DEFAULT_FORMAT = 'mla';

export function isFormat(id) {
  return FORMATS.some((f) => f.id === id);
}

// --- names ---------------------------------------------------------------------

// Words that belong to the surname rather than to the given names. Without these,
// "Ludwig van Beethoven" inverts to "Beethoven, Ludwig van" instead of the correct
// "van Beethoven, Ludwig" in some styles; more importantly they stop the surname
// being taken as the bare last word.
const PARTICLES = new Set([
  'de', 'del', 'della', 'der', 'den', 'di', 'da', 'dos', 'das', 'du',
  'la', 'le', 'van', 'von', 'ter', 'ten', 'bin', 'ibn', 'al', 'af', 'av',
]);

const SUFFIXES = new Set(['jr', 'jr.', 'sr', 'sr.', 'ii', 'iii', 'iv', 'phd', 'ph.d.', 'md', 'm.d.']);

// A name that is an organisation is never inverted: "BBC News" must not become
// "News, BBC". Callers that know the answer say so; this is the fallback for the
// ones that do not, and it is deliberately cautious.
const ORG_WORDS = /\b(news|press|agency|associated|reuters|bbc|cnn|npr|staff|editors?|team|desk|newsroom|bureau|institute|university|college|department|ministry|office|council|commission|foundation|society|association|centre|center|corporation|company|inc|ltd|llc|plc|gmbh)\b/i;

export function looksLikeOrganisation(name) {
  const n = String(name || '').trim();
  if (!n) return false;
  if (!/\s/.test(n)) return true;      // a single word is not a person's full name
  if (ORG_WORDS.test(n)) return true;
  if (n.split(/\s+/).length > 4) return true; // longer than any ordinary byline
  return false;
}

// "Jane Doe" -> { surname: 'Doe', given: 'Jane' }. Organisations come back whole.
//
// Accepts either a plain string or { name, organisation }. A page that declares in
// its JSON-LD that the author is an Organization has told us something the words
// alone cannot: "Marshall Project" and "Marshall Kane" look identical to a guess.
// Where the page said, the guess is not consulted. See shared/metadata.js.
export function splitName(name) {
  const declared = name && typeof name === 'object' ? name : null;
  const raw = String(declared ? declared.name : (name || '')).replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  if (declared && declared.organisation) return { organisation: raw };
  if (declared && declared.organisation === false) {
    // Declared a person, so an organisational-looking name is still inverted.
    const parts = raw.split(' ');
    if (parts.length > 1) {
      let j = parts.length - 1;
      while (j > 1 && PARTICLES.has(parts[j - 1].toLowerCase())) j--;
      return { surname: parts.slice(j).join(' '), given: parts.slice(0, j).join(' ') };
    }
  }
  if (looksLikeOrganisation(raw)) return { organisation: raw };

  // Already inverted by the source: "Doe, Jane".
  if (raw.includes(',')) {
    const [surname, ...rest] = raw.split(',');
    const given = rest.join(',').trim();
    if (surname.trim() && given) return { surname: surname.trim(), given };
  }

  const parts = raw.split(' ');
  const suffix = SUFFIXES.has(parts[parts.length - 1].toLowerCase()) ? parts.pop() : '';
  if (parts.length === 1) return { organisation: raw };

  // Walk back over any particles so they stay with the surname.
  let i = parts.length - 1;
  while (i > 1 && PARTICLES.has(parts[i - 1].toLowerCase())) i--;

  return {
    surname: parts.slice(i).join(' ') + (suffix ? `, ${suffix}` : ''),
    given: parts.slice(0, i).join(' '),
  };
}

function initials(given) {
  return String(given || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => `${w[0].toUpperCase()}.`)
    .join(' ');
}

// Surname first, as MLA, Chicago and Harvard want the leading author.
function inverted(name, style) {
  const n = splitName(name);
  if (!n) return '';
  if (n.organisation) return n.organisation;
  return style === 'initials' ? `${n.surname}, ${initials(n.given)}` : `${n.surname}, ${n.given}`;
}

// Given names first, as MLA and Chicago want every author after the first.
function natural(name) {
  const n = splitName(name);
  if (!n) return '';
  return n.organisation ? n.organisation : `${n.given} ${n.surname}`;
}

// --- dates ----------------------------------------------------------------------

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// MLA abbreviates every month except the short ones.
const MLA_MONTHS = ['Jan.', 'Feb.', 'Mar.', 'Apr.', 'May', 'June',
  'July', 'Aug.', 'Sept.', 'Oct.', 'Nov.', 'Dec.'];

// Accepts an ISO string, a year, or anything Date understands. Returns the parts
// rather than a formatted string, because each style wants them differently, and
// null when there is no usable date at all.
export function dateParts(value) {
  if (value == null || value === '') return null;

  const asYear = String(value).trim();
  if (/^(1[5-9]|20)\d{2}$/.test(asYear)) return { year: Number(asYear), month: null, day: null };

  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;

  // An ISO date with no time is a calendar date and must not be shifted by the
  // reader's time zone, which is what getFullYear would do west of Greenwich.
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  if (iso) return { year: Number(iso[1]), month: Number(iso[2]) - 1, day: Number(iso[3]) };

  return { year: d.getUTCFullYear(), month: d.getUTCMonth(), day: d.getUTCDate() };
}

// --- the source record ------------------------------------------------------------
//
// { kind: 'web' | 'article' | 'factcheck', title, url, siteName, authors: [],
//   date, venue, volume, issue, pages, doi, publisher, accessed }
//
// Every field is optional. A citation is built from what is there, and a style's
// rule for a missing piece is followed rather than a placeholder being invented.

function tidy(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

// MLA 9 drops the scheme from a URL; the others keep it.
function bareUrl(url) {
  return tidy(url).replace(/^https?:\/\//, '');
}

// A trailing full stop, unless the text already ends in one or in another mark that
// closes a sentence. Stops "Ltd.." and "?." appearing at the end of an entry.
function stop(text) {
  const t = tidy(text);
  if (!t) return '';
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

const seg = (text, italic = false) => ({ text, italic });

export function toPlainText(segments) {
  return segments.map((s) => s.text).join('').replace(/\s+/g, ' ').trim();
}

// --- author lists per style -------------------------------------------------------

// An author is a string or { name, organisation }; keep whichever it is, because
// splitName reads the declaration when there is one.
function usableNames(authors) {
  return (authors || [])
    .map((a) => (a && typeof a === 'object' ? (tidy(a.name) ? a : null) : tidy(a)))
    .filter(Boolean);
}

function mlaAuthors(authors) {
  const names = usableNames(authors);
  if (!names.length) return '';
  if (names.length === 1) return stop(inverted(names[0]));
  if (names.length === 2) return stop(`${inverted(names[0])}, and ${natural(names[1])}`);
  return stop(`${inverted(names[0])}, et al`);
}

function apaAuthors(authors) {
  const names = usableNames(authors);
  if (!names.length) return '';
  const listed = names.slice(0, 20).map((n) => inverted(n, 'initials'));
  if (listed.length === 1) return stop(listed[0]);
  return stop(`${listed.slice(0, -1).join(', ')}, & ${listed[listed.length - 1]}`);
}

function chicagoAuthors(authors) {
  const names = usableNames(authors);
  if (!names.length) return '';
  if (names.length === 1) return stop(inverted(names[0]));
  const rest = names.slice(1).map(natural);
  return stop(`${inverted(names[0])}, ${rest.slice(0, -1).concat(`and ${rest[rest.length - 1]}`).join(', ')}`);
}

function harvardAuthors(authors) {
  const names = usableNames(authors);
  if (!names.length) return '';
  const listed = names.slice(0, 3).map((n) => inverted(n, 'initials'));
  if (names.length > 3) return `${listed[0]} et al.`;
  if (listed.length === 1) return listed[0];
  return `${listed.slice(0, -1).join(', ')} and ${listed[listed.length - 1]}`;
}

// --- the four styles ----------------------------------------------------------------

function mla(s) {
  const out = [];
  const authors = mlaAuthors(s.authors);
  if (authors) out.push(seg(`${authors} `));

  // A journal article's title is quoted and its journal italicised; a whole website
  // has no container, so its own title is the italic one. This is the distinction
  // MLA calls container, and getting it wrong is the most visible error a citation
  // can make.
  if (s.title) out.push(seg(`"${stop(s.title)}" `));

  const container = s.kind === 'article' ? s.venue : s.siteName;
  if (container) out.push(seg(tidy(container), true), seg(', '));

  if (s.kind === 'article') {
    if (s.volume) out.push(seg(`vol. ${tidy(s.volume)}, `));
    if (s.issue) out.push(seg(`no. ${tidy(s.issue)}, `));
  }

  const d = dateParts(s.date);
  if (d) {
    const when = d.day != null
      ? `${d.day} ${MLA_MONTHS[d.month]} ${d.year}`
      : (d.month != null ? `${MLA_MONTHS[d.month]} ${d.year}` : String(d.year));
    out.push(seg(`${when}, `));
  }

  if (s.kind === 'article' && s.pages) out.push(seg(`pp. ${tidy(s.pages)}, `));
  // MLA 9 omits the scheme from a web address but writes a DOI in full, as
  // https://doi.org/..., so the two are not treated alike.
  if (s.doi) out.push(seg(stop(tidy(s.doi))));
  else if (s.url) out.push(seg(stop(bareUrl(s.url))));

  const a = dateParts(s.accessed);
  if (a && a.day != null) out.push(seg(` Accessed ${a.day} ${MLA_MONTHS[a.month]} ${a.year}.`));
  return out;
}

function apa(s) {
  const out = [];
  const authors = apaAuthors(s.authors);
  const d = dateParts(s.date);
  const when = d
    ? (d.day != null ? `${d.year}, ${MONTHS[d.month]} ${d.day}` : (d.month != null ? `${d.year}, ${MONTHS[d.month]}` : String(d.year)))
    : 'n.d.';

  // With no author APA moves the title into the author's place, then the date.
  if (authors) {
    out.push(seg(`${authors} (${when}). `));
  } else if (s.title) {
    // A standalone page's title is italic wherever it appears, including here in
    // the author's place; a journal article's title is not.
    if (s.kind === 'article') out.push(seg(`${stop(s.title)} (${when}). `));
    else out.push(seg(tidy(s.title), true), seg(`. (${when}). `));
  } else {
    out.push(seg(`(${when}). `));
  }

  if (authors && s.title) {
    // The article title is plain and the journal italic; a standalone web page's
    // own title is the italic one.
    if (s.kind === 'article') out.push(seg(`${stop(s.title)} `));
    else out.push(seg(tidy(s.title), true), seg('. '));
  }

  if (s.kind === 'article') {
    if (s.venue) out.push(seg(tidy(s.venue), true));
    if (s.volume) out.push(seg(', '), seg(tidy(s.volume), true));
    if (s.issue) out.push(seg(`(${tidy(s.issue)})`));
    if (s.pages) out.push(seg(`, ${tidy(s.pages)}`));
    out.push(seg('. '));
  } else if (s.siteName) {
    out.push(seg(`${stop(s.siteName)} `));
  }

  if (s.doi) out.push(seg(tidy(s.doi)));
  else if (s.url) out.push(seg(tidy(s.url)));
  return out;
}

function chicago(s) {
  const out = [];
  const authors = chicagoAuthors(s.authors);
  if (authors) out.push(seg(`${authors} `));
  if (s.title) out.push(seg(`"${stop(s.title)}" `));

  if (s.kind === 'article') {
    if (s.venue) out.push(seg(tidy(s.venue), true), seg(' '));
    if (s.volume) out.push(seg(tidy(s.volume)));
    if (s.issue) out.push(seg(`, no. ${tidy(s.issue)}`));
    const d = dateParts(s.date);
    if (d) out.push(seg(` (${d.year})`));
    out.push(seg(s.pages ? `: ${tidy(s.pages)}. ` : '. '));
  } else {
    if (s.siteName) out.push(seg(tidy(s.siteName), true), seg('. '));
    const d = dateParts(s.date);
    if (d) {
      const when = d.day != null
        ? `${MONTHS[d.month]} ${d.day}, ${d.year}`
        : (d.month != null ? `${MONTHS[d.month]} ${d.year}` : String(d.year));
      out.push(seg(`${when}. `));
    }
  }

  if (s.doi) out.push(seg(stop(tidy(s.doi))));
  else if (s.url) out.push(seg(stop(tidy(s.url))));
  return out;
}

function harvard(s) {
  const out = [];
  const authors = harvardAuthors(s.authors);
  const d = dateParts(s.date);
  const year = d ? String(d.year) : 'n.d.';

  if (authors) {
    out.push(seg(`${authors} (${year}) `));
  } else if (s.title) {
    if (s.kind === 'article') out.push(seg(`'${tidy(s.title)}' (${year}) `));
    else out.push(seg(tidy(s.title), true), seg(` (${year}) `));
  }

  if (authors && s.title) {
    if (s.kind === 'article') out.push(seg(`'${tidy(s.title)}', `));
    else out.push(seg(tidy(s.title), true), seg('. '));
  }

  if (s.kind === 'article') {
    if (s.venue) out.push(seg(tidy(s.venue), true));
    if (s.volume) out.push(seg(`, ${tidy(s.volume)}`));
    if (s.issue) out.push(seg(`(${tidy(s.issue)})`));
    if (s.pages) out.push(seg(`, pp. ${tidy(s.pages)}`));
    out.push(seg('. '));
  } else if (s.siteName) {
    out.push(seg(`${stop(s.siteName)} `));
  }

  const address = s.doi || s.url;
  if (address) out.push(seg(`Available at: ${tidy(address)}`));

  const a = dateParts(s.accessed);
  if (a && a.day != null) out.push(seg(` (Accessed: ${a.day} ${MONTHS[a.month]} ${a.year})`));
  out.push(seg('.'));
  return out;
}

const STYLES = { mla, apa, chicago, harvard };

// The one entry point. Returns segments; toPlainText flattens them.
export function citationSegments(source, format = DEFAULT_FORMAT) {
  const s = source || {};
  const style = STYLES[format] || STYLES[DEFAULT_FORMAT];
  return style(s).filter((x) => x && x.text);
}

export function formatCitation(source, format = DEFAULT_FORMAT) {
  return toPlainText(citationSegments(source, format));
}

// A works cited list: one entry per source, alphabetised the way every one of these
// styles asks for, with duplicates removed. Sorting is on the rendered entry, which
// is what a reader sees and therefore what "alphabetical" means to them.
export function worksCited(sources, format = DEFAULT_FORMAT) {
  const seen = new Set();
  const entries = [];
  for (const s of sources || []) {
    const line = formatCitation(s, format);
    const key = line.toLowerCase();
    if (!line || seen.has(key)) continue;
    seen.add(key);
    entries.push(line);
  }
  return entries.sort((a, b) => a.localeCompare(b, 'en'));
}

// What a citation could not say, so the reader can be told rather than left to
// notice. An unauthored web page is a legitimate citation in every one of these
// styles, but it is also the thing most worth going back and filling in.
export function missingFields(source) {
  const s = source || {};
  const gaps = [];
  if (!usableNames(s.authors).length) gaps.push('author');
  if (!dateParts(s.date)) gaps.push('date');
  if (s.kind !== 'article' && !tidy(s.siteName)) gaps.push('site name');
  if (!tidy(s.title)) gaps.push('title');
  return gaps;
}
