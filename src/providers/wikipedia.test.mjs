import test from 'node:test';
import assert from 'node:assert/strict';

import { mapWikipedia, stripTags, SEARCH_PROVIDERS, getSearchProvider } from './index.js';

// Shaped exactly like a live response from the REST search endpoint.
const live = {
  pages: [{
    id: 570703,
    key: 'Natural_rate_of_unemployment',
    title: 'Natural rate of unemployment',
    excerpt: 'The natural <span class="searchmatch">rate</span> of <span class="searchmatch">unemployment</span> is the name that was given to a key concept in the study of economic activity.',
    description: 'Key concept in the study of economic activity',
    matched_title: null,
    anchor: null,
    thumbnail: null,
  }],
};

test('stripTags removes markup and leaves the text', () => {
  assert.equal(stripTags('a <span class="searchmatch">b</span> c'), 'a b c');
  assert.equal(stripTags(''), '');
  assert.equal(stripTags(undefined), '');
});

test('mapWikipedia maps the live field paths into the panel shape', () => {
  const [r] = mapWikipedia(live);
  assert.equal(r.title, 'Natural rate of unemployment');
  assert.equal(r.url, 'https://en.wikipedia.org/wiki/Natural_rate_of_unemployment');
  assert.equal(r.source, 'en.wikipedia.org');
  assert.ok(r.snippet.startsWith('Key concept in the study of economic activity'), r.snippet);
  assert.ok(r.snippet.includes('The natural rate of unemployment'), r.snippet);
  assert.ok(!r.snippet.includes('<span'), 'markup must be stripped from the snippet');
});

test('the article URL keeps parentheses and encodes what needs encoding', () => {
  const [r] = mapWikipedia({ pages: [{ key: 'Paris_(France)', title: 'Paris' }] });
  assert.equal(r.url, 'https://en.wikipedia.org/wiki/Paris_(France)');
  const [q] = mapWikipedia({ pages: [{ key: 'A&B', title: 'A&B' }] });
  assert.equal(q.url, 'https://en.wikipedia.org/wiki/A%26B');
});

test('mapWikipedia tolerates missing fields and malformed input', () => {
  const [r] = mapWikipedia({ pages: [{ key: 'Thing' }] });
  assert.equal(r.title, 'Thing');
  assert.equal(r.snippet, '');
  assert.deepEqual(mapWikipedia({}), []);
  assert.deepEqual(mapWikipedia(null), []);
  assert.deepEqual(mapWikipedia({ pages: 'nope' }), []);
});

test('Wikipedia needs no key, the keyed providers say they do, and it is the default', () => {
  assert.equal(SEARCH_PROVIDERS.wikipedia.requiresKey, false);
  assert.equal(SEARCH_PROVIDERS.serpapi.requiresKey, true);
  assert.equal(SEARCH_PROVIDERS.brave.requiresKey, true);
  assert.equal(Object.keys(SEARCH_PROVIDERS)[0], 'wikipedia');
  assert.equal(getSearchProvider('no-such-provider').id, 'wikipedia');
});

test('the provider sends distinctive words to the REST endpoint with no key and shapes the results', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { calls.push(String(url)); return { ok: true, status: 200, json: async () => live }; };
  try {
    const out = await SEARCH_PROVIDERS.wikipedia.search(
      'The agency said that the natural rate of unemployment fell to 4.2 percent in the last quarter.',
      '',
      { excludeDomain: 'example.com' },
    );
    const url = decodeURIComponent(calls[0]);
    assert.ok(url.startsWith('https://en.wikipedia.org/w/rest.php/v1/search/page?'), url);
    assert.ok(url.includes('unemployment') && url.includes('4.2'), url);
    assert.ok(!url.includes('The agency said'), 'the full sentence should not be sent');
    assert.ok(!/key=|api_key/.test(url), 'no key expected');
    assert.equal(out.length, 1);
    assert.equal(out[0].source, 'en.wikipedia.org');
    assert.equal(out[0].academic, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('an empty query makes no request', async () => {
  const realFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; return { ok: true, json: async () => live }; };
  try {
    assert.deepEqual(await SEARCH_PROVIDERS.wikipedia.search('   ', '', {}), []);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// Two flags on one page about the same subject find the same article, and the
// article offers the same references for both. Sources already under another flag
// on the page are handed in, and the provider prefers ones the reader has not seen.
const conflict = {
  pages: [{ id: 1, key: 'Coral_reef', title: 'Coral reef', excerpt: 'Reefs.', description: 'Reefs' }],
};
const wikitext = [
  'Coral cover fell by half.<ref>{{cite news |title=Reef lost half its coral |url=https://news.example/a |work=A}}</ref><ref>{{cite news |title=Half of reef coral gone |url=https://news.example/b |work=B}}</ref>',
  '',
  'Coral cover fell by half again.<ref>{{cite news |title=Coral cover halved |url=https://news.example/c |work=C}}</ref>',
].join('\n');

async function checkTwice(avoidUrls) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    ok: true,
    status: 200,
    json: async () => (String(url).includes('/page/') ? { source: wikitext } : conflict),
  });
  try {
    return await SEARCH_PROVIDERS.wikipedia.search('coral cover fell by half', '', { avoidUrls });
  } finally {
    globalThis.fetch = realFetch;
  }
}

test('sources already shown under another claim on the page come after ones not yet shown', async () => {
  const first = await checkTwice([]);
  assert.ok(first.length >= 3, JSON.stringify(first.map((r) => r.url)));
  const shown = first.slice(0, 2).map((r) => r.url);
  const second = await checkTwice(shown);
  const urls = second.map((r) => r.url);
  // The unseen one leads; the seen ones, if there is room, follow.
  assert.ok(!shown.includes(urls[0]), JSON.stringify(urls));
});

test('the article itself is left off when it is already under another claim', async () => {
  const first = await checkTwice([]);
  const article = first.find((r) => r.url.includes('en.wikipedia.org'));
  assert.ok(article, 'the article is offered the first time');
  const second = await checkTwice([article.url]);
  assert.ok(!second.some((r) => r.url === article.url), JSON.stringify(second.map((r) => r.url)));
});
