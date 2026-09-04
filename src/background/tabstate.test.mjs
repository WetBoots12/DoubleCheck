import test from 'node:test';
import assert from 'node:assert/strict';

import { createTabStore } from './tabstate.js';

// Mimics chrome.storage.session closely enough: get(key|null), set(obj), remove(key).
function fakeStorage() {
  const data = new Map();
  return {
    data,
    async get(key) {
      if (key === null) return Object.fromEntries(data);
      return data.has(key) ? { [key]: structuredClone(data.get(key)) } : {};
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) data.set(k, structuredClone(v));
    },
    async remove(key) {
      data.delete(key);
    },
  };
}

test('get creates an empty state and peek does not', async () => {
  const store = createTabStore(fakeStorage());
  assert.equal(await store.peek(7), null);
  const s = await store.get(7);
  assert.equal(s.claims.size, 0);
  assert.equal(s.seen.size, 0);
  assert.equal(await store.peek(7), s);
});

// The whole point: a new store over the same storage is what a restarted worker sees.
test('state survives a simulated service worker restart', async () => {
  const storage = fakeStorage();
  const before = createTabStore(storage);
  const s = await before.get(1);
  s.claims.set('c1', { id: 'c1', text: 'Costs rose 30 percent.', status: 'unchecked', score: 0.9 });
  s.seen.add('costs rose 30 percent.');
  await before.save(1);

  const after = createTabStore(storage); // fresh cache, same storage
  const restored = await after.peek(1);
  assert.ok(restored);
  assert.equal(restored.claims.get('c1').text, 'Costs rose 30 percent.');
  assert.ok(restored.seen.has('costs rose 30 percent.'));
  assert.ok(restored.claims instanceof Map);
  assert.ok(restored.seen instanceof Set);
});

test('mutations are not visible across a restart until saved', async () => {
  const storage = fakeStorage();
  const a = createTabStore(storage);
  const s = await a.get(2);
  s.claims.set('x', { id: 'x' });
  // no save
  assert.equal(await createTabStore(storage).peek(2), null);
});

test('clear removes the tab from cache and storage', async () => {
  const storage = fakeStorage();
  const store = createTabStore(storage);
  (await store.get(3)).claims.set('x', { id: 'x' });
  await store.save(3);
  await store.clear(3);
  assert.equal(await store.peek(3), null);
  assert.equal(await createTabStore(storage).peek(3), null);
});

test('tabs are isolated from one another', async () => {
  const store = createTabStore(fakeStorage());
  (await store.get(1)).claims.set('a', { id: 'a' });
  (await store.get(2)).claims.set('b', { id: 'b' });
  await store.save(1);
  await store.save(2);
  assert.deepEqual([...(await store.peek(1)).claims.keys()], ['a']);
  assert.deepEqual([...(await store.peek(2)).claims.keys()], ['b']);
});

test('recoverStale resets pending and summarizing claims left by a dead worker', async () => {
  const storage = fakeStorage();
  const before = createTabStore(storage);
  const s = await before.get(4);
  s.claims.set('p', { id: 'p', status: 'pending' });
  s.claims.set('q', { id: 'q', status: 'checked', summarizing: true });
  s.claims.set('ok', { id: 'ok', status: 'checked' });
  await before.save(4);

  const after = createTabStore(storage);
  const touched = await after.recoverStale();
  assert.equal(touched, 1);

  const st = await after.peek(4);
  assert.equal(st.claims.get('p').status, 'unchecked');
  assert.match(st.claims.get('p').error, /interrupted/i);
  assert.equal(st.claims.get('q').summarizing, false);
  assert.equal(st.claims.get('q').status, 'checked');
  assert.equal(st.claims.get('ok').status, 'checked');
});

test('recoverStale ignores keys that are not tab state', async () => {
  const storage = fakeStorage();
  await storage.set({ unrelated: { claims: { z: { status: 'pending' } } } });
  const store = createTabStore(storage);
  assert.equal(await store.recoverStale(), 0);
  assert.equal((await storage.get('unrelated')).unrelated.claims.z.status, 'pending');
});
