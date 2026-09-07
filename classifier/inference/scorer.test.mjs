import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  tokenize, ngrams, handcrafted, heuristicScore, scoreWithModel,
  FEATURES, explainFeatures, FEATURE_LABELS,
} from './scorer.js';

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

// --- naming what the model noticed ----------------------------------------------

test('the signals named are ones the sentence actually contains', () => {
  const model = JSON.parse(readFileSync('classifier/model/model.json', 'utf8'));

  const named = explainFeatures(model, 'The Labor Department said unemployment fell to 4.2 percent in 2025.');
  assert.ok(named.includes('a percentage'), JSON.stringify(named));
  assert.ok(named.includes('a number'), JSON.stringify(named));
  // Which three lead depends on the weights of the model that happens to be
  // shipped; that none of them is absent from the sentence does not.
  for (const label of named) assert.ok(label !== 'a question' && label !== 'hedging language', label);
  assert.ok(named.length <= 3, 'three is enough to explain a highlight');

  const plain = explainFeatures(model, 'The new rules take effect next month.');
  assert.deepEqual(plain, [], 'nothing checkable in it, so nothing to name');
});

test('only signals weighted upward are named', () => {
  // Hedging is a reason the model scores a sentence lower. Listing it as a reason
  // the sentence was flagged would say the opposite of what the model did.
  const model = JSON.parse(readFileSync('classifier/model/model.json', 'utf8'));
  const named = explainFeatures(model, 'I think unemployment might probably be around 4 percent, seems like.');
  assert.ok(!named.includes('hedging language'), JSON.stringify(named));
  assert.ok(!named.includes('written in the first person'), JSON.stringify(named));
});

test('no model means no explanation rather than a guessed one', () => {
  assert.deepEqual(explainFeatures(null, 'Anything at all.'), []);
  assert.deepEqual(explainFeatures({}, 'Anything at all.'), []);
  assert.deepEqual(explainFeatures({ coef: [1] }, 'Anything at all.'), []);
});

test('every feature has a label, so none can surface as a raw name', () => {
  for (const [name] of FEATURES) {
    assert.ok(FEATURE_LABELS[name], `${name} has no reader-facing label`);
  }
});

// --- the pre-pass ------------------------------------------------------------------
// textprep.js and textprep.py must produce identical strings, or the weights fitted
// in Python apply to different tokens in the browser. The fixture is written by the
// Python side; this is the JavaScript side checking itself against it.

import { normalizeNumbers, maskEntities, prepare, ENTITY_TOKEN } from './textprep.js';

test('the JavaScript pre-pass matches the Python pre-pass on every fixture sentence', () => {
  const fixture = JSON.parse(readFileSync(join(here, '..', 'eval', 'prep_fixture.json'), 'utf8'));
  assert.ok(fixture.length >= 25, 'the fixture should cover the awkward cases');
  for (const row of fixture) {
    const { featureText, tokenText } = prepare({ preprocess: { numbers: true, entities: true } }, row.text);
    assert.equal(featureText, row.numbers, `numbers differ for: ${row.text}`);
    assert.equal(tokenText, row.masked, `masking differs for: ${row.text}`);
  }
});

test('number words become the digits the model already knows how to weigh', () => {
  assert.equal(normalizeNumbers('a quarter of the cobalt'), '0.25 of the cobalt');
  assert.equal(normalizeNumbers('forty thousand people'), '40000 people');
  assert.equal(normalizeNumbers('twenty-one people died'), '21 people died');
  assert.equal(normalizeNumbers('three million vehicles'), '3 million vehicles');
  assert.equal(normalizeNumbers('twice as many'), '2 times as many');
  assert.equal(normalizeNumbers('since nineteen ninety five'), 'since 1995');
});

test('"one" is only a number where it is counting', () => {
  assert.equal(normalizeNumbers('one in five households'), '1 in 5 households');
  assert.equal(normalizeNumbers('One possible explanation'), 'One possible explanation');
  assert.equal(normalizeNumbers('no one wanted to'), 'no one wanted to');
  assert.equal(normalizeNumbers('looked at one another'), 'looked at one another');
});

test('"half" is a fraction only where it is one', () => {
  assert.equal(normalizeNumbers('lost half its coral'), 'lost 0.5 its coral');
  assert.equal(normalizeNumbers('in the second half'), 'in the second half');
});

test('names become one token, wherever they are and however long', () => {
  assert.equal(maskEntities('The Federal Reserve raised rates.'), `The ${ENTITY_TOKEN} raised rates.`);
  assert.equal(maskEntities('Djokovic beat Alcaraz in Paris'), `Djokovic beat ${ENTITY_TOKEN} in ${ENTITY_TOKEN}`);
  assert.equal(maskEntities('I said I would, and so did Dr. Jane Smith'), `I said I would, and so did ${ENTITY_TOKEN}`);
  assert.equal(maskEntities('nothing capitalised at all'), 'nothing capitalised at all');
  assert.equal(maskEntities(''), '');
});

test('a model that declares no pre-pass is scored on the text exactly as written', () => {
  const raw = 'The Federal Reserve raised rates by a quarter point.';
  assert.deepEqual(prepare({}, raw), { featureText: raw, tokenText: raw });
  assert.deepEqual(prepare(null, raw), { featureText: raw, tokenText: raw });
});

test('with the pre-pass, a spelled-out figure fires the digit feature', () => {
  const names = FEATURES.map(([n]) => n);
  const raw = 'The mine produced a quarter of the cobalt.';
  const before = handcrafted(raw);
  const after = handcrafted(prepare({ preprocess: { numbers: true } }, raw).featureText);
  assert.equal(before[names.indexOf('has_digit')], 0);
  assert.equal(after[names.indexOf('has_digit')], 1);
});

// --- what the model file declares, the scorer applies ---------------------------------
// A model fitted with sublinear tf or with calibration says so in its file. A file
// that says nothing is scored exactly as the first model was.

const tiny = {
  vocabulary: { rates: 0, rose: 1 },
  idf: [1.5, 1.2],
  coef: [2.0, 1.0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  intercept: -1,
  feature_names: FEATURES.map(([n]) => n),
};

test('a repeated word counts once and a bit under sublinear tf, and fully without it', () => {
  const text = 'rates rates rates rose';
  const [raw] = scoreWithModel(tiny, [text]);
  const [sub] = scoreWithModel({ ...tiny, tfidf: { sublinear: true } }, [text]);
  // With raw counts "rates" dominates the vector; with 1 + ln(3) it dominates less,
  // so "rose" keeps more of the norm and the two scores differ.
  assert.notEqual(raw.toFixed(6), sub.toFixed(6));
  const [once] = scoreWithModel(tiny, ['rates rose']);
  const [onceSub] = scoreWithModel({ ...tiny, tfidf: { sublinear: true } }, ['rates rose']);
  assert.equal(once.toFixed(10), onceSub.toFixed(10), 'a word used once is the same either way');
});

test('calibration moves the probability without changing the order of sentences', () => {
  const texts = ['rates rose', 'rose', 'nothing here'];
  const before = scoreWithModel(tiny, texts);
  const after = scoreWithModel({ ...tiny, calibration: { a: 0.5, b: 0.3 } }, texts);
  const order = (s) => s.map((x, i) => [x, i]).sort((p, q) => q[0] - p[0]).map((p) => p[1]).join();
  assert.equal(order(before), order(after));
  assert.notEqual(before[0].toFixed(6), after[0].toFixed(6));
});
