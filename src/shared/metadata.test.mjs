import test from 'node:test';
import assert from 'node:assert/strict';

import { metadataFromHtml, plausibleAuthor } from './metadata.js';

const page = (head, body = '') => `<html><head>${head}</head><body>${body}</body></html>`;

// --- rejecting a candidate --------------------------------------------------------

test('a leading "by" comes off, and a name that starts with those letters does not', () => {
  assert.equal(plausibleAuthor('By Jane Doe'), 'Jane Doe');
  assert.equal(plausibleAuthor('by jane doe'), 'jane doe');
  assert.equal(plausibleAuthor('Written by Jane Doe'), 'Jane Doe');
  assert.equal(plausibleAuthor('By: Jane Doe'), 'Jane Doe');
  // The trap: requiring whitespace after "by" is what saves these.
  assert.equal(plausibleAuthor('Byron Smith'), 'Byron Smith');
  assert.equal(plausibleAuthor('Byrne Kelly'), 'Byrne Kelly');
});

test('an address is not a person', () => {
  for (const bad of [
    'https://facebook.com/profile/123',
    'http://example.com/staff/jane',
    '//cdn.example.com/x',
    'www.example.com/authors/jane',
    'jane.doe@example.com',
    'Jane Doe <jane@example.com>',
  ]) {
    assert.equal(plausibleAuthor(bad), '', bad);
  }
});

test('a content-management placeholder is not a person', () => {
  for (const bad of ['admin', 'Editor', 'STAFF', 'wordpress', 'unknown', 'n/a', 'Anonymous']) {
    assert.equal(plausibleAuthor(bad), '', bad);
  }
});

test('a sentence is not a byline', () => {
  const sentence = 'This article was produced by the newsroom in collaboration with several partners and is free to read';
  assert.equal(plausibleAuthor(sentence), '');
  assert.equal(plausibleAuthor(''), '');
  assert.equal(plausibleAuthor(null), '');
  assert.equal(plausibleAuthor('12345'), '');
});

// --- JSON-LD, the most trustworthy source -------------------------------------------

test('an author, headline and publisher are read from JSON-LD', () => {
  const html = page(`<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'NewsArticle',
    headline: 'Inflation falls to 4.2 percent',
    author: { '@type': 'Person', name: 'Jane Doe' },
    publisher: { '@type': 'Organization', name: 'AP News' },
    datePublished: '2026-06-14T09:00:00Z',
  })}</script>`);

  const m = metadataFromHtml(html);
  assert.deepEqual(m.authors, [{ name: 'Jane Doe' }]);
  assert.equal(m.title, 'Inflation falls to 4.2 percent');
  assert.equal(m.siteName, 'AP News');
  assert.equal(m.date.slice(0, 10), '2026-06-14');
});

test('JSON-LD says whether an author is an organisation, so nothing has to be guessed', () => {
  const html = page(`<script type="application/ld+json">${JSON.stringify({
    '@type': 'NewsArticle',
    author: { '@type': 'Organization', name: 'Associated Press' },
  })}</script>`);
  assert.deepEqual(metadataFromHtml(html).authors, [{ name: 'Associated Press', organisation: true }]);
});

test('several authors come back in order', () => {
  const html = page(`<script type="application/ld+json">${JSON.stringify({
    '@type': 'Article',
    author: [{ name: 'Jane Doe' }, { name: 'John Roe' }],
  })}</script>`);
  assert.deepEqual(metadataFromHtml(html).authors, [{ name: 'Jane Doe' }, { name: 'John Roe' }]);
});

test('an author written as a bare string still counts', () => {
  const html = page('<script type="application/ld+json">{"@type":"Article","author":"Jane Doe"}</script>');
  assert.deepEqual(metadataFromHtml(html).authors, [{ name: 'Jane Doe' }]);
});

test('an article nested inside @graph is found', () => {
  const html = page(`<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebSite', name: 'Some Site' },
      { '@type': 'NewsArticle', headline: 'The real headline', author: { '@type': 'Person', name: 'Ann Poe' } },
    ],
  })}</script>`);
  const m = metadataFromHtml(html);
  assert.deepEqual(m.authors, [{ name: 'Ann Poe' }]);
  assert.equal(m.title, 'The real headline');
});

test('a malformed JSON-LD block is skipped rather than losing the good one', () => {
  const html = page(
    '<script type="application/ld+json">{ this is not json }</script>'
    + '<script type="application/ld+json">{"@type":"Article","author":{"name":"Jane Doe"}}</script>',
  );
  assert.deepEqual(metadataFromHtml(html).authors, [{ name: 'Jane Doe' }]);
});

// --- meta tags, when there is no JSON-LD ----------------------------------------------

test('meta author is used when nothing structured exists', () => {
  assert.deepEqual(metadataFromHtml(page('<meta name="author" content="Jane Doe">')).authors,
    [{ name: 'Jane Doe' }]);
});

test('the attributes may be written in either order', () => {
  assert.deepEqual(metadataFromHtml(page('<meta content="Jane Doe" name="author">')).authors,
    [{ name: 'Jane Doe' }]);
});

test("the New York Times byline tag and Dublin Core both work", () => {
  assert.deepEqual(metadataFromHtml(page('<meta name="byl" content="By Jane Doe">')).authors,
    [{ name: 'Jane Doe' }]);
  assert.deepEqual(metadataFromHtml(page('<meta name="dc.creator" content="Jane Doe">')).authors,
    [{ name: 'Jane Doe' }]);
});

test('two names in one tag become two authors', () => {
  assert.deepEqual(metadataFromHtml(page('<meta name="author" content="Jane Doe and John Roe">')).authors,
    [{ name: 'Jane Doe' }, { name: 'John Roe' }]);
});

test('article:author is refused when it is a profile address, which it usually is', () => {
  const asUrl = page('<meta property="article:author" content="https://facebook.com/janedoe">');
  assert.deepEqual(metadataFromHtml(asUrl).authors, []);

  const asName = page('<meta property="article:author" content="Jane Doe">');
  assert.deepEqual(metadataFromHtml(asName).authors, [{ name: 'Jane Doe' }]);
});

test('JSON-LD wins over a meta tag when both are present', () => {
  const html = page(
    '<meta name="author" content="Site Default">'
    + '<script type="application/ld+json">{"@type":"NewsArticle","author":{"name":"Jane Doe"}}</script>',
  );
  assert.deepEqual(metadataFromHtml(html).authors, [{ name: 'Jane Doe' }]);
});

// --- title and site name ----------------------------------------------------------------

test('the site name comes off the end of the page title', () => {
  const m = metadataFromHtml(page(
    '<meta property="og:site_name" content="The Guardian">'
    + '<title>Inflation falls to 4.2 percent | The Guardian</title>',
  ));
  assert.equal(m.siteName, 'The Guardian');
  assert.equal(m.title, 'Inflation falls to 4.2 percent');
});

test('a title that is only the site name is left alone rather than emptied', () => {
  const m = metadataFromHtml(page(
    '<meta property="og:site_name" content="The Guardian"><title>The Guardian</title>',
  ));
  assert.equal(m.title, 'The Guardian');
});

test('og:title is preferred to the title tag', () => {
  const m = metadataFromHtml(page(
    '<meta property="og:title" content="The real headline"><title>Something | Site</title>',
  ));
  assert.equal(m.title, 'The real headline');
});

test('entities in a title or a name are decoded', () => {
  const m = metadataFromHtml(page(
    '<meta name="author" content="Jos&eacute; Garc&iacute;a">'
    + '<title>Rates &amp; prices &#8212; rising</title>',
  ));
  assert.deepEqual(m.authors, [{ name: 'José García' }]);
  assert.equal(m.title, 'Rates & prices — rising');
});

// --- nothing found is a valid answer -------------------------------------------------

test('a page that says nothing about itself returns empty fields, not guesses', () => {
  const m = metadataFromHtml(page('', '<p>Just some text with no metadata at all.</p>'));
  assert.deepEqual(m, { authors: [], title: '', siteName: '', date: '' });
});

test('nothing at all does not throw', () => {
  for (const bad of ['', null, undefined]) {
    assert.deepEqual(metadataFromHtml(bad), { authors: [], title: '', siteName: '', date: '' });
  }
});

// --- cost -----------------------------------------------------------------------------

test('a hostile page cannot make this expensive', () => {
  // The same shape that made the date patterns quadratic: tag openings that never
  // close. This runs on HTML a stranger chose, on the thread the whole extension
  // shares, so it is bounded rather than trusted.
  for (const opening of ['<meta ', '<script ', '<title ', '<meta content=']) {
    const html = opening.repeat(50000); // about 300 KB, well inside the 2 MB fetch cap
    const started = Date.now();
    const m = metadataFromHtml(html);
    const elapsed = Date.now() - started;
    assert.deepEqual(m.authors, [], opening);
    assert.ok(elapsed < 1000, `${opening.trim()} took ${elapsed}ms on ${(html.length / 1024) | 0} KB`);
  }
});

test('an unclosed JSON-LD script does not make the scan run away', () => {
  const html = `<script type="application/ld+json">${'{"a":1,'.repeat(40000)}`;
  const started = Date.now();
  metadataFromHtml(html);
  assert.ok(Date.now() - started < 1000);
});

test('a control character in a meta tag is stripped rather than carried', () => {
  // Whitespace collapsing does not touch these, so they used to travel all the way
  // into an exported document and make it unopenable.
  const m = metadataFromHtml(page(
    '<meta property="og:title" content="Inflation\u0001 cools">'
    + '<meta name="author" content="Jane\u0001Doe">',
  ));
  assert.equal(m.title, 'Inflation cools');
  assert.deepEqual(m.authors, [{ name: 'JaneDoe' }]);
});
