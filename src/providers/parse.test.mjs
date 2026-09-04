import test from 'node:test';
import assert from 'node:assert/strict';

import { parseAnalysis } from './index.js';

const good = JSON.stringify({
  verdict: 'mixed',
  confidence: 0.62,
  summary: 'Sources differ on the figure [1][2].',
  agreement: 'All agree a strike occurred.',
  dispute: 'The casualty count varies.',
  perspectives: [
    { source: 'reuters.com', lean: 'center' },
    { source: 'example.org', lean: 'nonsense' },
  ],
});

test('parses a well-formed response', () => {
  const a = parseAnalysis(good);
  assert.equal(a.verdict, 'mixed');
  assert.equal(a.confidence, 0.62);
  assert.equal(a.perspectives.length, 2);
  assert.equal(a.perspectives[0].lean, 'center');
});

// Small local models and on-device models routinely wrap JSON in prose or fences.
test('recovers JSON from a code fence', () => {
  const a = parseAnalysis('Sure! Here is the result:\n```json\n' + good + '\n```\nHope that helps.');
  assert.equal(a.verdict, 'mixed');
  assert.equal(a.summary, 'Sources differ on the figure [1][2].');
});

test('unrecognized lean values degrade to unclear rather than rendering garbage', () => {
  assert.equal(parseAnalysis(good).perspectives[1].lean, 'unclear');
});

test('an unknown verdict becomes unclear', () => {
  const a = parseAnalysis(JSON.stringify({ verdict: 'definitely true', summary: 'x' }));
  assert.equal(a.verdict, 'unclear');
});

test('plain prose becomes the summary instead of failing', () => {
  const a = parseAnalysis('The sources broadly back this up.');
  assert.equal(a.verdict, 'unclear');
  assert.equal(a.summary, 'The sources broadly back this up.');
  assert.deepEqual(a.perspectives, []);
});

test('malformed JSON falls back to prose', () => {
  const a = parseAnalysis('{ "verdict": "supported", oops');
  assert.equal(a.verdict, 'unclear');
  assert.ok(a.summary.includes('oops'));
});

test('empty output does not throw', () => {
  const a = parseAnalysis('');
  assert.equal(a.verdict, 'unclear');
  assert.equal(a.summary, '');
});

test('confidence is clamped and non-numeric confidence becomes null', () => {
  assert.equal(parseAnalysis(JSON.stringify({ verdict: 'supported', confidence: 5 })).confidence, 1);
  assert.equal(parseAnalysis(JSON.stringify({ verdict: 'supported', confidence: 'high' })).confidence, null);
});

test('a long perspective list is capped', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ source: `s${i}.com`, lean: 'center' }));
  const a = parseAnalysis(JSON.stringify({ verdict: 'mixed', perspectives: many }));
  assert.equal(a.perspectives.length, 8);
});
