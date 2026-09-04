import test from 'node:test';
import assert from 'node:assert/strict';

// Classic script: importing it for the side effect installs the global, the same
// way the browser loads it as a content script.
import './mutations.js';
const { worthScanning, createScheduler } = globalThis.FCMutations;

// --- fake DOM nodes ------------------------------------------------------------

const el = (text, extra = {}) => ({ nodeType: 1, textContent: text, ...extra });
const textNode = (text, parent = el('')) => ({ nodeType: 3, nodeValue: text, parentElement: parent });
const added = (...nodes) => [{ type: 'childList', addedNodes: nodes }];

const PARAGRAPH = 'The agency said unemployment fell to 4.2 percent last quarter.';

test('a paragraph of real text is worth a scan', () => {
  assert.equal(worthScanning(added(el(PARAGRAPH)), {}), true);
});

test('a text node counts, judged through its parent', () => {
  assert.equal(worthScanning(added(textNode(PARAGRAPH)), {}), true);
});

test('short additions are ignored: labels, timestamps, icons, empty wrappers', () => {
  assert.equal(worthScanning(added(el('12:04')), {}), false);
  assert.equal(worthScanning(added(el('   ')), {}), false);
  assert.equal(worthScanning(added(el('')), {}), false);
  assert.equal(worthScanning(added({ nodeType: 8, textContent: PARAGRAPH }), {}), false, 'a comment node is not text');
});

test('text arriving inside a nav, promo or player region is ignored', () => {
  const promo = el(PARAGRAPH, { promo: true });
  assert.equal(worthScanning(added(promo), { isExcluded: (n) => n.promo === true }), false);
});

test("the extension's own highlight wrappers never trigger a scan", () => {
  const ours = el(PARAGRAPH, { ours: true });
  assert.equal(worthScanning(added(ours), { isOurs: (n) => n.ours === true }), false);
});

test('attribute and character-data mutations alone are not worth a scan', () => {
  assert.equal(worthScanning([{ type: 'attributes', addedNodes: [] }], {}), false);
  assert.equal(worthScanning([{ type: 'characterData', addedNodes: [el(PARAGRAPH)] }], {}), false);
});

test('one readable addition among many empty ones still counts', () => {
  const records = [
    { type: 'childList', addedNodes: [el(''), el('x')] },
    { type: 'attributes', addedNodes: [] },
    { type: 'childList', addedNodes: [el(PARAGRAPH)] },
  ];
  assert.equal(worthScanning(records, {}), true);
});

test('empty, missing and malformed records do not throw', () => {
  assert.equal(worthScanning([], {}), false);
  assert.equal(worthScanning(undefined, {}), false);
  assert.equal(worthScanning([{ type: 'childList' }], {}), false);
  assert.equal(worthScanning(added(textNode(PARAGRAPH, null)), {}), false);
  assert.equal(worthScanning(added(el(PARAGRAPH))), true, 'options are optional');
});

// --- pacing ---------------------------------------------------------------------

// A controllable clock and timer, so the scheduler can be driven exactly.
function harness() {
  let t = 0;
  let pending = null;
  let id = 0;
  const runs = [];
  const opts = {
    quietMs: 800,
    maxWaitMs: 5000,
    now: () => t,
    setTimer: (fn, ms) => { pending = { fn, at: t + ms, id: ++id }; return pending.id; },
    clearTimer: (which) => { if (pending && pending.id === which) pending = null; },
  };
  return {
    runs,
    opts,
    advance(ms) {
      t += ms;
      if (pending && pending.at <= t) {
        const { fn } = pending;
        pending = null;
        fn();
      }
    },
    get scheduled() { return Boolean(pending); },
  };
}

test('the work runs once the page has been quiet, not on every change', () => {
  const h = harness();
  const schedule = createScheduler(() => h.runs.push('scan'), h.opts);

  schedule();
  h.advance(300);
  schedule();
  h.advance(300);
  schedule();
  assert.deepEqual(h.runs, [], 'nothing should run while changes keep arriving');

  h.advance(800);
  assert.deepEqual(h.runs, ['scan'], 'one scan after the page settles');
});

test('a page that never goes quiet is still scanned at the ceiling', () => {
  const h = harness();
  const schedule = createScheduler(() => h.runs.push('scan'), h.opts);

  // A ticker changing every 100ms: a plain debounce would never fire.
  for (let i = 0; i < 60; i++) {
    schedule();
    h.advance(100);
  }
  assert.ok(h.runs.length >= 1, 'the ceiling should have forced at least one scan');
  assert.ok(h.runs.length <= 2, `the ceiling should not scan repeatedly, got ${h.runs.length}`);
});

test('after a forced scan the window restarts, so scans stay spaced out', () => {
  const h = harness();
  const schedule = createScheduler(() => h.runs.push('scan'), h.opts);
  for (let i = 0; i < 200; i++) {
    schedule();
    h.advance(100);
  }
  // 20 seconds of unbroken churn at a 5s ceiling.
  assert.ok(h.runs.length <= 5, `expected roughly one scan per ceiling, got ${h.runs.length}`);
  assert.ok(h.runs.length >= 3, `expected the ceiling to keep firing, got ${h.runs.length}`);
});

test('cancel stops a pending scan', () => {
  const h = harness();
  const schedule = createScheduler(() => h.runs.push('scan'), h.opts);
  schedule();
  schedule.cancel();
  h.advance(5000);
  assert.deepEqual(h.runs, []);
  assert.equal(h.scheduled, false);
});
