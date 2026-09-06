import test from 'node:test';
import assert from 'node:assert/strict';

import { claimToMarkdown } from './exportclaim.js';

const FULL = {
  text: '  Inflation reached 8.2 percent in the year to June,\n  the statistics office reported.  ',
  results: [
    { url: 'https://apnews.com/a', title: 'Inflation hits 8.2%', excerpt: 'Prices rose 8.2 percent in the year to June.' },
    { url: 'https://www.bbc.co.uk/b', title: 'Cost of living', snippet: 'The figure was the highest since 1982.' },
  ],
  factChecks: [{ rating: 'True', publisher: 'FullFact', title: 'Inflation claim checked', url: 'https://fullfact.org/x' }],
  scholar: [{ title: 'Measuring inflation', url: 'https://doi.org/10.1/x', venue: 'J. Econ', year: 2025 }],
  analysis: { summary: 'Both sources report the same figure for the same period.' },
  evidence: { verdict: 'supported', position: 92, lines: ['2 of 2 sources address the claim', 'sources: 1 wire service, 1 public broadcaster'] },
};

test('the claim itself leads, tidied onto one line', () => {
  const md = claimToMarkdown(FULL);
  assert.ok(md.startsWith('> Inflation reached 8.2 percent in the year to June, the statistics office reported.'), md.slice(0, 120));
});

test('every section a claim has is carried over', () => {
  const md = claimToMarkdown(FULL, { pageTitle: 'Prices report', pageUrl: 'https://example.com/p' });
  for (const expected of [
    'Found on [Prices report](https://example.com/p)',
    '**Published fact-checks**',
    'True (FullFact)',
    '**What the sources amount to**',
    'Sources support this claim',
    '**Sources**',
    '[Inflation hits 8.2%](https://apnews.com/a)',
    'Prices rose 8.2 percent in the year to June.',
    '**Peer-reviewed work (OpenAlex)**',
    'J. Econ, 2025',
    '**AI summary**',
  ]) {
    assert.ok(md.includes(expected), `missing: ${expected}\n---\n${md}`);
  }
});

test('the note about what this is never comes off', () => {
  // Pasted somewhere else, the panel is gone and so is everything that made clear
  // this is a list of sources rather than a ruling.
  for (const claim of [FULL, { text: 'A bare claim with nothing found.' }, {}, null]) {
    const md = claimToMarkdown(claim);
    assert.ok(md.includes('finds sources rather than deciding'), md);
  }
});

test('a claim with nothing found is still worth pasting', () => {
  const md = claimToMarkdown({ text: 'The bridge cost 40 million dollars.' });
  assert.ok(md.includes('> The bridge cost 40 million dollars.'));
  assert.ok(!md.includes('**Sources**'), 'no sources section when there are none');
});

test('a source whose address is not an ordinary web address is named, not linked', () => {
  const md = claimToMarkdown({
    text: 'A claim.',
    results: [{ url: 'javascript:alert(1)', title: 'Looks helpful' }],
    scholar: [{ title: 'A paper', url: '10.1038/nature' }],
  });
  assert.ok(md.includes('- Looks helpful'), md);
  assert.ok(!md.includes('javascript:'), 'a refused scheme must not survive into pasted text');
  assert.ok(!md.includes('](10.1038'), 'a bare DOI is not an address');
});

test('a video claim says where in the video it was', () => {
  assert.ok(claimToMarkdown({ text: 'A claim.', ts: 754 }).includes('At 12:34 in the video'));
  assert.ok(claimToMarkdown({ text: 'A claim.', ts: 5 }).includes('At 0:05 in the video'));
});

test('missing and malformed pieces do not produce a broken document', () => {
  const md = claimToMarkdown({
    text: null,
    results: 'not an array',
    factChecks: [{}],
    scholar: null,
    evidence: { lines: null },
    analysis: { summary: 12345 },
    ts: 'not a number',
  });
  assert.ok(md.includes('(no text)'));
  assert.ok(!md.includes('undefined'), md);
  assert.ok(!md.includes('null'), md);
  assert.ok(!md.includes('in the video'), 'a timestamp that is not a number is not a timestamp');
});
