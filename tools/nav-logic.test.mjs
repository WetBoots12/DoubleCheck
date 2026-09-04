// The find-bar stepping logic, extracted so its wrap-around and ordering behavior
// can be tested without a browser. Mirrors navigate() in the content scripts; if you
// change the stepping rule there, change it here too.

import test from 'node:test';
import assert from 'node:assert/strict';

function step(list, currentId, direction, idOf = (x) => x) {
  if (!list.length) return null;
  const at = list.findIndex((item) => idOf(item) === currentId);
  if (at === -1) return list[direction === 'prev' ? list.length - 1 : 0];
  const next = direction === 'prev'
    ? (at - 1 + list.length) % list.length
    : (at + 1) % list.length;
  return list[next];
}

const list = ['a', 'b', 'c'];

test('first next from nothing selected lands on the first claim', () => {
  assert.equal(step(list, null, 'next'), 'a');
});

test('first prev from nothing selected lands on the last claim', () => {
  assert.equal(step(list, null, 'prev'), 'c');
});

test('next advances in document order', () => {
  assert.equal(step(list, 'a', 'next'), 'b');
  assert.equal(step(list, 'b', 'next'), 'c');
});

test('next wraps past the end, as find-in-page does', () => {
  assert.equal(step(list, 'c', 'next'), 'a');
});

test('prev wraps past the start', () => {
  assert.equal(step(list, 'a', 'prev'), 'c');
});

test('a claim removed from the page does not strand navigation', () => {
  // 'z' is no longer present, e.g. the DOM changed under us.
  assert.equal(step(list, 'z', 'next'), 'a');
});

test('an empty page yields nothing rather than throwing', () => {
  assert.equal(step([], null, 'next'), null);
});

test('a single claim stays put in both directions', () => {
  assert.equal(step(['only'], 'only', 'next'), 'only');
  assert.equal(step(['only'], 'only', 'prev'), 'only');
});

test('video claims step in timestamp order, not discovery order', () => {
  // Markers arrive as captions play, but a seek backwards can add an earlier one late.
  const markers = [['m3', { ts: 30 }], ['m1', { ts: 5 }], ['m2', { ts: 12 }]];
  const ordered = [...markers].sort((a, b) => a[1].ts - b[1].ts);
  const idOf = (m) => m[0];

  assert.deepEqual(ordered.map(idOf), ['m1', 'm2', 'm3']);
  assert.equal(idOf(step(ordered, 'm1', 'next', idOf)), 'm2');
  assert.equal(idOf(step(ordered, 'm3', 'next', idOf)), 'm1');
});
