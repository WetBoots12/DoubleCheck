import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FORMATS, isFormat, splitName, looksLikeOrganisation, dateParts,
  formatCitation, citationSegments, toPlainText, worksCited, missingFields,
} from './citation.js';

// A news article read on the web, with everything a good page declares.
const WEB = {
  kind: 'web',
  title: 'Inflation falls to 4.2 percent',
  url: 'https://www.apnews.com/article/inflation-june',
  siteName: 'AP News',
  authors: ['Jane Doe'],
  date: '2026-06-14',
  accessed: '2026-09-06',
};

// A journal article from OpenAlex, which gives authors, venue, year and a DOI.
const ARTICLE = {
  kind: 'article',
  title: 'Measuring consumer price inflation',
  url: 'https://doi.org/10.1234/jecon.2025.7',
  doi: 'https://doi.org/10.1234/jecon.2025.7',
  venue: 'Journal of Economics',
  authors: ['Maria Alvarez', 'John Roe'],
  date: 2025,
  volume: '42',
  issue: '3',
  pages: '117-140',
  accessed: '2026-09-06',
};

// --- names ------------------------------------------------------------------------

test('a plain name splits into surname and given names', () => {
  assert.deepEqual(splitName('Jane Doe'), { surname: 'Doe', given: 'Jane' });
  assert.deepEqual(splitName('Mary Jane Watson'), { surname: 'Watson', given: 'Mary Jane' });
});

test('a name already inverted by the source is left inverted', () => {
  assert.deepEqual(splitName('Doe, Jane'), { surname: 'Doe', given: 'Jane' });
});

test('a particle stays with the surname', () => {
  assert.deepEqual(splitName('Ludwig van Beethoven'), { surname: 'van Beethoven', given: 'Ludwig' });
  assert.deepEqual(splitName('Maria de la Cruz'), { surname: 'de la Cruz', given: 'Maria' });
});

test('a suffix follows the surname rather than becoming it', () => {
  assert.deepEqual(splitName('Martin Luther King Jr.'), { surname: 'King, Jr.', given: 'Martin Luther' });
});

test('an organisation is never inverted', () => {
  // "BBC News" must not become "News, BBC", which is the failure this guards.
  assert.deepEqual(splitName('BBC News'), { organisation: 'BBC News' });
  assert.deepEqual(splitName('Reuters'), { organisation: 'Reuters' });
  assert.deepEqual(splitName('Associated Press'), { organisation: 'Associated Press' });
  assert.equal(looksLikeOrganisation('Jane Doe'), false);
});

test('an empty or missing name yields nothing rather than a broken entry', () => {
  for (const bad of ['', '   ', null, undefined]) assert.equal(splitName(bad), null);
});

// --- dates ------------------------------------------------------------------------

test('a calendar date is not shifted by the reader time zone', () => {
  // getFullYear on a parsed ISO date returns the previous day west of Greenwich,
  // which would print the wrong date in every citation for half the world.
  assert.deepEqual(dateParts('2026-01-01'), { year: 2026, month: 0, day: 1 });
  assert.deepEqual(dateParts('2026-06-14T09:30:00Z'), { year: 2026, month: 5, day: 14 });
});

test('a bare year is a date, and nonsense is not', () => {
  assert.deepEqual(dateParts(2025), { year: 2025, month: null, day: null });
  assert.deepEqual(dateParts('1998'), { year: 1998, month: null, day: null });
  for (const bad of ['', null, undefined, 'not a date', {}]) assert.equal(dateParts(bad), null);
});

// --- the four styles ----------------------------------------------------------------

test('MLA puts the author first, quotes the title and italicises the site', () => {
  const out = formatCitation(WEB, 'mla');
  assert.equal(out,
    'Doe, Jane. "Inflation falls to 4.2 percent." AP News, 14 June 2026, '
    + 'www.apnews.com/article/inflation-june. Accessed 6 Sept. 2026.');

  const italic = citationSegments(WEB, 'mla').filter((s) => s.italic).map((s) => s.text);
  assert.deepEqual(italic, ['AP News'], 'the container is the italic part');
});

test('MLA drops the scheme from the address, as MLA 9 asks', () => {
  assert.ok(!formatCitation(WEB, 'mla').includes('https://'));
});

test('APA inverts to initials and puts the date in brackets', () => {
  assert.equal(formatCitation(WEB, 'apa'),
    'Doe, J. (2026, June 14). Inflation falls to 4.2 percent. AP News. '
    + 'https://www.apnews.com/article/inflation-june');
});

test('Chicago spells the month and ends with the address', () => {
  assert.equal(formatCitation(WEB, 'chicago'),
    'Doe, Jane. "Inflation falls to 4.2 percent." AP News. June 14, 2026. '
    + 'https://www.apnews.com/article/inflation-june.');
});

test('Harvard leads with the year and states when it was accessed', () => {
  assert.equal(formatCitation(WEB, 'harvard'),
    'Doe, J. (2026) Inflation falls to 4.2 percent. AP News. '
    + 'Available at: https://www.apnews.com/article/inflation-june (Accessed: 6 September 2026).');
});

// --- a journal article is not a web page ---------------------------------------------

test('a journal article quotes its own title and italicises the journal', () => {
  const mla = formatCitation(ARTICLE, 'mla');
  assert.ok(mla.startsWith('Alvarez, Maria, and John Roe. "Measuring consumer price inflation."'), mla);
  assert.ok(mla.includes('vol. 42, no. 3, 2025, pp. 117-140'), mla);

  const italic = citationSegments(ARTICLE, 'mla').filter((s) => s.italic).map((s) => s.text);
  assert.deepEqual(italic, ['Journal of Economics'],
    'the journal is italic and the article title is not');
});

test('APA gives a journal its volume, issue and pages', () => {
  const apa = formatCitation(ARTICLE, 'apa');
  assert.ok(apa.startsWith('Alvarez, M., & Roe, J. (2025).'), apa);
  assert.ok(apa.includes('Journal of Economics, 42(3), 117-140.'), apa);
  assert.ok(apa.endsWith('https://doi.org/10.1234/jecon.2025.7'), apa);
});

test('MLA writes a DOI in full but strips the scheme from a plain address', () => {
  assert.ok(formatCitation(ARTICLE, 'mla').includes('https://doi.org/10.1234/jecon.2025.7'));
  assert.ok(!formatCitation(WEB, 'mla').includes('https://'));
});

test('the DOI is preferred over the address when both exist', () => {
  for (const f of ['mla', 'apa', 'chicago', 'harvard']) {
    assert.ok(formatCitation(ARTICLE, f).includes('10.1234/jecon.2025.7'), f);
  }
});

// --- what a real web result actually looks like ----------------------------------------

test('an unauthored page cites correctly rather than leaving a gap', () => {
  // This is most web results: a title, an address, a site, and no byline anywhere.
  const anon = { ...WEB, authors: [] };
  assert.equal(formatCitation(anon, 'mla'),
    '"Inflation falls to 4.2 percent." AP News, 14 June 2026, '
    + 'www.apnews.com/article/inflation-june. Accessed 6 Sept. 2026.');
  // APA moves the title into the author's place; it must not print "undefined".
  assert.equal(formatCitation(anon, 'apa'),
    'Inflation falls to 4.2 percent. (2026, June 14). AP News. '
    + 'https://www.apnews.com/article/inflation-june');
  // The title stands in the author's place but is still a standalone work's title.
  assert.deepEqual(citationSegments(anon, 'apa').filter((x) => x.italic).map((x) => x.text),
    ['Inflation falls to 4.2 percent']);
});

test('a page with no date says so in the way each style asks', () => {
  const undated = { ...WEB, date: null };
  assert.ok(formatCitation(undated, 'apa').includes('(n.d.)'));
  assert.ok(formatCitation(undated, 'harvard').includes('(n.d.)'));
  assert.ok(!formatCitation(undated, 'mla').includes('undefined'));
});

test('three or more authors become et al. where the style asks for it', () => {
  const many = { ...WEB, authors: ['Jane Doe', 'John Roe', 'Ann Poe', 'Sam Moe'] };
  assert.ok(formatCitation(many, 'mla').startsWith('Doe, Jane, et al.'), formatCitation(many, 'mla'));
  assert.ok(formatCitation(many, 'harvard').startsWith('Doe, J. et al.'), formatCitation(many, 'harvard'));
  // APA lists up to twenty, so all four appear.
  assert.ok(formatCitation(many, 'apa').includes('& Moe, S.'), formatCitation(many, 'apa'));
});

test('an organisation as author reads as itself in every style', () => {
  const wire = { ...WEB, authors: ['Associated Press'] };
  for (const f of ['mla', 'apa', 'chicago', 'harvard']) {
    const out = formatCitation(wire, f);
    assert.ok(out.includes('Associated Press'), `${f}: ${out}`);
    assert.ok(!out.includes('Press, Associated'), `${f} inverted an organisation: ${out}`);
  }
});

// --- robustness --------------------------------------------------------------------

test('nothing at all still produces something rather than throwing', () => {
  for (const f of ['mla', 'apa', 'chicago', 'harvard']) {
    for (const empty of [{}, null, undefined]) {
      const out = formatCitation(empty, f);
      assert.equal(typeof out, 'string');
      assert.ok(!out.includes('undefined'), `${f}: ${out}`);
      assert.ok(!out.includes('null'), `${f}: ${out}`);
    }
  }
});

test('an unknown format falls back rather than failing', () => {
  assert.equal(formatCitation(WEB, 'not-a-style'), formatCitation(WEB, 'mla'));
  assert.equal(isFormat('mla'), true);
  assert.equal(isFormat('nope'), false);
  assert.equal(FORMATS.length, 4);
});

test('a title that already ends in a full stop does not gain a second one', () => {
  const out = formatCitation({ ...WEB, title: 'Prices rose again.' }, 'mla');
  assert.ok(!out.includes('..'), out);
});

test('a title ending in a question mark keeps it and gains no full stop', () => {
  const out = formatCitation({ ...WEB, title: 'Why did prices rise?' }, 'mla');
  assert.ok(out.includes('"Why did prices rise?"'), out);
});

// --- the list ------------------------------------------------------------------------

test('a works cited list is alphabetised and deduplicated', () => {
  const list = worksCited([
    { ...WEB, authors: ['Zoe Young'], title: 'Later alphabetically' },
    { ...WEB, authors: ['Alan Adams'], title: 'Earlier alphabetically' },
    { ...WEB, authors: ['Zoe Young'], title: 'Later alphabetically' }, // the same source twice
  ], 'mla');

  assert.equal(list.length, 2, 'the same source cited twice is one entry');
  assert.ok(list[0].startsWith('Adams, Alan.'), list[0]);
  assert.ok(list[1].startsWith('Young, Zoe.'), list[1]);
});

test('an empty list of sources is an empty list, not a broken one', () => {
  assert.deepEqual(worksCited([], 'mla'), []);
  assert.deepEqual(worksCited(null, 'mla'), []);
});

// --- telling the reader what is missing -------------------------------------------------

test('the gaps in a thin citation are named, so they can be filled', () => {
  assert.deepEqual(missingFields(WEB), []);
  assert.deepEqual(missingFields({ kind: 'web', title: 'A page', url: 'https://x.example' }),
    ['author', 'date', 'site name']);
  assert.ok(missingFields({}).includes('title'));
});

test('a journal article is not asked for a site name it never has', () => {
  assert.equal(missingFields(ARTICLE).length, 0);
});

// --- segments -----------------------------------------------------------------------

test('the segments flatten to exactly the plain text', () => {
  for (const f of ['mla', 'apa', 'chicago', 'harvard']) {
    assert.equal(toPlainText(citationSegments(WEB, f)), formatCitation(WEB, f), f);
  }
});
