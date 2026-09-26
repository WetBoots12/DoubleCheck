// Keeping a page in the works cited list, and refusing to.
//
// This is the only thing in the extension that writes to disk and leaves it there,
// so the rule guarding it is stricter than the one guarding scanning, and this file
// exists to hold that difference in place. A thumbs-up allows a site to be scanned.
// It does not allow it to be written down.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function fakeStorageArea() {
  const data = new Map();
  return {
    async get(key) {
      if (key === null || key === undefined) return Object.fromEntries(data);
      const out = {};
      for (const k of (Array.isArray(key) ? key : [key])) if (data.has(k)) out[k] = structuredClone(data.get(k));
      return out;
    },
    async set(obj) { for (const [k, v] of Object.entries(obj)) data.set(k, structuredClone(v)); },
    async remove(key) { for (const k of (Array.isArray(key) ? key : [key])) data.delete(k); },
  };
}

// The page under test, and what its head says about itself.
let tabUrl = 'https://www.riverbendgazette.example/2026/03/city-budget-vote';
let tabIncognito = false;
let headHtml = '<head><meta property="og:site_name" content="Riverbend Gazette">'
  + '<script type="application/ld+json">{"@type":"NewsArticle","headline":"Council raises the budget",'
  + '"author":{"@type":"Person","name":"Jane Doe"},"datePublished":"2026-03-04"}</script>'
  + '<title>Council raises the budget | Riverbend Gazette</title></head>';

const TAB = 9;
let messageListener = null;
let tabUpdatedListener = null;
let hasContentScript = true;

globalThis.chrome = {
  storage: { session: fakeStorageArea(), local: fakeStorageArea() },
  contextMenus: { create: (_o, cb) => cb?.(), onClicked: { addListener() {} } },
  runtime: {
    onInstalled: { addListener: (fn) => fn({ reason: 'update' }) },
    onMessage: { addListener: (fn) => { messageListener = fn; } },
    sendMessage: async () => {},
    getURL: (p) => 'chrome-extension://fake/' + p,
  },
  tabs: {
    onRemoved: { addListener() {} }, onUpdated: { addListener(fn) { tabUpdatedListener = fn; } }, onActivated: { addListener() {} },
    query: async () => [{ id: TAB, url: tabUrl, incognito: tabIncognito, title: 'Tab title' }],
    get: async (id) => ({ id, url: tabUrl, incognito: tabIncognito, title: 'Tab title' }),
    sendMessage: async (_id, msg) => {
      if (!hasContentScript) throw new Error('no receiving end');
      if (msg.type === 'pageMeta') return { head: headHtml, title: 'Council raises the budget', url: tabUrl };
      return undefined;
    },
    create: async () => {},
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
  throw new Error('nothing here should reach the network: ' + url);
};

let docSeq = 0;
// A reload, as the worker sees one: a new content script instance, naming a new
// document. The first id a tab reports is only recorded, so one is registered first.
async function reloadDocument(tabId) {
  if (docSeq === 0) await send({ type: 'getState', docId: 'document-0000' }, tabId);
  await send({ type: 'getState', docId: `document-${String(++docSeq).padStart(4, '0')}` }, tabId);
}

function send(msg, tabId = TAB) {
  return new Promise((resolve) => {
    const content = new Set(['getState', 'pagePrivate', 'pageLanguage', 'pageSources', 'pageChanged', 'unlocated', 'sentences', 'highlightClicked', 'captionHint', 'navState']);
    const sender = content.has(msg.type) ? { tab: { id: tabId } } : { url: chrome.runtime.getURL('src/sidepanel/panel.html') };
    const keep = messageListener(msg, sender, resolve);
    if (!keep) resolve(undefined);
  });
}
const settle = () => new Promise((r) => setTimeout(r, 40));

await import('./index.js');

async function reset(settings = {}) {
  tabUrl = 'https://www.riverbendgazette.example/2026/03/city-budget-vote';
  tabIncognito = false;
  hasContentScript = true;
  await chrome.storage.local.set({ fc_settings: settings });
  await chrome.storage.local.remove('fc_sources');

  // A tab reported private stays private until it navigates, and the marker is held
  // in memory as well as in storage, so deleting the stored key behind its back
  // clears nothing. Navigating is how the extension itself clears it, so that is what
  // the test does; anything else would be testing a state the code cannot reach.
  await reloadDocument(TAB);
  await settle();
}

const list = async () => (await send({ type: 'listSources' }, undefined)).sources;

// --- keeping a page --------------------------------------------------------------

test('an ordinary page is kept, described by its own head', async () => {
  await reset();
  const res = await send({ type: 'addSource' }, undefined);
  assert.equal(res.ok, true);

  const [saved] = await list();
  assert.equal(saved.title, 'Council raises the budget', 'the site name comes off the title');
  assert.equal(saved.siteName, 'Riverbend Gazette');
  assert.deepEqual(saved.authors, [{ name: 'Jane Doe' }]);
  assert.equal(saved.date.slice(0, 10), '2026-03-04');
  assert.ok(saved.accessed, 'the day it was kept is the access date');
});

test('keeping the same page again replaces it rather than adding a second', async () => {
  await reset();
  await send({ type: 'addSource' }, undefined);
  headHtml = headHtml.replace('Council raises the budget', 'Council raises the budget again');
  const res = await send({ type: 'addSource' }, undefined);

  assert.equal(res.replaced, true);
  const saved = await list();
  assert.equal(saved.length, 1);
  assert.ok(saved[0].title.includes('again'), 'the fresh read wins');
  headHtml = headHtml.replace(' again', '');
});

test('a page with no content script is still kept, from what the tab reports', async () => {
  await reset();
  hasContentScript = false;
  const res = await send({ type: 'addSource' }, undefined);
  assert.equal(res.ok, true);
  const [saved] = await list();
  assert.equal(saved.title, 'Tab title');
  assert.equal(saved.siteName, 'riverbendgazette.example', 'the domain stands in, and it is true');
});

// --- refusing a page -------------------------------------------------------------

test('a page the built-in rules flag is refused', async () => {
  await reset();
  tabUrl = 'https://secure.chase.com/statements';
  const res = await send({ type: 'addSource' }, undefined);
  assert.equal(res.ok, false);
  assert.equal(res.blocked, true);
  assert.deepEqual(await list(), []);
});

test('a thumbs-up allows a site to be scanned, not to be written down', async () => {
  // This is the whole difference between the two policies. Scanning is transient and
  // in memory; the list is a file that is still there tomorrow.
  await reset({ allowedDomains: ['chase.com'] });
  tabUrl = 'https://secure.chase.com/statements';

  const scan = await send({ type: 'getState' });
  assert.equal(scan.scanAllowed, true, 'the thumbs-up should still allow scanning');

  const res = await send({ type: 'addSource' }, undefined);
  assert.equal(res.blocked, true, 'but not keeping');
  assert.deepEqual(await list(), []);
});

test('switching the built-in rules off does not switch them off for the list', async () => {
  // That switch is a decision about scanning. It was not a decision about what to
  // write to disk.
  await reset({ privateSitesRule: false });
  tabUrl = 'https://secure.chase.com/statements';

  assert.equal((await send({ type: 'getState' })).scanAllowed, true);
  assert.equal((await send({ type: 'addSource' }, undefined)).blocked, true);
});

test('a page that reported a password field is refused', async () => {
  await reset();
  await send({ type: 'pagePrivate', reason: 'fields' });
  await settle();
  const res = await send({ type: 'addSource' }, undefined);
  assert.equal(res.blocked, true);
  assert.equal(res.reason, 'fields');
});

test('nothing is kept from an incognito tab', async () => {
  await reset();
  tabIncognito = true;
  const res = await send({ type: 'addSource' }, undefined);
  assert.equal(res.blocked, true);
  assert.equal(res.reason, 'incognito');
  assert.deepEqual(await list(), []);
});

test("the reader's own block list is honoured", async () => {
  await reset({ blockedDomains: ['riverbendgazette.example'] });
  assert.equal((await send({ type: 'addSource' }, undefined)).blocked, true);
});

test('a page that is not a web page is refused', async () => {
  await reset();
  tabUrl = 'chrome://settings';
  assert.equal((await send({ type: 'addSource' }, undefined)).ok, false);
});

// --- managing the list -------------------------------------------------------------

test('a source can be removed, and the list emptied', async () => {
  await reset();
  await send({ type: 'addSource' }, undefined);
  const [saved] = await list();

  const after = await send({ type: 'removeSource', key: saved.key }, undefined);
  assert.deepEqual(after.sources, []);

  await send({ type: 'addSource' }, undefined);
  assert.equal((await list()).length, 1);
  assert.deepEqual((await send({ type: 'clearSources' }, undefined)).sources, []);
  assert.deepEqual(await list(), []);
});

test('the list survives the worker being put to sleep', async () => {
  await reset();
  await send({ type: 'addSource' }, undefined);
  await import('./index.js?restarted-for-sources');
  await settle();
  assert.equal((await list()).length, 1, 'a bibliography that dies with the worker is no use');
});

test('a page that moves between the check and the reply is not kept', async () => {
  // The policy judges the tab's address; the content script answers a moment later
  // with the page's own. On a single-page app one history.pushState in between means
  // the approval belonged to the page before. The window is small and the shape is
  // familiar: it is the same way a navigation used to carry the previous page's
  // permission into the next one.
  await reset();
  const approved = tabUrl;

  const realSend = chrome.tabs.sendMessage;
  chrome.tabs.sendMessage = async (_id, msg) => {
    if (msg.type !== 'pageMeta') return undefined;
    return { head: headHtml, title: 'Somewhere else', url: 'https://www.riverbendgazette.example/account/billing' };
  };

  const res = await send({ type: 'addSource' }, undefined);
  chrome.tabs.sendMessage = realSend;

  assert.equal(res.ok, false, 'a page that moved must not be kept');
  assert.deepEqual(await list(), []);
  assert.equal(approved, tabUrl, 'and the tab itself never changed');
});

test('the address stored is the one the policy judged, not the one the page reports', async () => {
  await reset();
  const realSend = chrome.tabs.sendMessage;
  // Same page, but the reply carries a tracking parameter the check never saw.
  chrome.tabs.sendMessage = async (_id, msg) => (msg.type === 'pageMeta'
    ? { head: headHtml, title: 'Council raises the budget', url: `${tabUrl}?utm_source=x` }
    : undefined);

  await send({ type: 'addSource' }, undefined);
  chrome.tabs.sendMessage = realSend;

  const [saved] = await list();
  assert.equal(saved.url, tabUrl, 'the judged address is what is written down');
});
