// Per-tab claim state that survives the service worker being put to sleep.
//
// Manifest V3 terminates an idle worker after roughly thirty seconds. State kept
// only in a JavaScript Map vanished with it: a user who read for a minute and then
// pressed "Check sources" found the claim gone and the button dead. This keeps the
// same in-memory shape for speed, but writes through to chrome.storage.session,
// which lives for the browser session, survives worker restarts, and is cleared
// when the browser closes, so nothing about a page outlives the session.
//
// The storage area is injected so tests can substitute an in-memory fake.

const KEY_PREFIX = 'tab:';

function keyFor(tabId) {
  return `${KEY_PREFIX}${tabId}`;
}

// Storage holds plain JSON; the worker works with a Map and a Set.
function serialize(state) {
  return {
    claims: Object.fromEntries(state.claims),
    seen: [...state.seen],
  };
}

function deserialize(raw) {
  return {
    claims: new Map(Object.entries(raw?.claims || {})),
    seen: new Set(raw?.seen || []),
  };
}

function emptyState() {
  return { claims: new Map(), seen: new Set() };
}

export function createTabStore(storage) {
  const cache = new Map(); // tabId -> state, hydrated lazily from storage

  // Returns the tab's state, creating an empty one if none exists anywhere.
  async function get(tabId) {
    const existing = await peek(tabId);
    if (existing) return existing;
    const fresh = emptyState();
    cache.set(tabId, fresh);
    return fresh;
  }

  // Returns the tab's state or null, never creating one. For badge and panel
  // reads, where an absent tab must not be conjured into existence.
  async function peek(tabId) {
    if (cache.has(tabId)) return cache.get(tabId);
    const key = keyFor(tabId);
    const stored = await storage.get(key);
    if (!stored || !stored[key]) return null;
    const state = deserialize(stored[key]);
    cache.set(tabId, state);
    return state;
  }

  // Persists the cached state. Call after every mutation; storage.session is
  // memory-backed, so this is cheap enough to do liberally.
  async function save(tabId) {
    const state = cache.get(tabId);
    if (!state) return;
    await storage.set({ [keyFor(tabId)]: serialize(state) });
  }

  async function clear(tabId) {
    cache.delete(tabId);
    await storage.remove(keyFor(tabId));
  }

  // A worker that died mid-check leaves claims marked pending or summarizing with
  // nothing running to finish them. Run once at worker startup to put those back
  // to a state the user can act on.
  async function recoverStale() {
    const all = await storage.get(null);
    let touched = 0;
    for (const [key, raw] of Object.entries(all || {})) {
      if (!key.startsWith(KEY_PREFIX)) continue;
      let dirty = false;
      for (const claim of Object.values(raw?.claims || {})) {
        if (claim.status === 'pending') {
          claim.status = 'unchecked';
          claim.error = 'Interrupted before it finished. Try again.';
          dirty = true;
        }
        if (claim.summarizing) {
          claim.summarizing = false;
          dirty = true;
        }
      }
      if (dirty) {
        await storage.set({ [key]: raw });
        touched++;
      }
    }
    cache.clear(); // force re-hydration so callers see the recovered values
    return touched;
  }

  return { get, peek, save, clear, recoverStale };
}

// The real store. chrome.storage.session is absent outside an extension context,
// which is why tests build their own via createTabStore.
export const tabStore =
  typeof chrome !== 'undefined' && chrome.storage?.session
    ? createTabStore(chrome.storage.session)
    : null;
