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
      if (key === null || key === undefined) return Object.fromEntries(data);
      const out = {};
      for (const k of (Array.isArray(key) ? key : [key])) {
        if (data.has(k)) out[k] = structuredClone(data.get(k));
      }
      return out;
    },
    async set(obj) { for (const [k, v] of Object.entries(obj)) data.set(k, structuredClone(v)); },
    async remove(key) { for (const k of (Array.isArray(key) ? key : [key])) data.delete(k); },
    _data: data,
  };
}

const sent = { runtime: [], tabs: [], badge: [], search: [] };
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
  search: { query: async (o) => { sent.search.push(o); } },
};

// The classifier fetches its model through chrome.runtime.getURL; serve it from disk
// so the real trained model is what scores the sentences.
const searchCalls = [];
const pageCalls = [];

// The article behind the search result: what "read the source, not the snippet"
// actually fetches. The number the claim turns on is in the page and not in the
// one-line description the search returns.
const ARTICLE_HTML = `<html><body><article>
  <p>The Labor Department reported that unemployment fell to 4.2 percent in the final
  quarter of the year, down from 4.4 percent in the preceding three months.</p>
  <p>Analysts said the housing market was unrelated to this particular release.</p>
</article></body></html>`;

globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.endsWith('classifier/model/model.json')) {
    return { ok: true, json: async () => JSON.parse(readFileSync('classifier/model/model.json', 'utf8')) };
  }
  // The default provider, Wikipedia. Counted so the cache can be shown to work.
  if (u.includes('/w/rest.php/v1/search/page')) {
    searchCalls.push(u);
    return {
      ok: true,
      status: 200,
      json: async () => ({ pages: [{ key: 'Unemployment', title: 'Unemployment', description: 'Economic condition' }] }),
    };
  }
  // The result's own page.
  if (u.includes('/wiki/')) {
    pageCalls.push({ url: u, init });
    return {
      ok: true,
      status: 200,
      headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null) },
      text: async () => ARTICLE_HTML,
    };
  }
  throw new Error(`unexpected fetch ${u}`);
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

test('Search in browser opens the claim in the default engine via chrome.search', async () => {
  const claims = (await send({ type: 'panelReady' }, undefined)).claims;
  const target = claims[0];
  await send({ type: 'browserSearch', claimId: target.id }, undefined);
  await settle();
  const call = sent.search.at(-1);
  assert.ok(call, 'chrome.search.query was not called');
  assert.equal(call.text, target.text);
  assert.equal(call.disposition, 'NEW_TAB');
});

test('a check spends one search call, and checking the same claim again spends none', async () => {
  const claims = (await send({ type: 'panelReady' }, undefined)).claims;
  const target = claims.find((c) => c.text.includes('Unemployment'));
  assert.ok(target, 'expected the unemployment claim to be flagged');

  searchCalls.length = 0;
  await send({ type: 'checkClaim', claimId: target.id }, undefined);
  await settle();
  assert.equal(searchCalls.length, 1, 'the first check should reach the provider');
  const checked = (await send({ type: 'panelReady' }, undefined)).claims.find((c) => c.id === target.id);
  assert.equal(checked.status, 'checked');
  assert.ok(checked.results.length >= 1);

  // A fresh page carrying the same sentence: same question, so no second call.
  await send({ type: 'pageChanged' });
  await send({ type: 'sentences', sentences: [{ id: 's1', text: target.text }] });
  await settle();
  await send({ type: 'checkClaim', claimId: 's1' }, undefined);
  await settle();
  assert.equal(searchCalls.length, 1, 'the remembered answer should have been reused');
  const again = (await send({ type: 'panelReady' }, undefined)).claims.find((c) => c.id === 's1');
  assert.equal(again.status, 'checked');
  assert.deepEqual(again.results, checked.results, 'the reused answer must match the original');
});

test('the source is read for the paragraph that bears on the claim, without cookies', async () => {
  const call = pageCalls.at(-1);
  assert.ok(call, 'the top result page should have been fetched');
  assert.equal(call.init?.credentials, 'omit', 'page reads must be anonymous');

  const claims = (await send({ type: 'panelReady' }, undefined)).claims;
  const checked = claims.find((c) => c.results?.length);
  assert.ok(checked.results[0].excerpt, 'no excerpt was attached to the result');
  assert.ok(checked.results[0].excerpt.includes('4.2 percent'), checked.results[0].excerpt);
  assert.ok(
    !checked.results[0].excerpt.includes('housing market'),
    'only the paragraphs bearing on the claim belong in the excerpt',
  );
});

test('clearing the cache empties it, and the next check pays for a call again', async () => {
  const res = await send({ type: 'clearCache' }, undefined);
  assert.deepEqual(res, { ok: true });

  const before = searchCalls.length;
  await send({ type: 'pageChanged' });
  await send({ type: 'sentences', sentences: [{ id: 's9', text: 'Unemployment fell to 4.2 percent last quarter, according to the Labor Department.' }] });
  await settle();
  await send({ type: 'checkClaim', claimId: 's9' }, undefined);
  await settle();
  assert.equal(searchCalls.length, before + 1, 'after clearing, the provider should be called again');
});

test('the panel can ask the video script to open the transcript', async () => {
  // The caption track cannot be fetched: the URL is in the watch page, but the
  // endpoint answers 200 with an empty body without a token the player mints.
  // Opening the transcript YouTube already offers is the route that works, and
  // only a content script can touch YouTube's own controls.
  sent.tabs.length = 0;
  await send({ type: 'openTranscript' }, undefined);
  await settle();
  const forwarded = sent.tabs.find((m) => m.msg.type === 'openTranscript');
  assert.ok(forwarded, 'the request never reached the tab');
  assert.equal(forwarded.tabId, ACTIVE_TAB);
});

test('a rescan clears the tab and asks the page to read itself again', async () => {
  // The bug this fixes: both sides remember what they have already judged, so a
  // changed threshold did nothing to the page on screen. A rescan has to empty
  // the worker's memory of the tab and tell the content script to empty its own.
  const before = (await send({ type: 'panelReady' }, undefined)).claims;
  assert.ok(before.length >= 1, 'expected claims to clear');

  sent.tabs.length = 0;
  const res = await send({ type: 'rescan' }, undefined);
  await settle();

  assert.deepEqual(res, { ok: true });
  const after = (await send({ type: 'panelReady' }, undefined)).claims;
  assert.deepEqual(after, [], 'the tab should have been emptied');
  assert.ok(sent.tabs.some((m) => m.msg.type === 'rescan' && m.tabId === ACTIVE_TAB),
    'the content script was never asked to read the page again');
});

test('after a rescan the same sentences are scored again, at the current threshold', async () => {
  // Re-sending what the page holds is what the content script does on a rescan,
  // and it must produce claims rather than being swallowed as already seen.
  await send({
    type: 'sentences',
    sentences: [
      { id: 'r1', text: 'Unemployment fell to 4.2 percent last quarter, according to the Labor Department.' },
      { id: 'r2', text: 'The company reported record revenue of 5 billion dollars in 2023.' },
    ],
  });
  await settle();
  const claims = (await send({ type: 'panelReady' }, undefined)).claims;
  assert.ok(claims.length >= 1, 'a rescanned page should flag its claims again');
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
