import test from 'node:test';
import assert from 'node:assert/strict';

import { createCache, cacheKey, hashKey, CACHE_PREFIX, INDEX_KEY } from './cache.js';

// Stands in for chrome.storage.local, with the same promise-returning shape.
function fakeStorage() {
  const data = new Map();
  return {
    data,
    async get(key) {
      if (key === null || key === undefined) return Object.fromEntries(data);
      const keys = Array.isArray(key) ? key : [key];
      const out = {};
      for (const k of keys) if (data.has(k)) out[k] = data.get(k);
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) data.set(k, v);
    },
    async remove(key) {
      for (const k of (Array.isArray(key) ? key : [key])) data.delete(k);
    },
  };
}

function at(clock) {
  return () => clock.t;
}

test('a stored value comes back, and a different question does not hit it', async () => {
  const s = fakeStorage();
  const c = createCache(s);
  await c.set(cacheKey('search', ['brave', 'is the sky blue']), [{ title: 'Sky' }]);
  assert.deepEqual(await c.get(cacheKey('search', ['brave', 'is the sky blue'])), [{ title: 'Sky' }]);
  assert.equal(await c.get(cacheKey('search', ['brave', 'is the sea blue'])), null);
  // Same query, different provider or mode, is a different question.
  assert.equal(await c.get(cacheKey('search', ['serpapi', 'is the sky blue'])), null);
  assert.equal(await c.get(cacheKey('factcheck', ['brave', 'is the sky blue'])), null);
});

test('an entry expires once the time limit passes, and is removed when read', async () => {
  const s = fakeStorage();
  const clock = { t: 1_000 };
  const c = createCache(s, { ttlMs: 100, now: at(clock) });
  const key = cacheKey('search', ['brave', 'q']);
  await c.set(key, ['hit']);

  clock.t = 1_099;
  assert.deepEqual(await c.get(key), ['hit']);

  clock.t = 1_101;
  assert.equal(await c.get(key), null);
  assert.equal(await c.size(), 0, 'the expired entry should not be left behind');
  assert.equal([...s.data.keys()].filter((k) => k.startsWith(CACHE_PREFIX) && k !== INDEX_KEY).length, 0);
});

test('wrap runs the work once and serves the stored answer after that', async () => {
  const s = fakeStorage();
  const c = createCache(s);
  let calls = 0;
  const work = async () => { calls++; return ['result']; };

  assert.deepEqual(await c.wrap('k', work), ['result']);
  assert.deepEqual(await c.wrap('k', work), ['result']);
  assert.equal(calls, 1, 'the provider should have been called once');
});

test('a failing call is not cached, so it can be retried immediately', async () => {
  const s = fakeStorage();
  const c = createCache(s);
  await assert.rejects(c.wrap('k', async () => { throw new Error('rate limited'); }));
  let calls = 0;
  assert.deepEqual(await c.wrap('k', async () => { calls++; return ['ok']; }), ['ok']);
  assert.equal(calls, 1);
});

test('an empty result is still a real answer and is not re-fetched', async () => {
  const s = fakeStorage();
  const c = createCache(s);
  let calls = 0;
  const work = async () => { calls++; return []; };
  await c.wrap('k', work);
  await c.wrap('k', work);
  assert.equal(calls, 1, 'no results is an answer worth remembering');
});

test('the oldest entries are evicted once the cap is reached', async () => {
  const s = fakeStorage();
  const clock = { t: 0 };
  const c = createCache(s, { max: 3, now: at(clock) });
  for (const q of ['a', 'b', 'c', 'd']) {
    clock.t += 10;
    await c.set(q, [q]);
  }
  assert.equal(await c.size(), 3);
  assert.equal(await c.get('a'), null, 'the oldest should have been evicted');
  assert.deepEqual(await c.get('d'), ['d']);
  const stored = [...s.data.keys()].filter((k) => k.startsWith(CACHE_PREFIX) && k !== INDEX_KEY);
  assert.equal(stored.length, 3, 'evicted entries must not linger in storage');
});

test('re-writing a key keeps one entry, not two', async () => {
  const s = fakeStorage();
  const c = createCache(s);
  await c.set('k', ['first']);
  await c.set('k', ['second']);
  assert.equal(await c.size(), 1);
  assert.deepEqual(await c.get('k'), ['second']);
});

test('clear empties everything the cache owns and nothing else', async () => {
  const s = fakeStorage();
  s.data.set('fc_settings', { autoCheck: true });
  const c = createCache(s);
  await c.set('a', [1]);
  await c.set('b', [2]);
  await c.clear();
  assert.equal(await c.size(), 0);
  assert.equal(await c.get('a'), null);
  assert.deepEqual(s.data.get('fc_settings'), { autoCheck: true }, 'settings must survive');
});

test('a hash collision misses rather than serving the wrong answer', async () => {
  const s = fakeStorage();
  const c = createCache(s);
  await c.set('real key', ['right']);
  // Forge an entry under the same slot with a different question.
  s.data.set(CACHE_PREFIX + hashKey('real key'), { k: 'other key', v: ['wrong'], exp: Date.now() + 1000 });
  assert.equal(await c.get('real key'), null);
});

test('hashKey is deterministic and spreads similar strings apart', () => {
  assert.equal(hashKey('abc'), hashKey('abc'));
  assert.notEqual(hashKey('abc'), hashKey('abd'));
  assert.notEqual(hashKey(''), hashKey('a'));
});

test('cacheKey is order-stable and readable', () => {
  assert.equal(cacheKey('search', ['brave', 'q']), 'search|["brave","q"]');
  assert.notEqual(cacheKey('search', ['brave', 'q']), cacheKey('search', ['q', 'brave']));
});
