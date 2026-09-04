// End-to-end test of the service worker against a fake chrome API: sentences in,
// panel update and highlights out. This is the message chain that a browser
// regression breaks silently, so it is worth exercising outside the browser.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// --- fake chrome ---------------------------------------------------------------

function fakeStorageArea() {
  const data = new Map();
  return {
    async get(key) {
      if (key === null) return Object.fromEntries(data);
      return data.has(key) ? { [key]: structuredClone(data.get(key)) } : {};
    },
    async set(obj) { for (const [k, v] of Object.entries(obj)) data.set(k, structuredClone(v)); },
    async remove(key) { data.delete(key); },
    _data: data,
  };
}

const sent = { runtime: [], tabs: [], badge: [] };
let messageListener = null;
let menuClickListener = null;
const ACTIVE_TAB = 1;

globalThis.chrome = {
  storage: { session: fakeStorageArea(), local: fakeStorageArea() },
  contextMenus: {
    create: (_opts, cb) => { cb?.(); },
    onClicked: { addListener: (fn) => { menuClickListener = fn; } },
  },
  runtime: {
    onInstalled: { addListener: (fn) => { fn(); } },
    onMessage: { addListener: (fn) => { messageListener = fn; } },
    sendMessage: async (msg) => { sent.runtime.push(msg); },
    getURL: (p) => `chrome-extension://fake/${p}`,
  },
  tabs: {
    onRemoved: { addListener() {} },
    onUpdated: { addListener() {} },
    onActivated: { addListener() {} },
    query: async () => [{ id: ACTIVE_TAB, url: 'https://www.example.com/article' }],
    get: async (id) => ({ id, url: 'https://www.example.com/article' }),
    sendMessage: async (tabId, msg) => { sent.tabs.push({ tabId, msg }); },
  },
  action: {
    setBadgeText: async (o) => { sent.badge.push(o); },
    setBadgeBackgroundColor: async () => {},
  },
  sidePanel: { setPanelBehavior: async () => {}, open: async () => {} },
  commands: { onCommand: { addListener() {} } },
};

// The classifier fetches its model through chrome.runtime.getURL; serve it from disk
// so the real trained model is what scores the sentences.
globalThis.fetch = async (url) => {
  if (String(url).endsWith('classifier/model/model.json')) {
    return { ok: true, json: async () => JSON.parse(readFileSync('classifier/model/model.json', 'utf8')) };
  }
  throw new Error(`unexpected fetch ${url}`);
};

const settle = () => new Promise((r) => setTimeout(r, 50));

function send(msg, tabId = ACTIVE_TAB) {
  return new Promise((resolve) => {
    const keep = messageListener(msg, { tab: { id: tabId } }, resolve);
    if (!keep) resolve(undefined);
  });
}

await import('./index.js');

// --- tests ---------------------------------------------------------------------

test('the worker registered a message listener', () => {
  assert.equal(typeof messageListener, 'function');
});

test('a batch of sentences produces flagged claims, a panel update, highlights and a badge', async () => {
  sent.runtime.length = 0; sent.tabs.length = 0; sent.badge.length = 0;

  await send({
    type: 'sentences',
    sentences: [
      { id: 's1', text: 'Unemployment fell to 4.2 percent last quarter, according to the Labor Department.' },
      { id: 's2', text: 'The company reported record revenue of 5 billion dollars in 2023.' },
      { id: 's3', text: 'Thanks so much for reading, and let us know what you think in the comments below.' },
    ],
  });
  await settle();

  const panel = sent.runtime.filter((m) => m.type === 'panelUpdate');
  assert.ok(panel.length >= 1, 'no panelUpdate was sent');
  const claims = panel.at(-1).claims;
  assert.ok(claims.length >= 2, `expected the two factual sentences flagged, got ${claims.length}`);
  assert.ok(claims.every((c) => c.status === 'unchecked' || c.status === 'noKey'));
  assert.ok(!claims.some((c) => c.id === 's3'), 'the chatter sentence must not be flagged');

  const hl = sent.tabs.find((m) => m.msg.type === 'claimStatus');
  assert.ok(hl, 'no claimStatus highlight message was sent to the tab');
  assert.equal(hl.tabId, ACTIVE_TAB);

  const badge = sent.badge.at(-1);
  assert.equal(badge.text, String(claims.length));
});

test('the claims are persisted in storage.session, not only in memory', async () => {
  const stored = chrome.storage.session._data.get(`tab:${ACTIVE_TAB}`);
  assert.ok(stored, 'nothing written to storage.session for the tab');
  assert.ok(Object.keys(stored.claims).length >= 2);
});

test('PANEL_READY returns the persisted claims for the active tab', async () => {
  const res = await send({ type: 'panelReady' }, undefined);
  assert.equal(res.tabId, ACTIVE_TAB);
  assert.ok(res.claims.length >= 2);
});

test('a context-menu click adds the selection as a user claim, bypassing the threshold', async () => {
  const before = (await send({ type: 'panelReady' }, undefined)).claims.length;
  const selection = 'Thanks so much for reading, and let us know what you think in the comments below.';
  // That sentence scored below the threshold earlier in this file; the user overrides that.
  menuClickListener({ menuItemId: 'fc-check-selection', selectionText: selection }, { id: ACTIVE_TAB });
  await settle();

  const claims = (await send({ type: 'panelReady' }, undefined)).claims;
  assert.equal(claims.length, before + 1);
  const added = claims.find((c) => c.userAdded);
  assert.ok(added, 'no userAdded claim found');
  assert.equal(added.text, selection);
  assert.equal(added.score, null);
  assert.ok(sent.tabs.some((m) => m.msg.type === 'claimStatus' && m.msg.claims.some((c) => c.id === added.id)),
    'the page was not asked to highlight the added claim');
});

test('clicking the menu on text that is already a claim does not duplicate it', async () => {
  const before = (await send({ type: 'panelReady' }, undefined)).claims.length;
  menuClickListener({ menuItemId: 'fc-check-selection', selectionText: 'Thanks so much for reading, and let us know what you think in the comments below.' }, { id: ACTIVE_TAB });
  await settle();
  assert.equal((await send({ type: 'panelReady' }, undefined)).claims.length, before);
});

test('a click on the wrong menu item or a tiny selection is ignored', async () => {
  const before = (await send({ type: 'panelReady' }, undefined)).claims.length;
  menuClickListener({ menuItemId: 'something-else', selectionText: 'A long enough selection of text.' }, { id: ACTIVE_TAB });
  menuClickListener({ menuItemId: 'fc-check-selection', selectionText: 'tiny' }, { id: ACTIVE_TAB });
  await settle();
  assert.equal((await send({ type: 'panelReady' }, undefined)).claims.length, before);
});

test('GET_STATE reports the page as scannable for an ordinary site', async () => {
  const res = await send({ type: 'getState' });
  assert.equal(res.scanAllowed, true);
});

test('sentences from a never-scan domain are dropped by the worker itself', async () => {
  await chrome.storage.local.set({ fc_settings: { blockedDomains: ['example.com'] } });
  const before = (await send({ type: 'panelReady' }, undefined)).claims.length;
  await send({
    type: 'sentences',
    sentences: [{ id: 'p1', text: 'The bridge cost 40 million dollars more than planned, the auditor said.' }],
  });
  await settle();
  assert.equal((await send({ type: 'panelReady' }, undefined)).claims.length, before);

  const state = await send({ type: 'getState' });
  assert.equal(state.scanAllowed, false);
  assert.equal(state.reason, 'user');
  await chrome.storage.local.set({ fc_settings: {} });
});

test('a thumbs-up rule lets a built-in-blocked site scan, and PANEL_READY reports the rule', async () => {
  chrome.tabs.get = async (id) => ({ id, url: 'https://secure.chase.com/dashboard' });
  chrome.tabs.query = async () => [{ id: ACTIVE_TAB, url: 'https://secure.chase.com/dashboard' }];
  assert.equal((await send({ type: 'getState' })).scanAllowed, false);

  await send({ type: 'siteRule', domain: 'secure.chase.com', action: 'allow' }, undefined);
  assert.equal((await send({ type: 'getState' })).scanAllowed, true);
  assert.equal((await send({ type: 'panelReady' }, undefined)).page.rule, 'allow');

  await chrome.storage.local.set({ fc_settings: {} });
  chrome.tabs.get = async (id) => ({ id, url: 'https://www.example.com/article' });
  chrome.tabs.query = async () => [{ id: ACTIVE_TAB, url: 'https://www.example.com/article' }];
});

test('re-sending the same sentences does not duplicate claims', async () => {
  const before = (await send({ type: 'panelReady' }, undefined)).claims.length;
  await send({
    type: 'sentences',
    sentences: [{ id: 's1-again', text: 'Unemployment fell to 4.2 percent last quarter, according to the Labor Department.' }],
  });
  await settle();
  const after = (await send({ type: 'panelReady' }, undefined)).claims.length;
  assert.equal(after, before);
});
