import test from 'node:test';
import assert from 'node:assert/strict';

import { SEARCH_ENGINES, QUERY_STYLES, getEngine, engineStyle, searchUrl } from './engines.js';
import { browserQuery } from '../providers/index.js';

const CLAIM = 'Unemployment fell to 4.2 percent last quarter, according to the Labor Department.';

test('the browser default comes first and is what an unknown id falls back to', () => {
  assert.equal(SEARCH_ENGINES[0].id, 'default');
  assert.equal(SEARCH_ENGINES[0].url, null, 'the default is opened through chrome.search, not by address');
  assert.equal(getEngine('no-such-engine').id, 'default');
  assert.equal(getEngine(undefined).id, 'default');
});

test('every engine has a label and a usable style', () => {
  for (const e of SEARCH_ENGINES) {
    assert.ok(e.label, `${e.id} has no label`);
    assert.ok(QUERY_STYLES[e.style], `${e.id} names an unknown style: ${e.style}`);
  }
});

test('every named engine has an https address ending in its query parameter', () => {
  for (const e of SEARCH_ENGINES.filter((x) => x.url)) {
    assert.match(e.url, /^https:\/\//, `${e.id} is not https`);
    assert.match(e.url, /[?&][a-z]+=$/, `${e.id} does not end ready for a query: ${e.url}`);
  }
});

test('a query is encoded into the address, quotation marks and all', () => {
  const url = searchUrl('duckduckgo', '"4.2 percent" unemployment');
  assert.equal(url, 'https://duckduckgo.com/?q=%224.2%20percent%22%20unemployment');
  assert.ok(!url.includes(' '), 'a raw space would break the address');
});

test('the browser default yields no address, which is how the caller knows to use chrome.search', () => {
  assert.equal(searchUrl('default', 'anything'), '');
  assert.equal(searchUrl('no-such-engine', 'anything'), '');
});

// --- the shapes each engine gets ----------------------------------------------------

test('Google and Bing take two quoted phrases', () => {
  for (const id of ['google', 'bing', 'yahoo']) {
    const q = browserQuery(CLAIM, engineStyle(id));
    assert.equal((q.match(/"/g) || []).length, 4, `${id}: expected two quoted phrases, got ${q}`);
    assert.ok(q.includes('"4.2 percent"'), q);
  }
});

test('DuckDuckGo and Brave get one quoted phrase, the figure', () => {
  // Their own help calls the operators experimental, and measured against a live
  // search the same claim returned 2 results with two phrases and 5 with one.
  for (const id of ['duckduckgo', 'brave', 'mojeek']) {
    const q = browserQuery(CLAIM, engineStyle(id));
    assert.equal((q.match(/"/g) || []).length, 2, `${id}: expected one quoted phrase, got ${q}`);
    assert.ok(q.includes('"4.2 percent"'), q);
    // The words of the phrase that did not fit are still available as keywords.
    assert.ok(/labor/i.test(q), q);
  }
});

test('an unknown default engine gets the shape that suits every engine', () => {
  const q = browserQuery(CLAIM, engineStyle('default'));
  assert.equal((q.match(/"/g) || []).length, 2, q);
});

test('answer engines are asked a question in ordinary words', () => {
  const q = browserQuery(CLAIM, engineStyle('perplexity'));
  assert.ok(q.startsWith('Is it true that'), q);
  assert.ok(q.endsWith('?'), q);
  assert.ok(!q.includes('"'), 'a question is not a keyword query');
  assert.ok(q.includes('4.2 percent'), 'the claim goes over intact');
  assert.ok(q.includes('Labor Department'), q);
});

test('a question does not end in two full stops', () => {
  const q = browserQuery('Crime is at an all-time low.', engineStyle('perplexity'));
  assert.equal(q, 'Is it true that Crime is at an all-time low?');
});

test('every engine produces something for a claim with no figures or names', () => {
  const plain = 'The new policy will reduce waiting times across the health service.';
  for (const e of SEARCH_ENGINES) {
    const q = browserQuery(plain, engineStyle(e.id));
    assert.ok(q.length > 0, `${e.id} produced nothing`);
  }
});

test('an empty claim produces an empty query for every engine', () => {
  for (const e of SEARCH_ENGINES) {
    assert.equal(browserQuery('', engineStyle(e.id)), '', e.id);
  }
});
