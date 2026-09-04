import test from 'node:test';
import assert from 'node:assert/strict';

import { extractQuantities, compareQuantities, sameValue } from './numbers.js';

const values = (text) => extractQuantities(text).map((q) => q.value);
const units = (text) => extractQuantities(text).map((q) => q.unit);

test('percentages are read, written either way', () => {
  assert.deepEqual(values('Inflation rose to 8.2 percent last year.'), [8.2]);
  assert.deepEqual(values('Inflation rose to 8.2% last year.'), [8.2]);
  assert.deepEqual(units('Inflation rose to 8.2% last year.'), ['percent']);
  assert.deepEqual(units('The rate rose by 3 percentage points.'), ['percent']);
});

test('money is read with its currency, symbol or word', () => {
  assert.deepEqual(values('The deal was worth $5 billion.'), [5e9]);
  assert.deepEqual(units('The deal was worth $5 billion.'), ['usd']);
  assert.deepEqual(units('The deal was worth 5 billion dollars.'), ['usd']);
  assert.deepEqual(units('The fine came to £2.5 million.'), ['gbp']);
  assert.deepEqual(units('It cost €300.'), ['eur']);
});

test('scale words and separators are applied', () => {
  assert.deepEqual(values('About 12,000 people attended.'), [12000]);
  assert.deepEqual(values('Some 3.5 million households were affected.'), [3.5e6]);
  assert.deepEqual(values('The company cut 1.2k jobs.'), [1200]);
});

test('a bare year is a date, not a quantity', () => {
  assert.deepEqual(values('The law passed in 2019.'), []);
  // But a year-like figure with a unit is a real quantity.
  assert.deepEqual(values('The fund holds $2019 million.'), [2019e6]);
  assert.deepEqual(values('Turnout was 2019 people.'), [2019]);
});

test('text with no figures yields none, and malformed input does not throw', () => {
  assert.deepEqual(values('The minister resigned after the vote.'), []);
  assert.deepEqual(values(''), []);
  assert.deepEqual(values(null), []);
  assert.deepEqual(values(undefined), []);
});

test('two figures of the same thing that differ are reported as a conflict', () => {
  const out = compareQuantities(
    'Inflation rose to 8.2 percent in the year to June.',
    'Official figures showed inflation was 2.1 percent over the same period.',
  );
  assert.equal(out.status, 'conflicts');
  assert.equal(out.conflicts.length, 1);
  assert.ok(out.note.includes('8.2') && out.note.includes('2.1'), out.note);
});

test('a source stating the same figure agrees, allowing for rounding', () => {
  const same = compareQuantities('Unemployment fell to 4.2 percent.', 'Unemployment fell to 4.2 percent, officials said.');
  assert.equal(same.status, 'agrees');
  assert.equal(same.conflicts.length, 0);

  const rounded = compareQuantities('Unemployment fell to 4.2 percent.', 'Unemployment stood at 4.24 percent that quarter.');
  assert.equal(rounded.status, 'agrees', 'rounding is not a contradiction');
});

test('figures about different things are never compared', () => {
  const out = compareQuantities(
    'Inflation rose to 8.2 percent in the year to June.',
    'Unemployment was 4.2 percent over the same period.',
  );
  assert.equal(out.status, 'none', 'nothing in the source is a figure for inflation');
  assert.deepEqual(out.conflicts, []);
});

test('different units are never compared', () => {
  const out = compareQuantities('The budget was $8 billion.', 'The budget covered 8 percent of spending.');
  assert.equal(out.status, 'none');
});

test('a source that both agrees and mentions another figure is not a contradiction', () => {
  const out = compareQuantities(
    'Unemployment fell to 4.2 percent.',
    'Unemployment fell to 4.2 percent, down from unemployment of 4.4 percent a quarter earlier.',
  );
  assert.equal(out.status, 'agrees', out.note);
});

test('a source with no figures at all says nothing either way', () => {
  const out = compareQuantities('Inflation rose to 8.2 percent.', 'Prices continued to climb, economists said.');
  assert.equal(out.status, 'none');
  assert.equal(out.note, '');
});

test('a claim with no figures cannot conflict', () => {
  const out = compareQuantities('The minister resigned.', 'Inflation was 2.1 percent that year.');
  assert.equal(out.status, 'none');
});

test('money contradictions are caught as well as percentages', () => {
  const out = compareQuantities(
    'The contract was worth $5 billion to the company.',
    'The company said the contract was worth $1.2 billion in total.',
  );
  assert.equal(out.status, 'conflicts');
  assert.ok(out.note.includes('$5 billion') && out.note.includes('$1.2 billion'), out.note);
});

test('sameValue tolerates rounding but not real differences', () => {
  assert.equal(sameValue(4.2, 4.24), true);
  assert.equal(sameValue(4.2, 2.1), false);
  assert.equal(sameValue(0, 0), true);
  assert.equal(sameValue(1e9, 1.001e9), true);
});
