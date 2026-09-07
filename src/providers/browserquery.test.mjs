import test from 'node:test';
import assert from 'node:assert/strict';

import { browserQuery, properNounPhrases } from './index.js';

test('the figure is quoted, because that is what the claim turns on', () => {
  const q = browserQuery('The mayor said the bridge cost 40 million dollars more than planned.');
  assert.ok(q.includes('"40 million dollars"'), q);
  assert.ok(q.includes('bridge'), q);
});

test('names are quoted so an engine matches them as names', () => {
  // Two phrases is what Google and Bing take; see shared/engines.js for who gets what.
  const q = browserQuery('Unemployment fell to 4.2 percent last quarter, according to the Labor Department.', { maxPhrases: 2 });
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
  const q = browserQuery('New York City said New York City spending rose 12 percent.', { maxPhrases: 2 });
  assert.equal(q.split('"New York City"').length - 1, 1, q);
});

// --- what the query keeps of the claim -----------------------------------------------
// A reader compared the query with the sentence it came from and found it "a little
// off": words in a scrambled order, a bare year in quotation marks as if it were the
// figure, and the words that say what the claim is about dropped in favour of the
// words that say where it was published.

test('the words go to the engine in the order the claim said them', () => {
  // Engines reward proximity and order; a keyword list sorted by length reads as
  // "coral cover since lost half", which no one wrote.
  const q = browserQuery('The Great Barrier Reef has lost half its coral cover since 1995.');
  const at = (w) => q.indexOf(w);
  assert.ok(at('lost') < at('coral') && at('coral') < at('cover') && at('cover') < at('1995'), q);
});

test('a figure carries the word that says what it counts', () => {
  assert.ok(browserQuery('Officials said the new rail line will cut journey times to under 30 minutes.').includes('"30 minutes"'));
  assert.ok(browserQuery('People who walk 8,000 steps a day live longer.').includes('"8,000 steps"'));
  assert.ok(browserQuery('Tesla delivered 1.8 million vehicles in 2023.').includes('"1.8 million vehicles"'));
  // A figure that already says what it is does not take the next word as well.
  assert.ok(browserQuery('Unemployment fell to 4.2 percent last quarter.').includes('"4.2 percent"'));
});

test('a year is context, not the figure, so it is not what gets quoted', () => {
  const q = browserQuery('The Federal Reserve raised interest rates by a quarter point, its tenth increase since March 2022.');
  assert.ok(!q.includes('"2022"'), q);
  assert.ok(q.includes('2022'), q);
  assert.ok(q.includes('"Federal Reserve"'), q);
  assert.ok(/rates/.test(q) && /quarter/.test(q), q);
});

test('punctuation after a figure never ends up inside the quotation marks', () => {
  const q = browserQuery('Tesla delivered 1.8 million vehicles in 2023, up 38 percent on the year.', { maxPhrases: 2 });
  assert.ok(!/[,.]"/.test(q), q);
});

test('what the claim is about outranks where it was published and when it was said', () => {
  const q = browserQuery('The study, published in The Lancet on Wednesday, found that people who walk 8,000 steps a day had a 50 percent lower risk of early death.', { maxPhrases: 2 });
  for (const w of ['steps', 'risk', 'death', 'walk']) assert.ok(q.includes(w), `${w} missing from: ${q}`);
  assert.ok(!/published|found|wednesday/.test(q), q);
});
