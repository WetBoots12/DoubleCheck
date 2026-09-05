import test from 'node:test';
import assert from 'node:assert/strict';

import { parseDate, claimTimeframe, temporalFit, isMismatch, publishedDateFromHtml } from './dates.js';

const NOW = new Date('2026-09-04T00:00:00Z');
const at = { now: NOW };

test('the date formats providers and pages actually use are understood', () => {
  const iso = parseDate('2024-03-03T11:20:00Z', at);
  assert.equal(iso.getUTCFullYear(), 2024);
  assert.equal(iso.getUTCMonth(), 2);
  assert.equal(iso.getUTCDate(), 3);

  for (const form of ['Mar 3, 2024', 'March 3, 2024', '3 March 2024', '2024/03/03']) {
    const d = parseDate(form, at);
    assert.ok(d, `${form} should parse`);
    assert.equal(d.getUTCFullYear(), 2024, form);
    assert.equal(d.getUTCMonth(), 2, form);
  }

  assert.equal(parseDate('2019', at).getUTCFullYear(), 2019, 'a bare year is all some sources give');
});

test('nonsense, empty and impossible dates parse to nothing rather than to an epoch', () => {
  for (const bad of ['', null, undefined, 'last Tuesday', 'n/a', '0000-00-00', '1876-01-01']) {
    assert.equal(parseDate(bad, at), null, `${bad} should not parse`);
  }
  assert.equal(parseDate('2031-01-01', at), null, 'a date in the future is a parse error, not news');
  assert.ok(parseDate(new Date('2024-01-01'), at), 'a Date passes through');
});

test('a claim names the period it is about, or is about the present', () => {
  assert.deepEqual(claimTimeframe('Unemployment was 4.2 percent in 2017.'), { year: 2017, current: false });
  assert.deepEqual(claimTimeframe('Crime is at an all-time low.'), { year: null, current: true });
  assert.deepEqual(claimTimeframe('Inflation currently stands at 3 percent.'), { year: null, current: true });
  // Two years mentioned: the later one is the period being claimed about.
  assert.equal(claimTimeframe('Since 2015, the figure has risen every year to a peak in 2023.').year, 2023);
  // No year and no present-tense marker: no opinion either way.
  assert.deepEqual(claimTimeframe('The minister resigned after the vote.'), { year: null, current: false });
});

test('a source published before the year in the claim cannot be reporting on it', () => {
  const fit = temporalFit('Unemployment fell to 4.2 percent in 2023.', '2019-06-01', at);
  assert.equal(fit.status, 'predates');
  assert.ok(isMismatch(fit.status));
  assert.ok(fit.note.includes('2019') && fit.note.includes('2023'), fit.note);
});

test('a source published after the year in the claim is fine, because it can look back', () => {
  assert.equal(temporalFit('Unemployment fell to 4.2 percent in 2017.', '2024-01-01', at).status, 'fits');
  assert.equal(temporalFit('Unemployment fell to 4.2 percent in 2017.', '2017-11-01', at).status, 'fits');
});

test('a claim about now is poorly served by a page from years ago', () => {
  const stale = temporalFit('Crime is at an all-time low.', '2018-01-01', at);
  assert.equal(stale.status, 'stale');
  assert.ok(stale.note.includes('2018'), stale.note);

  const recent = temporalFit('Crime is at an all-time low.', '2026-06-01', at);
  assert.equal(recent.status, 'fits');
});

test('an undated source is never penalised, since most of the web is undated', () => {
  const fit = temporalFit('Crime is at an all-time low.', '', at);
  assert.equal(fit.status, 'unknown');
  assert.equal(isMismatch(fit.status), false);
  assert.equal(fit.note, '');
  assert.equal(temporalFit('Anything', null, at).status, 'unknown');
});

test('a claim with no timeframe at all judges no source', () => {
  const fit = temporalFit('The minister resigned after the vote.', '2001-01-01', at);
  assert.equal(fit.status, 'fits', 'without a stated period there is nothing to be out of step with');
});

test('the publication date is read from the page the publisher wrote', () => {
  const html = `<html><head>
    <meta property="article:published_time" content="2024-03-03T09:00:00Z">
    </head><body><p>text</p></body></html>`;
  assert.ok(publishedDateFromHtml(html, at).startsWith('2024-03-03'));

  const reversed = `<meta content="2022-05-06T09:00:00Z" property="article:published_time">`;
  assert.ok(publishedDateFromHtml(reversed, at).startsWith('2022-05-06'));

  const timeTag = `<article><time datetime="2021-07-08">8 July 2021</time></article>`;
  assert.ok(publishedDateFromHtml(timeTag, at).startsWith('2021-07-08'));

  const jsonLd = `<script type="application/ld+json">{"datePublished":"2020-02-02T00:00:00Z"}</script>`;
  assert.ok(publishedDateFromHtml(jsonLd, at).startsWith('2020-02-02'));
});

test('a page with no date, or a broken one, yields no date rather than a wrong one', () => {
  assert.equal(publishedDateFromHtml('<html><body><p>no dates here</p></body></html>', at), '');
  assert.equal(publishedDateFromHtml('<time datetime="soon">soon</time>', at), '');
  assert.equal(publishedDateFromHtml('', at), '');
  assert.equal(publishedDateFromHtml(null, at), '');
});

// --- a hostile page must not be able to stop the worker ------------------------
//
// publishedDateFromHtml runs on pages fetched for their text: third-party HTML, up
// to the 2 MB cap in fetchPageHtml, chosen by a search provider rather than by us.
// The patterns it uses are anchored on a tag name and then scan forward with [^>],
// so a document full of tag openings that never close made every start position
// scan to the end of the file and back. That is quadratic, and it runs on the one
// thread the whole extension shares.

test('a page full of unclosed tags is read quickly rather than freezing the worker', () => {
  for (const opening of ['<time ', '<meta ', '<meta property=']) {
    const html = opening.repeat(50000); // ~300 KB, well inside the 2 MB fetch cap
    const started = Date.now();
    const out = publishedDateFromHtml(html);
    const elapsed = Date.now() - started;

    assert.equal(out, '', `${opening} declares no date, so none should be found`);
    assert.ok(elapsed < 1000,
      `${opening.trim()} took ${elapsed}ms on ${(html.length / 1024) | 0} KB; `
      + 'the same shape at the 2 MB fetch cap would hang the service worker for minutes');
  }
});

test('a real date is still found when it sits behind a lot of markup', () => {
  const filler = '<div class="wrapper">'.repeat(2000);
  const html = `<html><head>${filler}<meta property="article:published_time" content="2026-03-04T09:00:00Z"></head></html>`;
  assert.equal(publishedDateFromHtml(html).slice(0, 10), '2026-03-04');
});
