import test from 'node:test';
import assert from 'node:assert/strict';

import FCTextMatch from './textmatch.cjs';

const { buildMatchPlan, normalize } = FCTextMatch;

// Reassembles what the wrapped spans would contain, so a plan can be checked
// against the text it actually selects.
function selected(nodes, plan) {
  return plan.map((p) => nodes[p.nodeIndex].slice(p.start, p.end)).join('');
}

test('finds a sentence inside a single node', () => {
  const nodes = ['Unemployment fell to 4.2% last quarter. The rest is other text.'];
  const plan = buildMatchPlan(nodes, 'Unemployment fell to 4.2% last quarter.');
  assert.equal(selected(nodes, plan), 'Unemployment fell to 4.2% last quarter.');
});

// The case that broke real pages: a link or bold phrase splits the sentence.
test('spans a sentence broken across nodes by a link', () => {
  const nodes = ['The agency said that ', 'unemployment', ' fell to 4.2% last quarter.'];
  const plan = buildMatchPlan(nodes, 'The agency said that unemployment fell to 4.2% last quarter.');
  assert.equal(plan.length, 3);
  assert.equal(selected(nodes, plan), nodes.join(''));
});

test('tolerates the newlines and indentation the DOM keeps but extraction collapses', () => {
  const nodes = ['The agency said\n      that costs rose\n   by 30 percent.'];
  const plan = buildMatchPlan(nodes, 'The agency said that costs rose by 30 percent.');
  assert.ok(plan);
  assert.equal(normalize(selected(nodes, plan)), 'The agency said that costs rose by 30 percent.');
});

test('tolerates non-breaking spaces', () => {
  const nodes = ['Costs rose by 30 percent nationwide.'];
  const plan = buildMatchPlan(nodes, 'Costs rose by 30 percent nationwide.');
  assert.ok(plan);
  assert.equal(normalize(selected(nodes, plan)), 'Costs rose by 30 percent nationwide.');
});

test('selects only the sentence, not the surrounding text', () => {
  const nodes = ['Intro text here. ', 'Costs rose 30 percent.', ' Trailing text here.'];
  const plan = buildMatchPlan(nodes, 'Costs rose 30 percent.');
  assert.equal(selected(nodes, plan), 'Costs rose 30 percent.');
});

test('handles a sentence starting mid-node and ending mid-node', () => {
  const nodes = ['Lead in. Costs rose ', 'sharply', ' last year. Trailing.'];
  const plan = buildMatchPlan(nodes, 'Costs rose sharply last year.');
  assert.equal(selected(nodes, plan), 'Costs rose sharply last year.');
});

test('returns null when the sentence is not present', () => {
  assert.equal(buildMatchPlan(['Nothing relevant here.'], 'Costs rose 30 percent.'), null);
});

test('returns null for empty input rather than matching everything', () => {
  assert.equal(buildMatchPlan(['Some text'], ''), null);
  assert.equal(buildMatchPlan(['Some text'], '   '), null);
});

test('empty nodes between fragments do not break the plan', () => {
  const nodes = ['Costs rose ', '', 'by 30 percent.'];
  const plan = buildMatchPlan(nodes, 'Costs rose by 30 percent.');
  assert.equal(normalize(selected(nodes, plan)), 'Costs rose by 30 percent.');
});

test('a sentence split across many nodes yields one range per node touched', () => {
  const nodes = ['A', ' b', ' c', ' d'];
  const plan = buildMatchPlan(nodes, 'A b c d');
  assert.equal(plan.length, 4);
  assert.equal(selected(nodes, plan), 'A b c d');
});

test('matches the first occurrence when a sentence repeats', () => {
  const nodes = ['Costs rose. ', 'Costs rose.'];
  const plan = buildMatchPlan(nodes, 'Costs rose.');
  assert.equal(plan[0].nodeIndex, 0);
});
