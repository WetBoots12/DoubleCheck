import test from 'node:test';
import assert from 'node:assert/strict';

import { stripAttribution, searchQuery } from './index.js';

// --- stripAttribution ---------------------------------------------------------

test('strips a titled-name attribution with a day and "reporters"', () => {
  assert.equal(
    stripAttribution('Treasury Secretary Janet Yellen told reporters on Tuesday that inflation fell to 3 percent last month.'),
    'inflation fell to 3 percent last month.',
  );
});

test('strips "According to ..., "', () => {
  assert.equal(
    stripAttribution('According to the report, costs rose 30 percent nationwide last year.'),
    'costs rose 30 percent nationwide last year.',
  );
});

test('strips a plain subject with "said that"', () => {
  assert.equal(
    stripAttribution('Officials said that the program served 1.2 million people last year.'),
    'the program served 1.2 million people last year.',
  );
});

test('strips a lower-case lead-in that contains an abbreviation', () => {
  assert.equal(
    stripAttribution('The U.S. government said that costs rose by 30 percent nationwide.'),
    'costs rose by 30 percent nationwide.',
  );
});

// Stripping must never gut a short quote; the remainder has to be a real clause.
test('does not strip when what remains would be too short', () => {
  assert.equal(stripAttribution('He said no.'), 'He said no.');
  assert.equal(stripAttribution('Officials said that it failed.'), 'Officials said that it failed.');
});

test('leaves a sentence with no attribution alone', () => {
  const s = 'Costs rose 30 percent last year across every region surveyed.';
  assert.equal(stripAttribution(s), s);
});

test('tolerates empty input', () => {
  assert.equal(stripAttribution(''), '');
  assert.equal(stripAttribution(undefined), '');
});

// --- searchQuery --------------------------------------------------------------

test('a short claim is searched verbatim', () => {
  const s = 'Unemployment fell to 4.2 percent last quarter, according to the Labor Department.';
  assert.equal(searchQuery(s), s);
});

test('a short claim still has its attribution stripped', () => {
  assert.equal(
    searchQuery('Officials said that the program served 1.2 million people last year.'),
    'the program served 1.2 million people last year.',
  );
});

const LONG =
  'The agency reported on Thursday that the national unemployment rate fell to 4.2 percent in the last quarter of the year, the lowest level recorded since the survey began in 1990.';

test('a long claim is reduced to a bounded number of distinctive words', () => {
  const q = searchQuery(LONG);
  const words = q.split(' ');
  assert.ok(words.length <= 12, `${words.length} words: ${q}`);
  assert.ok(words.length >= 4, q);
});

test('distillation keeps numbers, which carry the most signal', () => {
  const q = searchQuery(LONG);
  assert.ok(q.includes('4.2'), q);
});

test('distillation drops stopwords', () => {
  const words = searchQuery(LONG).split(' ');
  for (const w of ['the', 'that', 'in', 'of', 'to']) assert.ok(!words.includes(w), `kept "${w}": ${words.join(' ')}`);
});

test('distillation preserves original word order, since engines reward proximity', () => {
  const q = searchQuery(LONG);
  assert.ok(q.indexOf('unemployment') < q.indexOf('4.2'), q);
  assert.ok(q.indexOf('4.2') < q.indexOf('quarter'), q);
});

test('a quoted phrase is kept whole and placed first', () => {
  const q = searchQuery(
    'The minister said that the plan was "dead on arrival" and that no further funding would be approved for the project this year at all.',
  );
  assert.ok(q.startsWith('"dead on arrival"'), q);
  assert.ok(q.includes('funding'), q);
});

test('empty input yields an empty query', () => {
  assert.equal(searchQuery(''), '');
  assert.equal(searchQuery('   '), '');
});
