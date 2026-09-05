// What survives the service worker being put to sleep.
//
// Manifest V3 evicts an idle worker after about thirty seconds and starts a fresh
// one on the next event. Everything held in a module-level variable is gone at that
// point; only chrome.storage survives. A restart is modelled here by importing the
// worker a second time under a different specifier, which gives a genuinely new
// module instance while the fake chrome, and so the storage behind it, stays put.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// --- fake chrome ---------------------------------------------------------------

function fakeStorageArea() {
  const data = new Map();
  return {
    async get(key) {
      if (key === null || key === undefined) return Object.fromEntries(data);
      const out = {};
      for (const k of (Array.isArray(key) ? key : [key])) {
        if (data.has(k)) out[k] = structuredClone(data.get(k));
      }
      return out;
    },
    async set(obj) { for (const [k, v] of Object.entries(obj)) data.set(k, structuredClone(v)); },
    async remove(key) { for (const k of (Array.isArray(key) ? key : [key])) data.delete(k); },
  };
}

const TAB = 7;

// A page whose address gives nothing away, and which evaluateUrl therefore allows:
// no sensitive domain, no keyword label in the host, no keyword segment in the path.
// A local paper's article, on which the reader hit a paywall and a sign-in form
// appeared in place of the rest of the story. The only thing marking this page
// private is the password field the content script found, which is exactly the case
// the URL rules cannot cover, and exactly why the report has to be remembered.
const PRIVATE_PAGE = 'https://www.riverbendgazette.example/2026/03/city-budget-vote';

let messageListener = null;
let menuClickListener = null;

globalThis.chrome = {
  storage: { session: fakeStorageArea(), local: fakeStorageArea() },
  contextMenus: {
    create: (_opts, cb) => { cb?.(); },
    onClicked: { addListener: (fn) => { menuClickListener = fn; } },
  },
  runtime: {
    onInstalled: { addListener: (fn) => { fn(); } },
    onMessage: { addListener: (fn) => { messageListener = fn; } },
    sendMessage: async () => {},
    getURL: (p) => `chrome-extension://fake/${p}`,
  },
  tabs: {
    onRemoved: { addListener() {} },
    onUpdated: { addListener() {} },
    onActivated: { addListener() {} },
    query: async () => [{ id: TAB, url: PRIVATE_PAGE }],
    get: async (id) => ({ id, url: PRIVATE_PAGE }),
    sendMessage: async () => {},
  },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  sidePanel: { setPanelBehavior: async () => {}, open: async () => {} },
  commands: { onCommand: { addListener() {} } },
  search: { query: async () => {} },
};

globalThis.fetch = async (url) => {
  if (String(url).endsWith('classifier/model/model.json')) {
    return { ok: true, json: async () => JSON.parse(readFileSync('classifier/model/model.json', 'utf8')) };
  }
  throw new Error(`the worker must not reach the network here: ${url}`);
};

function send(msg, tabId = TAB) {
  return new Promise((resolve) => {
    const keep = messageListener(msg, { tab: { id: tabId } }, resolve);
    if (!keep) resolve(undefined);
  });
}

const settle = () => new Promise((r) => setTimeout(r, 40));

const SELECTION = 'The account balance fell by 4,200 dollars during March, the statement shows.';

function rightClick() {
  menuClickListener({ menuItemId: 'fc-check-selection', selectionText: SELECTION }, { id: TAB });
}

async function claimCount() {
  const res = await send({ type: 'panelReady' }, undefined);
  return res.claims.length;
}

// --- the first worker ----------------------------------------------------------

await import('./index.js');

test('the page reports a password field, and the right-click menu is refused', async () => {
  await send({ type: 'pagePrivate', reason: 'fields' });
  await settle();

  rightClick();
  await settle();

  assert.equal(await claimCount(), 0,
    'a selection on a page holding a password field must not become a claim');
});

// --- the worker is evicted, and a new one starts -------------------------------

test('the tab is still private after the worker has been evicted and restarted', async () => {
  // Nothing about the tab changed: same id, same address, same password field on it.
  // Only the worker went away, which Manifest V3 does on its own after a short idle.
  await import('./index.js?restarted');
  await settle();

  rightClick();
  await settle();

  assert.equal(await claimCount(), 0,
    'a tab that reported a password field must stay blocked for the life of that tab, '
    + 'and the worker being put to sleep is not the tab going away');
});
