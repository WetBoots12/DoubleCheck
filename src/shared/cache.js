// A small time-limited cache for provider responses, so the same question is not
// paid for twice.
//
// Why this exists: search, fact-check and AI calls are the only parts of the
// extension that cost the user money or quota. Reading two articles about the same
// event, or re-opening a page, used to spend a fresh call on a claim that was just
// looked up. Nothing here changes when a call is made: a check still happens only
// when the user clicks. It changes what a click costs the second time.
//
// Everything is kept in chrome.storage.local on the user's machine and nothing is
// sent anywhere. Entries hold claim text, so the options page can switch this off
// and empty it.
//
// Pure logic with the storage area injected, so it runs under node --test with a
// plain object standing in for chrome.storage.local.

export const CACHE_PREFIX = 'fccache:';
export const INDEX_KEY = `${CACHE_PREFIX}index`;
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // a day: long enough for a news cycle
export const DEFAULT_MAX = 200;

// FNV-1a, twice with different offsets, to make a short key with enough spread that
// collisions are rare. A collision is not a correctness problem in any case: the
// full key is stored in the entry and compared on read, so a clash simply misses.
export function hashKey(text) {
  const s = String(text);
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x85ebca6b) >>> 0;
  }
  return `${a.toString(36)}${b.toString(36)}`;
}

// The identity of a request. Anything that would change the response has to be in
// here, or a cached answer would be served for a different question: the provider,
// the model, the query, and the options that shape the query.
export function cacheKey(kind, parts) {
  return `${kind}|${JSON.stringify(parts)}`;
}

export function createCache(storage, opts = {}) {
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const max = opts.max ?? DEFAULT_MAX;
  const now = opts.now || (() => Date.now());

  // Every index update is a read, a change and a write. Three provider calls
  // finishing together would each read the same index and write back their own
  // version of it, losing two of the three entries: the answers would sit in
  // storage with nothing pointing at them, invisible to eviction and to clearing.
  // So index updates queue behind one another. Only the index is serialised; the
  // entries themselves are written straight away, and reads never queue.
  let indexQueue = Promise.resolve();

  function serialize(work) {
    const next = indexQueue.then(work, work);
    indexQueue = next.then(() => {}, () => {});
    return next;
  }

  async function readIndex() {
    const got = await storage.get(INDEX_KEY);
    const list = got?.[INDEX_KEY];
    return Array.isArray(list) ? list : [];
  }

  // Most recent first. Anything past the cap is evicted, which makes this a plain
  // LRU with a time limit on top.
  async function writeIndex(list) {
    await storage.set({ [INDEX_KEY]: list.slice(0, max) });
  }

  async function get(key) {
    const id = CACHE_PREFIX + hashKey(key);
    const got = await storage.get(id);
    const entry = got?.[id];
    if (!entry) return null;
    if (entry.k !== key) return null; // hash collision: not our answer
    if (!(entry.exp > now())) {
      await remove([id]);
      return null;
    }
    return entry.v;
  }

  async function remove(ids) {
    if (!ids.length) return;
    await storage.remove(ids);
    return serialize(async () => {
      const keep = (await readIndex()).filter((i) => !ids.includes(i.id));
      await writeIndex(keep);
    });
  }

  async function set(key, value) {
    const id = CACHE_PREFIX + hashKey(key);
    await storage.set({ [id]: { k: key, v: value, exp: now() + ttl } });
    return serialize(async () => {
      const list = [{ id, at: now() }, ...(await readIndex()).filter((i) => i.id !== id)];
      const evicted = list.slice(max).map((i) => i.id);
      await writeIndex(list);
      if (evicted.length) await storage.remove(evicted);
    });
  }

  // The one call sites use: return what is stored, or run the work and store it.
  // A rejection is never cached, so a failed provider call can be retried at once.
  async function wrap(key, fn) {
    const hit = await get(key);
    if (hit !== null && hit !== undefined) return hit;
    const value = await fn();
    await set(key, value);
    return value;
  }

  // Drop everything, for the options page button and for switching caching off.
  // Swept by prefix rather than through the index, so that an entry the index lost
  // to a crash or an interrupted write is still deleted. Clearing has to mean
  // clearing: the entries hold the text of claims the user checked.
  async function clear() {
    return serialize(async () => {
      const all = await storage.get(null);
      const ids = Object.keys(all || {}).filter((k) => k.startsWith(CACHE_PREFIX));
      if (ids.length) await storage.remove(ids);
      await storage.remove(INDEX_KEY);
    });
  }

  // Which of these keys already have a live answer, in one read.
  //
  // The panel asks before the reader presses anything, so that a claim whose answer
  // is already remembered can say so and cost nothing. Per-key get() would be one
  // storage read per claim; storage.get takes a list, so this is one read for all of
  // them. Expired entries are reported as absent but not deleted here, because a
  // question about the cache should not quietly rewrite it.
  async function hasMany(keys) {
    const live = new Set();
    if (!keys.length) return live;
    const ids = keys.map((k) => CACHE_PREFIX + hashKey(k));
    const got = (await storage.get(ids)) || {};
    keys.forEach((key, i) => {
      const entry = got[ids[i]];
      if (entry && entry.k === key && entry.exp > now()) live.add(key);
    });
    return live;
  }

  async function size() {
    return (await readIndex()).length;
  }

  return { get, set, wrap, hasMany, clear, size };
}
