// Where a citation's facts come from, and when they are fetched.
//
// The rule this file exists to hold: a page is read for its author because the
// reader pressed a button, not because the extension felt like it. The automatic
// version is a setting the reader turns on, and the difference is proved by counting
// fetches rather than by trusting the code to be arranged correctly.

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

const TAB = 42;
const PAGE = 'https://www.example.com/article';
const AP = 'https://apnews.com/a';
const BBC = 'https://www.bbc.co.uk/b';

let messageListener = null;

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
    onRemoved: { addListener() {} }, onUpdated: { addListener() {} }, onActivated: { addListener() {} },
    query: async () => [{ id: TAB, url: PAGE, incognito: false }],
    get: async (id) => ({ id, url: PAGE, incognito: false }),
    sendMessage: async () => {}, create: async () => {},
  },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  sidePanel: { setPanelBehavior: async () => {}, open: async () => {} },
  commands: { onCommand: { addListener() {} } },
  search: { query: async () => {} },
};

const BODY = 'Prices rose by 4.2 percent in the year to June, the department said. ';

// Two results, each a page that declares an author, in the two ways pages do it.
const PAGES = {
  [AP]: '<html><head><meta property="og:site_name" content="AP News">'
    + '<script type="application/ld+json">{"@type":"NewsArticle","headline":"Inflation cools",'
    + '"author":{"@type":"Person","name":"Christopher Rugaber"},"datePublished":"2026-06-14"}</script>'
    + '</head><body><p>' + BODY.repeat(4) + '</p></body></html>',
  [BBC]: '<html><head><meta property="og:site_name" content="BBC News">'
    + '<meta name="author" content="By Faisal Islam">'
    + '</head><body><p>' + BODY.repeat(4) + '</p></body></html>',
};

const fetched = [];

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.endsWith('classifier/model/model.json')) {
    return { ok: true, json: async () => JSON.parse(readFileSync('classifier/model/model.json', 'utf8')) };
  }
  if (u.includes('serpapi.com')) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        organic_results: [
          { title: 'Inflation cools to 4.2% - The Assoc...', link: AP, source: 'apnews.com', snippet: 'Prices rose.' },
          { title: 'Cost of living', link: BBC, source: 'bbc.co.uk', snippet: 'The highest since 1982.' },
        ],
      }),
    };
  }
  if (PAGES[u]) {
    fetched.push(u);
    return {
      ok: true,
      status: 200,
      headers: { get: (h) => (h === 'content-type' ? 'text/html; charset=utf-8' : '') },
      text: async () => PAGES[u],
    };
  }
  return { ok: false, status: 404, headers: { get: () => '' }, text: async () => '' };
};

function send(msg, tabId = TAB) {
  return new Promise((resolve) => {
    const content = new Set(['getState', 'pagePrivate', 'pageLanguage', 'pageSources', 'pageChanged', 'unlocated', 'sentences', 'highlightClicked', 'captionHint', 'navState']);
    const sender = content.has(msg.type) ? { tab: { id: tabId } } : { url: chrome.runtime.getURL('src/sidepanel/panel.html') };
    const keep = messageListener(msg, sender, resolve);
    if (!keep) resolve(undefined);
  });
}
const settle = () => new Promise((r) => setTimeout(r, 80));

await import('./index.js');

let nextTab = 500;

async function useTab(settings) {
  const tab = nextTab++;
  chrome.tabs.query = async () => [{ id: tab, url: PAGE, incognito: false }];
  chrome.tabs.get = async (id) => ({ id, url: PAGE, incognito: false });
  await chrome.storage.local.set({
    fc_settings: {
      cacheResults: true,
      readSources: false,
      searchProvider: 'serpapi',
      searchApiKey: 'test-key',
      llmProvider: 'none',
      ...settings,
    },
  });
  for (const k of Object.keys(await chrome.storage.local.get(null))) {
    if (k.startsWith('fccache:')) await chrome.storage.local.remove(k);
  }
  fetched.length = 0;
  return tab;
}

// A claim already checked, with two results, seeded straight into the tab store.
async function seedChecked(settings = {}) {
  const tab = await useTab(settings);
  await chrome.storage.session.set({
    ['tab:' + tab]: {
      claims: {
        c1: {
          id: 'c1',
          text: 'Inflation reached 4.2 percent in the year to June.',
          status: 'checked',
          results: [
            { title: 'Inflation cools to 4.2% - The Assoc...', url: AP, source: 'apnews.com' },
            { title: 'Cost of living', url: BBC, source: 'bbc.co.uk' },
          ],
        },
      },
      seen: [],
    },
  });
  fetched.length = 0;
  return tab;
}

// --- manual is what happens unless the reader says otherwise -------------------------

test('a checked claim sitting in the panel has cost no page fetch', async () => {
  await seedChecked();
  await settle();
  assert.deepEqual(fetched, []);
});

test('citing one source reads that page and no other', async () => {
  await seedChecked();
  const { sources } = await send({ type: 'citeSources', claimId: 'c1', url: AP }, undefined);

  assert.deepEqual(fetched, [AP], 'only the source being cited is read');
  assert.equal(sources.length, 1);
  assert.deepEqual(sources[0].authors, [{ name: 'Christopher Rugaber' }]);
  assert.equal(sources[0].siteName, 'AP News');
  assert.equal(sources[0].title, 'Inflation cools', 'the page title replaces the truncated one');
  // publishedDateFromHtml returns a full instant; the styles only ever want the
  // calendar date out of it, which dateParts takes without shifting the day.
  assert.equal(sources[0].date.slice(0, 10), '2026-06-14');
  assert.match(sources[0].accessed, /^\d{4}-\d{2}-\d{2}$/, 'an access date is stamped when citing');
});

test('citing every source of a claim reads every page once', async () => {
  await seedChecked();
  const { sources } = await send({ type: 'citeSources', claimId: 'c1' }, undefined);

  assert.deepEqual(fetched.slice().sort(), [AP, BBC].sort());
  assert.equal(sources.length, 2);
  assert.deepEqual(sources[1].authors, [{ name: 'Faisal Islam' }], 'the leading "By" comes off');
});

test('a second citation of the same source costs no second fetch', async () => {
  await seedChecked();
  await send({ type: 'citeSources', claimId: 'c1', url: AP }, undefined);
  const after = fetched.length;
  await send({ type: 'citeSources', claimId: 'c1', url: AP }, undefined);
  assert.equal(fetched.length, after, 'the answer is remembered by address');
});

test('a page that will not load still cites, from what the search result gave', async () => {
  const tab = await useTab({});
  await chrome.storage.session.set({
    ['tab:' + tab]: {
      claims: { c1: { id: 'c1', text: 'A claim.', status: 'checked',
        results: [{ title: 'Gone', url: 'https://nowhere.example/x', source: 'nowhere.example' }] } },
      seen: [],
    },
  });
  const { sources } = await send({ type: 'citeSources', claimId: 'c1' }, undefined);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].siteName, 'nowhere.example', 'the domain is a last resort, and it is true');
  assert.deepEqual(sources[0].authors, []);
  assert.equal(sources[0].title, 'Gone');
});

test('a claim that is not there yields nothing rather than throwing', async () => {
  await seedChecked();
  assert.deepEqual((await send({ type: 'citeSources', claimId: 'no-such' }, undefined)).sources, []);
});

// --- automatic, and only when the reader turns it on -------------------------------------

async function runCheckWith(autoCitationData) {
  const tab = await useTab({ autoCitationData });
  await chrome.storage.session.set({
    ['tab:' + tab]: {
      claims: { c1: { id: 'c1', text: 'Inflation reached 4.2 percent in the year to June.', status: 'unchecked', score: 0.9 } },
      seen: [],
    },
  });
  fetched.length = 0;
  await send({ type: 'checkClaim', claimId: 'c1' }, undefined);
  await settle();
  await settle();
  return fetched.slice();
}

test('with the setting off, a check reads no page for citation data', async () => {
  assert.deepEqual(await runCheckWith(false), [],
    'the default must not fetch pages nobody asked to cite');
});

test('with the setting on, a check reads every result while it is already running', async () => {
  const read = await runCheckWith(true);
  assert.deepEqual(read.slice().sort(), [AP, BBC].sort(),
    'turning it on is what makes a later Cite press instant');
});

test('turning it on does not change what a citation says, only when it is ready', async () => {
  await runCheckWith(true);
  const { sources } = await send({ type: 'citeSources', claimId: 'c1' }, undefined);
  const auto = sources.find((s) => s.url === AP);
  assert.deepEqual(auto.authors, [{ name: 'Christopher Rugaber' }]);
  assert.equal(auto.siteName, 'AP News');
});

// --- citing a source is what puts it in the works cited list --------------------
//
// Two paths were built and only one of them wrote anything down. "Add this page as
// a source" stored the page the reader was on; "Cite this source" formatted a search
// result and copied it, and the works cited page never heard about it. Citing
// something is exactly the moment it belongs in the list.

const list = async () => (await send({ type: 'listSources' }, undefined)).sources;

test('citing one source puts that source in the works cited list', async () => {
  await seedChecked();
  await chrome.storage.local.remove('fc_sources');

  await send({ type: 'citeSources', claimId: 'c1', url: AP }, undefined);
  const kept = await list();

  assert.equal(kept.length, 1, 'the source that was cited should be in the list');
  assert.equal(kept[0].url, AP);
  assert.equal(kept[0].siteName, 'AP News', 'with what was read from its own page');
  assert.deepEqual(kept[0].authors, [{ name: 'Christopher Rugaber' }]);
});

test('citing every source of a claim keeps every one of them', async () => {
  await seedChecked();
  await chrome.storage.local.remove('fc_sources');

  await send({ type: 'citeSources', claimId: 'c1' }, undefined);
  assert.deepEqual((await list()).map((s) => s.url).sort(), [AP, BBC].sort());
});

test('citing the same source twice leaves one entry, freshly read', async () => {
  await seedChecked();
  await chrome.storage.local.remove('fc_sources');

  await send({ type: 'citeSources', claimId: 'c1', url: AP }, undefined);
  await send({ type: 'citeSources', claimId: 'c1', url: AP }, undefined);
  assert.equal((await list()).length, 1);
});

test('nothing is written down when citing from an incognito tab', async () => {
  const tab = await useTab({});
  chrome.tabs.get = async (id) => ({ id, url: PAGE, incognito: true });
  chrome.tabs.query = async () => [{ id: tab, url: PAGE, incognito: true }];
  await chrome.storage.session.set({
    ['tab:' + tab]: {
      claims: { c1: { id: 'c1', text: 'A claim.', status: 'checked',
        results: [{ title: 'One', url: AP, source: 'apnews.com' }] } },
      seen: [],
    },
  });
  await chrome.storage.local.remove('fc_sources');

  const res = await send({ type: 'citeSources', claimId: 'c1', url: AP }, undefined);
  assert.equal(res.sources.length, 1, 'the citation is still produced');
  assert.deepEqual(await list(), [], 'but nothing from incognito reaches the disk');
});

// --- two claims on one page ---------------------------------------------------------------

test('a check is told what the other claims on the page already show, and puts those last', async () => {
  const tab = await useTab({ cacheResults: false });
  await chrome.storage.session.set({
    ['tab:' + tab]: {
      claims: {
        c1: { id: 'c1', text: 'Prices rose 4.2 percent.', status: 'checked',
          results: [{ title: 'Already here', url: AP, source: 'apnews.com' }] },
        c2: { id: 'c2', text: 'Inflation reached 4.2 percent in the year to June.', status: 'unchecked', score: 0.9 },
      },
      seen: [],
    },
  });
  await send({ type: 'checkClaim', claimId: 'c2' }, undefined);
  await settle();
  await settle();
  const stored = (await chrome.storage.session.get('tab:' + tab))['tab:' + tab];
  const urls = stored.claims.c2.results.map((r) => r.url);
  // The engine returned AP first; AP is already under c1, so BBC leads for c2.
  assert.deepEqual(urls, [BBC, AP], JSON.stringify(urls));
});


test('both citation paths avoid the disk cache in incognito', async () => {
  const tab = await seedChecked();
  chrome.tabs.get = async (id) => ({ id, url: PAGE, incognito: true });
  chrome.tabs.query = async () => [{ id: tab, url: PAGE, incognito: true }];
  await send({ type: 'citeSources', claimId: 'c1', url: AP });
  await send({ type: 'citeMaterial', claimId: 'c1', url: BBC });
  assert.deepEqual(Object.keys(await chrome.storage.local.get(null)).filter((key) => key.startsWith('fccache:')), []);
});

test('citation material rejects a URL that is not one of the claim sources before fetching', async () => {
  await seedChecked();
  const result = await send({ type: 'citeMaterial', claimId: 'c1', url: 'http://192.168.1.1/admin' });
  assert.equal(result.source, null);
  assert.deepEqual(fetched, []);
});

test('reading and auto-citing the same results fetches each page only once', async () => {
  const tab = await useTab({ readSources: true, autoCitationData: true });
  await send({ type: 'sentences', sentences: [{ id: 'dedup', text: 'Inflation reached 4.2 percent in the year to June.' }] }, tab);
  await settle();
  await send({ type: 'checkClaim', claimId: 'dedup' });
  await settle();
  assert.equal(fetched.filter((url) => url === AP).length, 1);
  assert.equal(fetched.filter((url) => url === BBC).length, 1);
});
