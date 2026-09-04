import test from 'node:test';
import assert from 'node:assert/strict';

import { relevance, verbiage, sourceTier, ratingTone, scoreEvidence, TIER_WEIGHT } from './evidence.js';

const CLAIM = 'Unemployment fell to 4.2 percent last quarter, according to the Labor Department.';

// --- relevance --------------------------------------------------------------------

test('relevance is high when the source repeats the claim\'s distinctive words', () => {
  const r = relevance(CLAIM, 'Labor Department: unemployment fell to 4.2 percent in the quarter.');
  assert.ok(r > 0.7, String(r));
});

test('relevance is near zero for an unrelated source', () => {
  const r = relevance(CLAIM, 'The football season opens next week with three home games.');
  assert.ok(r < 0.15, String(r));
});

test('numbers count double, so a source with the figure outranks one without', () => {
  const withNumber = relevance(CLAIM, 'unemployment 4.2 percent');
  const without = relevance(CLAIM, 'unemployment quarter percent');
  assert.ok(withNumber > without);
});

test('relevance handles empty input', () => {
  assert.equal(relevance('', 'anything'), 0);
  assert.equal(relevance(CLAIM, ''), 0);
});

// --- verbiage ---------------------------------------------------------------------

test('hedging, opinion and sensational language are each detected', () => {
  assert.equal(verbiage('The minister allegedly approved the deal.').hedged, true);
  assert.equal(verbiage('In my opinion the policy failed.').opinion, true);
  assert.equal(verbiage('SHOCKING bombshell DESTROYS the narrative!!').sensational, true);
});

test('plain reporting carries no penalty', () => {
  const v = verbiage('The rate fell to 4.2 percent, the department said on Friday.');
  assert.equal(v.penalty, 0);
  assert.equal(v.hedged, false);
});

test('an acronym alone is not shouting', () => {
  assert.equal(verbiage('The NASA report cited the figure.').sensational, false);
});

// --- tiers ------------------------------------------------------------------------

test('known outlets map to their tiers', () => {
  assert.equal(sourceTier({ url: 'https://www.reuters.com/x' }), 'wire');
  assert.equal(sourceTier({ url: 'https://www.bbc.co.uk/news/x' }), 'public');
  assert.equal(sourceTier({ url: 'https://www.politifact.com/x' }), 'factcheck');
  assert.equal(sourceTier({ url: 'https://www.nytimes.com/x' }), 'major');
  assert.equal(sourceTier({ url: 'https://en.wikipedia.org/wiki/x' }), 'encyclopedia');
  assert.equal(sourceTier({ url: 'https://someone.blogspot.com/x' }), 'weak');
  assert.equal(sourceTier({ url: 'https://www.bls.gov/x' }), 'gov');
  assert.equal(sourceTier({ url: 'https://randomsite.example/x' }), 'unknown');
});

test('an academic flag from the search layer wins over the domain lists', () => {
  assert.equal(sourceTier({ url: 'https://www.nature.com/x', academic: true }), 'academic');
});

test('the user\'s lists override the built-in tiers, and distrust beats trust', () => {
  const tiers = { trusted: ['randomsite.example'], distrusted: ['nytimes.com'] };
  assert.equal(sourceTier({ url: 'https://randomsite.example/x' }, tiers), 'trusted');
  assert.equal(sourceTier({ url: 'https://www.nytimes.com/x' }, tiers), 'distrusted');
  assert.equal(sourceTier({ url: 'https://a.com' }, { trusted: ['a.com'], distrusted: ['a.com'] }), 'distrusted');
});

test('every tier has a weight', () => {
  for (const t of ['trusted', 'distrusted', 'academic', 'factcheck', 'wire', 'gov', 'public', 'major', 'encyclopedia', 'unknown', 'weak']) {
    assert.ok(typeof TIER_WEIGHT[t] === 'number', t);
  }
});

test('ratingTone maps publisher wording, negations and mixed ratings correctly', () => {
  assert.equal(ratingTone('False'), 'false');
  assert.equal(ratingTone('Not true'), 'false');
  assert.equal(ratingTone('Half True'), 'mixed');
  assert.equal(ratingTone('Mostly true'), 'true');
  assert.equal(ratingTone('Satire'), 'unknown');
});

// --- scoring ----------------------------------------------------------------------

const SOURCES = [
  { url: 'https://www.reuters.com/a', title: 'Unemployment falls to 4.2 percent', snippet: 'The Labor Department said the rate fell last quarter.' },
  { url: 'https://www.apnews.com/b', title: 'Jobs report: 4.2 percent unemployment', snippet: 'Unemployment fell in the quarter, the department reported.' },
  { url: 'https://someone.blogspot.com/c', title: 'SHOCKING jobs numbers EXPOSED!!', snippet: 'Unemployment allegedly fell to 4.2 percent, sources say.' },
  { url: 'https://sports.example/d', title: 'Season preview', snippet: 'Three home games open the football season next week.' },
];

test('no sources yields zero quality, no position, and says so', () => {
  const e = scoreEvidence(CLAIM, []);
  assert.equal(e.quality, 0);
  assert.equal(e.position, null);
  assert.deepEqual(e.lines, ['No sources were found.']);
});

test('irrelevant sources are counted but excluded from the score', () => {
  const e = scoreEvidence(CLAIM, SOURCES);
  assert.equal(e.rows.filter((r) => r.relevant).length, 3);
  assert.ok(e.lines[0].startsWith('3 of 4 sources address the claim'), e.lines[0]);
});

test('quality rises with more credible, cleaner sources', () => {
  const strong = scoreEvidence(CLAIM, SOURCES.slice(0, 2));
  const weakOnly = scoreEvidence(CLAIM, [SOURCES[2]]);
  assert.ok(strong.quality > weakOnly.quality, `${strong.quality} vs ${weakOnly.quality}`);
  assert.ok(strong.quality <= 1 && weakOnly.quality >= 0);
});

test('without stances or fact-checks there is no thermometer position', () => {
  const e = scoreEvidence(CLAIM, SOURCES);
  assert.equal(e.position, null);
  assert.equal(e.support, null);
  assert.equal(e.verdict, 'unclear');
});

test('the explanation names tiers and language', () => {
  const e = scoreEvidence(CLAIM, SOURCES);
  assert.ok(e.lines.some((l) => /wire service/.test(l)), e.lines.join(' | '));
  assert.ok(e.lines.some((l) => /weak source/.test(l)), e.lines.join(' | '));
  assert.ok(e.lines.some((l) => /hedged/.test(l) && /sensational/.test(l)), e.lines.join(' | '));
});

test('stances from the AI produce a weighted support reading and a position', () => {
  const e = scoreEvidence(CLAIM, SOURCES, { stances: { 1: 'supports', 2: 'supports', 3: 'contradicts', 4: 'unrelated' } });
  assert.ok(e.support > 0.4, String(e.support)); // two wire services outweigh one hedged blog
  assert.equal(e.verdict, 'supported');
  assert.ok(e.position > 70 && e.position <= 92, String(e.position));
  assert.ok(e.lines.some((l) => l === '2 support, 1 contradict'), e.lines.join(' | '));
});

test('a weak source cannot outvote a wire service on its own', () => {
  const e = scoreEvidence(CLAIM, SOURCES, { stances: { 1: 'contradicts', 3: 'supports' } });
  assert.ok(e.support < 0, String(e.support));
  assert.equal(e.verdict, 'not_supported');
});

test('stances that are all unrelated give no position and say so', () => {
  const e = scoreEvidence(CLAIM, SOURCES, { stances: { 1: 'unrelated', 2: 'unrelated' } });
  assert.equal(e.position, null);
  assert.ok(e.lines.some((l) => l === 'no source takes a clear position'), e.lines.join(' | '));
});

test('a published fact-check outranks the AI stances and leads the explanation', () => {
  const e = scoreEvidence(CLAIM, SOURCES, {
    stances: { 1: 'supports', 2: 'supports' },
    factChecks: [{ publisher: 'PolitiFact', rating: 'False' }],
  });
  assert.equal(e.verdict, 'not_supported');
  assert.equal(e.position, 8);
  assert.ok(e.lines[0].startsWith('published fact-check: False (PolitiFact)'), e.lines[0]);
});

test('a fact-check with an unrecognised rating does not force a position', () => {
  const e = scoreEvidence(CLAIM, SOURCES, { factChecks: [{ publisher: 'X', rating: 'Satire' }] });
  assert.equal(e.position, null);
});

test('the user\'s tiers change the weighting', () => {
  const base = scoreEvidence(CLAIM, SOURCES.slice(0, 1));
  const distrusted = scoreEvidence(CLAIM, SOURCES.slice(0, 1), { tiers: { distrusted: ['reuters.com'] } });
  assert.ok(distrusted.quality < base.quality);
  assert.ok(distrusted.lines.some((l) => /weak \(your list\)/.test(l)));
});

test('position is always within the thermometer bounds when present', () => {
  for (const stances of [{ 1: 'supports' }, { 1: 'contradicts' }, { 1: 'supports', 3: 'contradicts' }]) {
    const e = scoreEvidence(CLAIM, SOURCES, { stances });
    assert.ok(e.position >= 0 && e.position <= 100, String(e.position));
  }
});

// --- how old a source is, against what period the claim is about --------------------

const NOW = new Date('2026-09-04T00:00:00Z');

test('a source published before the year in the claim counts for less and says why', () => {
  const sources = [
    { url: 'https://a.com/1', title: 'Jobs', snippet: 'Unemployment fell to 4.2 percent, the Labor Department said.', date: '2015-01-01' },
  ];
  const dated = scoreEvidence('Unemployment fell to 4.2 percent in 2023, the Labor Department said.', sources, { now: NOW });
  const undated = scoreEvidence('Unemployment fell to 4.2 percent in 2023, the Labor Department said.',
    [{ ...sources[0], date: '' }], { now: NOW });

  assert.equal(dated.rows[0].time.status, 'predates');
  assert.ok(dated.rows[0].weight < undated.rows[0].weight, 'the older source should weigh less');
  assert.ok(dated.lines.some((l) => l.includes("out of step with the claim's date")), dated.lines.join(' | '));
});

test('a claim about the present is weakly served by a page from years ago', () => {
  const sources = [{ url: 'https://a.com/1', title: 'Crime', snippet: 'Crime is at an all-time low across the country.', date: '2017-03-02' }];
  const out = scoreEvidence('Crime is at an all-time low.', sources, { now: NOW });
  assert.equal(out.rows[0].time.status, 'stale');
  assert.ok(out.rows[0].time.note.includes('2017'), out.rows[0].time.note);
});

test('a recent source, an undated one and a later one are all left alone', () => {
  const base = { url: 'https://a.com/1', title: 'Jobs', snippet: 'Unemployment fell to 4.2 percent, the Labor Department said.' };
  for (const date of ['2026-06-01', '', '2024-01-01']) {
    const out = scoreEvidence('Unemployment fell to 4.2 percent in 2023.', [{ ...base, date }], { now: NOW });
    assert.ok(!['predates', 'stale'].includes(out.rows[0].time.status), `${date || 'undated'} should not be penalised`);
    assert.equal(out.rows[0].time.note, '');
  }
});

test('the timing note never appears when there is nothing wrong with the timing', () => {
  const out = scoreEvidence(CLAIM, [{ url: 'https://a.com/1', title: 'Jobs', snippet: 'Unemployment fell to 4.2 percent.', date: '2026-08-01' }], { now: NOW });
  assert.ok(!out.lines.some((l) => l.includes('out of step')), out.lines.join(' | '));
});

// --- figures that disagree ---------------------------------------------------------

test('a source giving a different figure for the same thing is called out', () => {
  const claim = 'Inflation rose to 8.2 percent in the year to June.';
  const sources = [{ url: 'https://a.com/1', title: 'Prices', snippet: 'Official figures showed inflation was 2.1 percent over the same period.' }];
  const out = scoreEvidence(claim, sources, { now: NOW });
  assert.equal(out.rows[0].figures.status, 'conflicts');
  assert.ok(out.lines.some((l) => l.includes('different figure')), out.lines.join(' | '));
  assert.ok(out.rows[0].figures.note.includes('8.2') && out.rows[0].figures.note.includes('2.1'));
});

test('a source stating the same figure is not called out', () => {
  const claim = 'Unemployment fell to 4.2 percent last quarter.';
  const sources = [{ url: 'https://a.com/1', title: 'Jobs', snippet: 'Unemployment fell to 4.2 percent last quarter, the department said.' }];
  const out = scoreEvidence(claim, sources, { now: NOW });
  assert.equal(out.rows[0].figures.status, 'agrees');
  assert.ok(!out.lines.some((l) => l.includes('different figure')), out.lines.join(' | '));
});

test('the excerpt is what gets compared, so a figure only in the page body counts', () => {
  const claim = 'Inflation rose to 8.2 percent in the year to June.';
  const sources = [{
    url: 'https://a.com/1',
    title: 'Prices',
    snippet: 'Inflation continued to be a concern for households, economists said…',
    excerpt: 'The office reported that inflation was 2.1 percent in the year to June.',
  }];
  const out = scoreEvidence(claim, sources, { now: NOW });
  assert.equal(out.rows[0].figures.status, 'conflicts', 'the body figure should be compared');
});
