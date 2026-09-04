import test from 'node:test';
import assert from 'node:assert/strict';

import { mapClaimReviews, keywordQuery, FACTCHECK_PROVIDERS } from './index.js';

// Shaped like a real Fact Check Tools API response.
const response = {
  claims: [
    {
      text: 'Unemployment reached its lowest level in fifty years.',
      claimant: 'A politician',
      claimDate: '2024-03-02T00:00:00Z',
      claimReview: [
        {
          publisher: { name: 'PolitiFact', site: 'politifact.com' },
          url: 'https://www.politifact.com/factchecks/example/',
          title: 'Is unemployment at a fifty-year low?',
          reviewDate: '2024-03-05T00:00:00Z',
          textualRating: 'Half True',
          languageCode: 'en',
        },
      ],
    },
  ],
};

test('maps a claim review into the fields the panel renders', () => {
  const [first] = mapClaimReviews(response);
  assert.equal(first.publisher, 'PolitiFact');
  assert.equal(first.rating, 'Half True');
  assert.equal(first.reviewDate, '2024-03-05');
  assert.equal(first.claimant, 'A politician');
  assert.ok(first.url.startsWith('https://'));
});

test('a claim carrying several reviews yields one row per review', () => {
  const many = {
    claims: [{
      text: 'x',
      claimReview: [
        { publisher: { name: 'Snopes' }, textualRating: 'False' },
        { publisher: { name: 'Full Fact' }, textualRating: 'Mostly false' },
      ],
    }],
  };
  assert.equal(mapClaimReviews(many).length, 2);
});

test('falls back to the publisher site when no name is given', () => {
  const data = { claims: [{ claimReview: [{ publisher: { site: 'snopes.com' } }] }] };
  assert.equal(mapClaimReviews(data)[0].publisher, 'snopes.com');
});

test('names an unknown publisher rather than rendering undefined', () => {
  const data = { claims: [{ claimReview: [{}] }] };
  assert.equal(mapClaimReviews(data)[0].publisher, 'Unknown publisher');
});

test('an empty or malformed response yields no rows instead of throwing', () => {
  assert.deepEqual(mapClaimReviews({}), []);
  assert.deepEqual(mapClaimReviews(null), []);
  assert.deepEqual(mapClaimReviews({ claims: [] }), []);
  assert.deepEqual(mapClaimReviews({ claims: [{}] }), []);
});

test('the row count is capped', () => {
  const data = {
    claims: Array.from({ length: 10 }, () => ({
      text: 't', claimReview: [{ publisher: { name: 'P' }, textualRating: 'False' }],
    })),
  };
  assert.equal(mapClaimReviews(data).length, 5);
});

// Fact-check indexes are keyed to short claim wordings, so a whole news sentence
// usually matches nothing. The keyword fallback is what turns misses into hits.
test('keyword query drops stopwords and keeps the distinctive words', () => {
  const q = keywordQuery('The agency said that unemployment fell to 4.2 percent in the last quarter.');
  assert.ok(!q.includes(' the '), q);
  assert.ok(q.includes('unemployment'), q);
  assert.ok(/4\.2|percent/.test(q), q);
});

test('keyword query prefers numbers, which carry the most signal in a claim', () => {
  const q = keywordQuery('Spending rose by 15 billion dollars over the decade', 3).split(' ');
  assert.ok(q.some((w) => /\d/.test(w)), q.join(' '));
});

test('keyword query respects its limit and does not repeat words', () => {
  const q = keywordQuery('inflation inflation inflation economy economy prices wages growth taxes', 4);
  const words = q.split(' ');
  assert.ok(words.length <= 4);
  assert.equal(new Set(words).size, words.length);
});

test('a sentence of only stopwords yields an empty query rather than junk', () => {
  assert.equal(keywordQuery('and the of in on at to for'), '');
});

test('the none provider returns nothing and needs no key', async () => {
  assert.deepEqual(await FACTCHECK_PROVIDERS.none.lookup('anything'), []);
});

test('the google provider refuses to call without a key', async () => {
  await assert.rejects(() => FACTCHECK_PROVIDERS.google.lookup('a claim', ''), /key/i);
});
