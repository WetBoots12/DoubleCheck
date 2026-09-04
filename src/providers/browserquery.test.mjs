import test from 'node:test';
import assert from 'node:assert/strict';

import { browserQuery, properNounPhrases } from './index.js';

test('the figure is quoted, because that is what the claim turns on', () => {
  const q = browserQuery('The mayor said the bridge cost 40 million dollars more than planned.');
  assert.ok(q.includes('"40 million dollars"'), q);
  assert.ok(q.includes('bridge'), q);
});

test('names are quoted so an engine matches them as names', () => {
  const q = browserQuery('Unemployment fell to 4.2 percent last quarter, according to the Labor Department.');
  assert.ok(q.includes('"4.2 percent"'), q);
  assert.ok(q.includes('"Labor Department"'), q);
  assert.ok(q.includes('unemployment'), q);
});

test('who said it is dropped: the search is for the fact, not for the speaker', () => {
  const q = browserQuery('Crime is at an all-time low in New York City, the governor claimed.');
  assert.ok(q.includes('"New York City"'), q);
  assert.ok(!/governor|claimed/.test(q), q);
});

test('the whole sentence is never handed over', () => {
  const sentence = 'The Office for National Statistics reported that inflation rose to 8.2 percent in the year to June, which was higher than most economists had forecast at the start of the year.';
  const q = browserQuery(sentence);
  assert.ok(!q.includes('which was higher than'), q);
  assert.ok(q.split(/\s+/).length <= 14, `too long: ${q}`);
  assert.ok(q.includes('"8.2 percent"'), q);
});

test('a claim with no figures and no names still produces something searchable', () => {
  const q = browserQuery('The new policy will reduce waiting times across the health service.');
  assert.ok(q.length > 0);
  assert.ok(/waiting|health|policy|service/.test(q), q);
  assert.ok(!q.includes('"'), 'nothing to quote, so nothing is quoted');
});

test('empty and malformed input yields an empty query rather than a broken one', () => {
  assert.equal(browserQuery(''), '');
  assert.equal(browserQuery('   '), '');
  assert.equal(browserQuery(null), '');
  assert.equal(browserQuery(undefined), '');
});

test('quotation marks in the claim itself do not break the query', () => {
  const q = browserQuery('The minister called the report "deeply flawed" and said 30 percent of cases were wrong.');
  assert.ok(q.includes('"30 percent"'), q);
  // Whatever else it does, the quotes must pair up or the engine reads the rest as one phrase.
  assert.equal((q.match(/"/g) || []).length % 2, 0, `unbalanced quotes: ${q}`);
});

test('proper-noun runs are found, and the first words of a sentence are not mistaken for one', () => {
  assert.deepEqual(properNounPhrases('Reports say the World Health Organization acted early.'), ['World Health Organization']);
  // The leading "The" is grammar; the name behind it is still a name, and stripping
  // an attribution off the front of a claim routinely leaves one at position zero.
  assert.deepEqual(properNounPhrases('The Labor Department published it.'), ['Labor Department']);
  assert.deepEqual(properNounPhrases('Many Americans Believe things.'), ['Americans Believe']);
  assert.deepEqual(properNounPhrases('nothing capitalised here at all'), []);
  assert.deepEqual(properNounPhrases(''), []);
});

test('a name joined by a small word is kept whole', () => {
  const found = properNounPhrases('Officials at the Office for National Statistics confirmed it.');
  assert.ok(found.includes('Office for National Statistics'), JSON.stringify(found));
});

test('the same phrase is never repeated in one query', () => {
  const q = browserQuery('New York City said New York City spending rose 12 percent.');
  assert.equal(q.split('"New York City"').length - 1, 1, q);
});
