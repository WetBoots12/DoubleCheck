import test from 'node:test';
import assert from 'node:assert/strict';

// Loaded the way a content script loads it: for the global it installs.
import './segment.js';

const FCSegment = globalThis.FCSegment;

const { splitSentences, endsWithAbbreviation } = FCSegment;

test('splits ordinary prose on sentence boundaries', () => {
  assert.deepEqual(
    splitSentences('Costs rose sharply last year. Wages did not keep pace.'),
    ['Costs rose sharply last year.', 'Wages did not keep pace.'],
  );
});

// Cases the old regex got wrong, or that ICU alone gets wrong.
test('keeps "U.S." inside a sentence', () => {
  const out = splitSentences('The U.S. government announced new tariffs on Tuesday. Markets fell.');
  assert.equal(out.length, 2);
  assert.ok(out[0].startsWith('The U.S. government'));
});

test('keeps honorifics such as Dr. and Sen. with the name that follows', () => {
  assert.equal(splitSentences('Dr. Smith said the trial enrolled 400 patients. Results are due.').length, 2);
  assert.equal(splitSentences('Sen. McCain voted no. The bill failed 51 to 49.').length, 2);
});

test('keeps e.g. and i.e. inside a sentence', () => {
  assert.equal(splitSentences('Costs rose e.g. in housing and i.e. in rent. Wages did not.').length, 2);
});

test('keeps corporate suffixes and month abbreviations inside a sentence', () => {
  assert.equal(splitSentences('Apple Inc. reported revenue of 90 billion dollars. Shares rose.').length, 2);
  assert.equal(splitSentences('The vote was moved to Jan. 14 by the clerk. Nobody objected.').length, 2);
});

test('keeps a middle initial with the surname', () => {
  assert.equal(splitSentences('George W. Bush signed the bill. It took effect in May.').length, 2);
});

test('splits after a quoted question, which the old regex could not', () => {
  const out = splitSentences('He asked "Is this true?" She replied that it was. Nobody checked.');
  assert.equal(out.length, 3);
});

test('text without terminal punctuation stays as one segment, as captions do', () => {
  assert.equal(splitSentences('unemployment fell to four percent the agency said today').length, 1);
});

test('collapses whitespace and returns contiguous substrings of the collapsed text', () => {
  const text = 'Costs rose\n   sharply. Wages\tdid not.';
  const flat = text.replace(/\s+/g, ' ');
  for (const s of splitSentences(text)) assert.ok(flat.includes(s), s);
});

test('honours a minimum length', () => {
  assert.deepEqual(splitSentences('Short. This one is long enough to keep around.', 10),
    ['This one is long enough to keep around.']);
});

test('empty input yields nothing', () => {
  assert.deepEqual(splitSentences(''), []);
  assert.deepEqual(splitSentences('   '), []);
});

test('endsWithAbbreviation recognises the list and single initials only', () => {
  assert.equal(endsWithAbbreviation('He met Dr.'), true);
  assert.equal(endsWithAbbreviation('Signed by George W.'), true);
  assert.equal(endsWithAbbreviation('The meeting ended.'), false);
  assert.equal(endsWithAbbreviation('It cost 4.2'), false);
});

// Ambiguities that a bare word list gets wrong, caught by the first version of this.
test('"voted no." ends a sentence but "No. 42" does not', () => {
  assert.equal(splitSentences('The senator voted no. The bill failed anyway.').length, 2);
  assert.equal(splitSentences('It was filed as No. 42 in the docket. Nobody noticed.').length, 2);
  assert.equal(endsWithAbbreviation('voted no.', 'The bill'), false);
  assert.equal(endsWithAbbreviation('filed as No.', '42 in the docket'), true);
});

test('ordinals such as 21st. are sentence ends, not St.', () => {
  assert.equal(splitSentences('The city ranks 21st. Its rival ranks 3rd.').length, 2);
  assert.equal(endsWithAbbreviation('The city ranks 21st.'), false);
  assert.equal(endsWithAbbreviation('They moved to St.', 'Louis last year.'), true);
});
