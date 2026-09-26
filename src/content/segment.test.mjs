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

// --- isBoilerplate ------------------------------------------------------------
// Page furniture that reaches the extractor as plain paragraphs. The first cut of
// these patterns shipped with literal backspace bytes where \b should have been,
// so every boundary is asserted here rather than assumed.

const { isBoilerplate } = FCSegment;

test('newsletter and subscription pitches are boilerplate', () => {
  assert.equal(isBoilerplate('Sign up for our newsletter to get the latest news delivered to your inbox every morning.'), true);
  assert.equal(isBoilerplate('Join 2 million readers and subscribe today for just 1 dollar a week.'), true);
  assert.equal(isBoilerplate('Enter your email to stay up to date.'), true);
});

test('legal lines and sharing prompts are boilerplate', () => {
  assert.equal(isBoilerplate('© 2026 Example Media. All rights reserved.'), true);
  assert.equal(isBoilerplate('Copyright (c) 2026 Example Media'), true);
  assert.equal(isBoilerplate('By continuing you agree to our Terms of Service and Privacy Policy.'), true);
  assert.equal(isBoilerplate('Follow us on social media and share this story with your friends.'), true);
  assert.equal(isBoilerplate('Download the app from the App Store or Google Play.'), true);
});

test('factual claims are not boilerplate, even with numbers in them', () => {
  assert.equal(isBoilerplate('The company reported record revenue of 5 billion dollars in 2023.'), false);
  assert.equal(isBoilerplate('Unemployment fell to 4.2 percent last quarter, according to the Labor Department.'), false);
  assert.equal(isBoilerplate('Officials confirmed the vote was delayed until March.'), false);
});

test('word boundaries keep pattern words from matching inside other words', () => {
  assert.equal(isBoilerplate('The chemical subscript in the formula was wrong, the paper said.'), false);
  assert.equal(isBoilerplate('The design was reconsidered after the review.'), false);
});

test('empty input is not boilerplate', () => {
  assert.equal(isBoilerplate(''), false);
  assert.equal(isBoilerplate(undefined), false);
});

test('ordinals such as 21st. are sentence ends, not St.', () => {
  assert.equal(splitSentences('The city ranks 21st. Its rival ranks 3rd.').length, 2);
  assert.equal(endsWithAbbreviation('The city ranks 21st.'), false);
  assert.equal(endsWithAbbreviation('They moved to St.', 'Louis last year.'), true);
});

// Wikipedia puts its reference markers straight after the full stop. ICU then breaks
// inside the marker, so the next claim began "1] Economists said..." in the panel and
// in the search query, or it did not break at all and two sentences became one.
// Measured in Chrome 153 on a page shaped like a Wikipedia article.
test('a reference marker after the full stop ends the sentence and is not part of the claim', () => {
  assert.deepEqual(
    splitSentences('Unemployment fell to 4.2 percent in the quarter.[1] Economists said the decline was broad.'),
    ['Unemployment fell to 4.2 percent in the quarter.', 'Economists said the decline was broad.'],
  );
  assert.deepEqual(
    splitSentences('It rose sharply in 2024.[12][13] Prices fell later that year.'),
    ['It rose sharply in 2024.', 'Prices fell later that year.'],
  );
});

test('a bracketed note after the full stop still ends the sentence', () => {
  assert.deepEqual(
    splitSentences('It rose sharply in 2024.[citation needed] Prices fell later that year.'),
    ['It rose sharply in 2024.', 'Prices fell later that year.'],
  );
});

test('with markers, every sentence is still a contiguous piece of the text', () => {
  const text = 'The council raised the budget by 12 million dollars.[2] Officials said ridership grew 18 percent.[3][4] Wages rose.[note 1] Prices did not.';
  const flat = text.replace(/\s+/g, ' ');
  let from = 0;
  for (const s of splitSentences(text)) {
    const at = flat.indexOf(s, from);
    assert.ok(at >= from, `not found in order: ${s}`);
    from = at + s.length;
  }
  assert.ok(!splitSentences(text).some((s) => s.includes('[')), 'no marker is left on a sentence');
});
