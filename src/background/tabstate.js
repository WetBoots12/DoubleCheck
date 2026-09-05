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

// How many judged sentences a tab remembers.
//
// seen exists so a sentence is not scored twice, and it holds the sentence itself.
// On an ordinary article it never reaches a few hundred. On an infinite feed it
// grows for as long as the reader scrolls, and because the whole state is written
// on every save, each save costs more than the one before it. Measured: 8,000
// remembered sentences made twenty saves write 9.5 MB, into a session store whose
// entire quota is ten. Every read pays it again, and the badge alone reads on each
// tab switch.
//
// Dropping the oldest is the right trade. The cost of forgetting one is that a
// sentence scrolled past long ago might be scored a second time if the reader
// scrolls back to it, which costs nothing the user can see and no network call.
const MAX_SEEN = 3000;

function pruneSeen(state) {
  if (state.seen.size <= MAX_SEEN) return;
  // A Set iterates in insertion order, so the tail is what was read most recently.
  const keep = [...state.seen].slice(-MAX_SEEN);
  state.seen.clear();
  for (const k of keep) state.seen.add(k);
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
    pruneSeen(state);
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

// --- tabs the page itself reported as private ----------------------------------
//
// A password or card field marks a page private whatever its address says, and only
// the content script can see one. That report has to outlive the moment it arrived,
// and "the moment" includes the worker being put to sleep thirty seconds later. Held
// in a plain Set, the report died with the worker and the tab quietly became
// scannable again: the content script re-checks the form on every pass and so stayed
// correct, but the right-click menu talks to the worker directly and would have
// accepted a selection from the page.
//
// Kept under its own key rather than inside the tab's claim state, because reporting
// a private page clears that state and the marker must survive exactly that.

const PRIVATE_PREFIX = 'private:';

export function createPrivateTabs(storage) {
  const known = new Set(); // read cache; the session store is the real answer

  const keyFor = (tabId) => `${PRIVATE_PREFIX}${tabId}`;

  // Marks in memory before it awaits, so a message arriving in the same turn as the
  // report already sees the tab as private.
  async function mark(tabId) {
    known.add(tabId);
    await storage.set({ [keyFor(tabId)]: true });
  }

  async function has(tabId) {
    if (tabId == null) return false;
    if (known.has(tabId)) return true;
    const key = keyFor(tabId);
    const stored = await storage.get(key);
    if (!stored?.[key]) return false;
    known.add(tabId);
    return true;
  }

  // The tab navigated or closed: a new page is judged on its own merits.
  async function forget(tabId) {
    known.delete(tabId);
    await storage.remove(keyFor(tabId));
  }

  return { mark, has, forget };
}

function memoryArea() {
  const data = new Map();
  return {
    async get(key) {
      if (key == null) return Object.fromEntries(data);
      const out = {};
      for (const k of (Array.isArray(key) ? key : [key])) if (data.has(k)) out[k] = data.get(k);
      return out;
    },
    async set(obj) { for (const [k, v] of Object.entries(obj)) data.set(k, v); },
    async remove(key) { for (const k of (Array.isArray(key) ? key : [key])) data.delete(k); },
  };
}

// Falls back to memory rather than to null: this is a privacy control, and a module
// that fails to load takes the guard with it.
export const privateTabs = createPrivateTabs(
  typeof chrome !== 'undefined' && chrome.storage?.session ? chrome.storage.session : memoryArea(),
);

// The real store. chrome.storage.session is absent outside an extension context,
// which is why tests build their own via createTabStore.
export const tabStore =
  typeof chrome !== 'undefined' && chrome.storage?.session
    ? createTabStore(chrome.storage.session)
    : null;
