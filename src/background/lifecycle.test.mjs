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

const installHandlers = {};
let messageListener = null;
let menuClickListener = null;

globalThis.chrome = {
  storage: { session: fakeStorageArea(), local: fakeStorageArea() },
  contextMenus: {
    create: (_opts, cb) => { cb?.(); },
    onClicked: { addListener: (fn) => { menuClickListener = fn; } },
  },
  runtime: {
    // Captured rather than only invoked, so the install path can be driven with the
    // details the browser actually passes. Called once with no details first, which
    // is what every other test in this file needs and what creates the menu.
    onInstalled: { addListener: (fn) => { installHandlers.onInstalled = fn; fn(); } },
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

// --- a handler that fails still answers ----------------------------------------
//
// Returning true from an onMessage listener is a promise to reply. A handler that
// then rejects never does, and the sender waits until Chrome tears the channel down.
// In the panel that is a button that does nothing; in the content script it is worse,
// because the reply is what tells the page whether it may be read at all.

test('a message handler whose work fails still sends a reply, and it refuses', async () => {
  const realQuery = chrome.tabs.query;
  const realGet = chrome.storage.local.get;
  chrome.tabs.query = async () => { throw new Error('the tabs API is unavailable'); };
  chrome.storage.local.get = async () => { throw new Error('storage is unavailable'); };
  try {
    const panel = await send({ type: 'panelReady' }, undefined);
    assert.ok(panel, 'panelReady must answer rather than hang');
    assert.deepEqual(panel.claims, []);

    const state = await send({ type: 'getState' });
    assert.ok(state, 'getState must answer rather than hang');
    assert.equal(state.scanAllowed, false,
      'a page whose policy could not be read is a page that is not read');
  } finally {
    chrome.tabs.query = realQuery;
    chrome.storage.local.get = realGet;
  }
});


// --- a summary that never comes back -------------------------------------------
//
// The browser's built-in model only exists in a document, so the worker asks the
// side panel to run it and marks the claim as summarizing until an answer arrives.
// runCheck refuses to touch a claim while that flag is set, so anything that stops
// the answer coming leaves the claim's buttons dead. Closing the panel does exactly
// that: the document is destroyed, and nothing is left to reply.

test('a claim is not left summarizing for ever when the panel never answers', async () => {
  const claim = {
    id: 'c-stranded',
    text: 'The council raised the budget by 12 million dollars this year, records show.',
    status: 'checked',
    summarizing: true, // the panel was asked, then closed before it could answer
    results: [{ url: 'https://apnews.com/a', title: 'Budget report', snippet: 'x' }],
  };
  await chrome.storage.session.set({
    [`tab:${TAB}`]: { claims: { [claim.id]: claim }, seen: [] },
  });

  // The reader opens the panel again, which is the only way to see the claim at all.
  const panel = await send({ type: 'panelReady' }, undefined);
  const back = panel.claims.find((c) => c.id === claim.id);

  assert.ok(back, 'the claim should still be listed');
  assert.notEqual(back.summarizing, true,
    'a panel that has just opened cannot be running a summary from before it opened, '
    + 'so the claim must not still be waiting on one');
});

// --- incognito ------------------------------------------------------------------
//
// An extension runs in one shared worker across normal and incognito tabs unless it
// says otherwise, and the provider cache lives in chrome.storage.local, which
// outlives the incognito window and the browser itself. So a check run in incognito
// must leave nothing there, and the same check run normally must still be cached,
// or the fix would be "switch the cache off" wearing a disguise.

const CLAIM = 'Inflation reached 8.2 percent in the year to June, the statistics office reported.';

// A fresh tab id each time. tabStore keeps an in-memory cache keyed by tab, so
// writing to session storage under an id the worker has already touched is invisible
// to it, and the check would find no claim and quietly do nothing.
let nextTab = 100;

async function runCheckIn(incognito) {
  const tab = nextTab++;
  chrome.tabs.get = async (id) => ({ id, url: 'https://www.example.com/article', incognito });
  chrome.tabs.query = async () => [{ id: tab, url: 'https://www.example.com/article', incognito }];
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith('classifier/model/model.json')) {
      return { ok: true, json: async () => JSON.parse(readFileSync('classifier/model/model.json', 'utf8')) };
    }
    if (u.includes('wikipedia.org')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ pages: [{ key: 'Inflation', title: 'Inflation', description: 'Inflation reached 8.2 percent in June.' }] }),
      };
    }
    return { ok: false, status: 404, headers: { get: () => '' }, text: async () => '' };
  };

  await chrome.storage.local.set({
    fc_settings: { cacheResults: true, searchProvider: 'wikipedia', readSources: false, llmProvider: 'none' },
  });
  for (const k of Object.keys(await chrome.storage.local.get(null))) {
    if (k.startsWith('fccache:')) await chrome.storage.local.remove(k);
  }
  await chrome.storage.session.set({
    [`tab:${tab}`]: { claims: { c1: { id: 'c1', text: CLAIM, status: 'unchecked', score: 0.9 } }, seen: [] },
  });

  await send({ type: 'checkClaim', claimId: 'c1' }, undefined);
  await settle();
  await settle();

  return Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith('fccache:'));
}

test('a normal tab caches the answer, so the comparison below means something', async () => {
  const keys = await runCheckIn(false);
  assert.ok(keys.length > 0, 'a normal check should have written a cache entry');
});

test('an incognito tab writes nothing to the cache on disk', async () => {
  const keys = await runCheckIn(true);
  assert.deepEqual(keys, [],
    'a check run in incognito left a day-long record in storage.local, which outlives '
    + 'the incognito window and the browser');
});

// --- the four small things ------------------------------------------------------

test('the guide opens once on install, and not on an update', async () => {
  const opened = [];
  const realCreate = chrome.tabs.create;
  chrome.tabs.create = async (o) => { opened.push(o.url); };

  const { onInstalled } = installHandlers;
  onInstalled({ reason: 'update' });
  onInstalled({ reason: 'chrome_update' });
  assert.deepEqual(opened, [], 'an upgrade must not reopen the guide every time');

  onInstalled({ reason: 'install' });
  assert.equal(opened.length, 1, 'a first install should open the guide');
  assert.ok(opened[0].includes('options.html#guide'), opened[0]);

  chrome.tabs.create = realCreate;
});

test('a flagged claim says what made it look checkable', async () => {
  const tab = 200;
  chrome.tabs.get = async (id) => ({ id, url: 'https://www.example.com/article', incognito: false });
  chrome.tabs.query = async () => [{ id: tab, url: 'https://www.example.com/article', incognito: false }];
  await chrome.storage.local.set({ fc_settings: { threshold: 0.5, searchProvider: 'wikipedia' } });

  await send({
    type: 'sentences',
    sentences: [{ id: 's1', text: 'The Labor Department said unemployment fell to 4.2 percent in 2025, the lowest in decades.' }],
  }, tab);
  await settle();

  const { claims } = await send({ type: 'panelReady' }, undefined);
  const claim = claims.find((c) => c.id === 's1');
  assert.ok(claim, 'the sentence should have been flagged');
  assert.ok(Array.isArray(claim.signals) && claim.signals.length,
    'a score with no explanation is an oracle');
  assert.ok(claim.signals.every((sig) => typeof sig === 'string' && sig.length > 2), JSON.stringify(claim.signals));
});

test('a claim whose answer is already stored is marked free before anything is pressed', async () => {
  // The whole design is that the reader decides when to spend. Which means they have
  // to be told when there is nothing to spend, before they decide.
  const first = await runCheckIn(false);
  assert.ok(first.length > 0, 'the first check should have stored an answer');

  // A second tab, same claim, same settings: the stored answer applies to it too.
  const tab = nextTab++;
  chrome.tabs.get = async (id) => ({ id, url: 'https://www.example.com/article', incognito: false });
  chrome.tabs.query = async () => [{ id: tab, url: 'https://www.example.com/article', incognito: false }];
  await chrome.storage.session.set({
    [`tab:${tab}`]: { claims: { c1: { id: 'c1', text: CLAIM, status: 'unchecked', score: 0.9 } }, seen: [] },
  });

  const { claims } = await send({ type: 'panelReady' }, undefined);
  assert.equal(claims.find((c) => c.id === 'c1')?.cached, true,
    'the panel was not told the answer is already saved');
});

test('the free-answer flag is a view of the cache, not something written to the claim', async () => {
  const tab = nextTab++;
  chrome.tabs.query = async () => [{ id: tab, url: 'https://www.example.com/article', incognito: false }];
  await chrome.storage.session.set({
    [`tab:${tab}`]: { claims: { c1: { id: 'c1', text: 'Something never looked up at all.', status: 'unchecked' } }, seen: [] },
  });

  await send({ type: 'panelReady' }, undefined);
  const raw = (await chrome.storage.session.get(`tab:${tab}`))[`tab:${tab}`];
  assert.equal('cached' in raw.claims.c1, false,
    'what is true of the cache right now must not be saved as though it were true of the claim');
});
