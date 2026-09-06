// The reader's works cited list, on disk.
//
// chrome.storage.local, because this is the one thing in the extension meant to
// outlive a browser session: a bibliography built over days is no use if it dies
// when the window closes. It never leaves the machine, no website can read it, and
// it is cleared by the reader or by removing the extension.
//
// Writes are queued for the same reason settings writes are. A save is a read, a
// change and a write, and the options page and the side panel can both be open. Two
// sources added at once would otherwise cost one of them.
//
// The storage area is injected so tests can substitute an in-memory fake.

import { addSource, removeSource, SOURCE_LIMIT } from '../shared/sources.js';

export const SOURCES_KEY = 'fc_sources';

export function createSourceStore(storage) {
  let queue = Promise.resolve();

  // Each change reads only after the one before it has written.
  function serialize(work) {
    const next = queue.then(work, work);
    queue = next.then(() => {}, () => {});
    return next;
  }

  async function list() {
    try {
      const got = await storage.get(SOURCES_KEY);
      const stored = got?.[SOURCES_KEY];
      return Array.isArray(stored) ? stored : [];
    } catch {
      return []; // an unreadable list is an empty one, never a thrown error mid-press
    }
  }

  async function add(record) {
    return serialize(async () => {
      const current = await list();
      const result = addSource(current, record, SOURCE_LIMIT);
      if (result.added) await storage.set({ [SOURCES_KEY]: result.list });
      return result;
    });
  }

  async function remove(key) {
    return serialize(async () => {
      const next = removeSource(await list(), key);
      await storage.set({ [SOURCES_KEY]: next });
      return next;
    });
  }

  async function clear() {
    return serialize(async () => {
      await storage.remove(SOURCES_KEY);
      return [];
    });
  }

  return { list, add, remove, clear };
}

function memoryArea() {
  const data = new Map();
  return {
    async get(key) { return data.has(key) ? { [key]: data.get(key) } : {}; },
    async set(obj) { for (const [k, v] of Object.entries(obj)) data.set(k, v); },
    async remove(key) { data.delete(key); },
  };
}

// Falls back to memory rather than to null, so importing this module somewhere
// without a full chrome stub does not throw at load.
export const sourceStore = createSourceStore(
  typeof chrome !== 'undefined' && chrome.storage?.local ? chrome.storage.local : memoryArea(),
);
