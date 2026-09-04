import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { tokenize, ngrams, handcrafted, heuristicScore, scoreWithModel, FEATURES } from './scorer.js';

const here = dirname(fileURLToPath(import.meta.url));
const modelDir = join(here, '..', 'model');

test('tokenize lowercases and keeps apostrophes, matching the Python side', () => {
  assert.deepEqual(tokenize("The U.S. didn't grow 5.2% in 2024!"),
    ['the', 'u', 's', "didn't", 'grow', '5', '2', 'in', '2024']);
});

test('ngrams produces unigrams followed by bigrams', () => {
  assert.deepEqual(ngrams(['a', 'b', 'c']), ['a', 'b', 'c', 'a b', 'b c']);
});

test('handcrafted features fire on the signals they name', () => {
  const names = FEATURES.map(([n]) => n);
  const vec = handcrafted('Unemployment fell to 4.2% in 2024, according to the agency.');
  const on = names.filter((_, i) => vec[i] === 1);
  assert.ok(on.includes('has_digit'));
  assert.ok(on.includes('has_percent'));
  assert.ok(on.includes('has_year'));
  assert.ok(on.includes('has_attribution'));
  assert.ok(!on.includes('is_question'));
});

test('handcrafted vector length matches the feature list', () => {
  assert.equal(handcrafted('anything at all here').length, FEATURES.length);
});

// The extension ships with the heuristic until a model is trained, so its ordering
// behavior is what users actually experience today.
test('heuristic ranks factual claims above chatter', () => {
  const claim = heuristicScore(
    'Unemployment fell to 4.2 percent last quarter, according to the Labor Department.'
  );
  const chatter = heuristicScore(
    'Thanks so much for watching today and please remember to subscribe to the channel.'
  );
  assert.ok(claim > chatter, `expected ${claim} > ${chatter}`);
});

test('heuristic scores stay within 0..1', () => {
  const samples = [
    'Short.',
    'I think this might probably be the best option, in my opinion, for us.',
    'The company reported record revenue of 5 billion dollars in 2023.',
    'Do you think inflation caused more than half of the increase this year?',
  ];
  for (const s of samples) {
    const score = heuristicScore(s);
    assert.ok(score >= 0 && score <= 1, `${score} out of range for: ${s}`);
  }
});

test('heuristic ignores sentences too short to be claims', () => {
  assert.equal(heuristicScore('Prices rose.'), 0);
});

// Runs only once train.py has produced a model. It proves scorer.js reproduces the
// Python model's probabilities, which is the thing most likely to silently drift.
const modelPath = join(modelDir, 'model.json');
const fixturePath = join(modelDir, 'parity_fixture.json');

test('trained model scores match the Python implementation', { skip: !existsSync(modelPath) || !existsSync(fixturePath) }, () => {
  const model = JSON.parse(readFileSync(modelPath, 'utf8'));
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const got = scoreWithModel(model, fixture.sentences);

  assert.equal(got.length, fixture.scores.length);
  got.forEach((score, i) => {
    const delta = Math.abs(score - fixture.scores[i]);
    assert.ok(delta < 1e-6,
      `sentence ${i} scored ${score} in JS vs ${fixture.scores[i]} in Python (delta ${delta})`);
  });
});
