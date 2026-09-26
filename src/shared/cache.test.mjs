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

// A storage area where every operation takes a turn to complete, which is what
// makes the read-modify-write of the index overlappable.
function slowStorage(base) {
  const tick = () => new Promise((r) => setTimeout(r, 1));
  return {
    data: base.data,
    async get(k) { await tick(); return base.get(k); },
    async set(o) { await tick(); return base.set(o); },
    async remove(k) { await tick(); return base.remove(k); },
  };
}

test('answers written at the same moment all survive in the index', async () => {
  // Check sources fires search, fact-checks and scholar together, and all three
  // land at once. Each index update is a read, a change and a write, so without
  // ordering the last writer wins and the other two answers are orphaned.
  const s = fakeStorage();
  const c = createCache(slowStorage(s));
  await Promise.all([
    c.set('search|q', ['s']),
    c.set('factcheck|q', ['f']),
    c.set('scholar|q', ['a']),
  ]);

  assert.equal(await c.size(), 3, 'all three should be indexed');
  assert.deepEqual(await c.get('search|q'), ['s']);
  assert.deepEqual(await c.get('factcheck|q'), ['f']);
  assert.deepEqual(await c.get('scholar|q'), ['a']);
});

test('concurrent writes past the cap still evict, leaving nothing stranded', async () => {
  const s = fakeStorage();
  const c = createCache(slowStorage(s), { max: 3 });
  await Promise.all(['a', 'b', 'c', 'd', 'e'].map((k) => c.set(k, [k])));
  const stored = [...s.data.keys()].filter((k) => k.startsWith(CACHE_PREFIX) && k !== INDEX_KEY);
  assert.equal(await c.size(), 3);
  assert.equal(stored.length, 3, `storage should hold only what the index knows about, found ${stored.length}`);
});

test('clearing removes entries the index lost track of', async () => {
  const s = fakeStorage();
  const c = createCache(s);
  await c.set('kept', ['v']);
  // An entry orphaned by an interrupted write: present in storage, absent from
  // the index. Clearing must still mean cleared, because entries hold claim text.
  s.data.set(`${CACHE_PREFIX}orphan`, { k: 'orphan', v: ['old'], exp: Date.now() + 1000 });
  s.data.set('fc_settings', { autoCheck: true });

  await c.clear();

  const left = [...s.data.keys()].filter((k) => k.startsWith(CACHE_PREFIX));
  assert.deepEqual(left, [], `nothing of the cache should remain, found ${left}`);
  assert.ok(s.data.has('fc_settings'), 'settings must survive');
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

// --- asking what is already remembered ------------------------------------------
//
// The panel asks before the reader presses anything, so a claim whose answer is
// already stored can say so and cost nothing.

test('hasMany reports which keys have a live answer, in a single read', async () => {
  let reads = 0;
  const area = fakeStorage();
  const counted = { ...area, get: (k) => { reads++; return area.get(k); } };
  const cache = createCache(counted);

  await cache.set('search|a', ['one']);
  await cache.set('search|b', ['two']);
  reads = 0;

  const live = await cache.hasMany(['search|a', 'search|b', 'search|never-asked']);
  assert.deepEqual([...live].sort(), ['search|a', 'search|b']);
  assert.equal(reads, 1, 'one read for every key, not one read per key');
});

test('hasMany treats an expired answer as absent, and does not delete it', async () => {
  let clock = 1000;
  const area = fakeStorage();
  const cache = createCache(area, { ttlMs: 100, now: () => clock });
  await cache.set('search|a', ['one']);

  clock += 500;
  assert.deepEqual([...await cache.hasMany(['search|a'])], [],
    'an expired answer is not an answer');
  assert.equal(await cache.size(), 1,
    'asking what is remembered must not quietly rewrite what is remembered');
});

test('hasMany on nothing asks storage nothing', async () => {
  const cache = createCache(fakeStorage());
  assert.deepEqual([...await cache.hasMany([])], []);
});


test('a sweep removes expired orphan and indexed records without another read', async () => {
  const storage = fakeStorage();
  const clock = { t: 0 };
  const cache = createCache(storage, { ttlMs: 100, now: at(clock) });
  await cache.set('old', 'private claim');
  await storage.set({ 'fccache:orphan': { exp: 100, v: 'orphaned claim' } });
  clock.t = 101;
  await cache.sweep();
  assert.deepEqual([...storage.data.keys()].filter((k) => k !== INDEX_KEY), []);
  assert.equal(await cache.size(), 0);
});

test('clearing during a request prevents its late response repopulating the cache', async () => {
  const storage = fakeStorage();
  const cache = createCache(storage);
  let release;
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const pending = cache.wrap('claim', () => { started(); return new Promise((resolve) => { release = resolve; }); });
  await ready;
  await cache.clear();
  release('late answer');
  assert.equal(await pending, 'late answer');
  assert.equal(await cache.get('claim'), null);
});

test('writes sweep the whole store at most once per interval, and again once it has passed', async () => {
  const storage = fakeStorage();
  let wholeReads = 0;
  const get = storage.get.bind(storage);
  storage.get = (key) => { if (key == null) wholeReads++; return get(key); };
  const clock = { t: 0 };
  const cache = createCache(storage, { ttlMs: 100, sweepEveryMs: 1000, now: at(clock) });
  for (let i = 0; i < 6; i++) await cache.set(`search|${i}`, i); // one check's worth of writes
  assert.equal(wholeReads, 1, 'a burst of writes sweeps once');

  clock.t = 1500; // every entry above has expired, and the interval has passed
  await cache.set('search|later', 'x');
  assert.equal(wholeReads, 2);
  assert.deepEqual([...storage.data.keys()].filter((k) => k !== INDEX_KEY).length, 1, 'the expired entries are gone');
});
