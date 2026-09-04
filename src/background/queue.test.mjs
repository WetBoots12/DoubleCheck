import test from 'node:test';
import assert from 'node:assert/strict';

import { createQueue } from './queue.js';

// A job whose completion the test controls.
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test('runs up to the concurrency limit and holds the rest', async () => {
  const q = createQueue(2);
  const started = [];
  const gates = [deferred(), deferred(), deferred()];
  gates.forEach((g, i) => q.push(1, () => { started.push(i); return g.promise; }));
  await tick();

  assert.deepEqual(started, [0, 1]);
  assert.equal(q.running, 2);
  assert.equal(q.size, 1);

  gates[0].resolve();
  await tick();
  assert.deepEqual(started, [0, 1, 2]);
  assert.equal(q.size, 0);
});

test('drop removes only the named tab\'s queued jobs and reports the count', async () => {
  const q = createQueue(1);
  const gate = deferred();
  const ran = [];
  q.push(7, () => gate.promise);           // in flight, occupies the single slot
  q.push(7, () => { ran.push('7a'); });    // queued
  q.push(8, () => { ran.push('8a'); });    // queued, different tab
  q.push(7, () => { ran.push('7b'); });    // queued
  await tick();

  assert.equal(q.drop(7), 2);
  assert.equal(q.size, 1);

  gate.resolve();
  await tick();
  await tick();
  assert.deepEqual(ran, ['8a']);
});

// The honest limit of quota discipline: an in-flight call has already been
// counted by the provider, so it must run to completion and not be recalled.
test('drop does not touch a job already in flight', async () => {
  const q = createQueue(1);
  const gate = deferred();
  let finished = false;
  q.push(3, () => gate.promise.then(() => { finished = true; }));
  await tick();

  assert.equal(q.drop(3), 0);
  assert.equal(q.running, 1);

  gate.resolve();
  await tick();
  await tick();
  assert.equal(finished, true);
  assert.equal(q.running, 0);
});

test('a rejecting job does not stall the queue', async () => {
  const q = createQueue(1);
  const ran = [];
  q.push(1, () => Promise.reject(new Error('provider down')));
  q.push(1, () => { ran.push('next'); });
  await tick();
  await tick();
  assert.deepEqual(ran, ['next']);
  assert.equal(q.running, 0);
});

test('a job that throws synchronously does not stall the queue', async () => {
  const q = createQueue(1);
  const ran = [];
  q.push(1, () => { throw new Error('bad job'); });
  q.push(1, () => { ran.push('next'); });
  await tick();
  await tick();
  assert.deepEqual(ran, ['next']);
  assert.equal(q.running, 0);
});

test('jobs run in the order they were queued', async () => {
  const q = createQueue(1);
  const ran = [];
  for (const n of [1, 2, 3, 4]) q.push(9, () => { ran.push(n); });
  for (let i = 0; i < 6; i++) await tick();
  assert.deepEqual(ran, [1, 2, 3, 4]);
});

test('dropping an unknown tab is a harmless no-op', () => {
  const q = createQueue(2);
  assert.equal(q.drop(404), 0);
  assert.equal(q.size, 0);
});
