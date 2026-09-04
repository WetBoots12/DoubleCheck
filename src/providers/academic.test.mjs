import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isAcademicSource,
  academicQuery,
  rankAcademic,
  mapOpenAlex,
  SCHOLAR_PROVIDERS,
  SEARCH_PROVIDERS,
} from './index.js';

// --- recognising scholarly sources ---------------------------------------------

test('journal, index and science-agency domains count as academic', () => {
  for (const u of [
    'https://www.nature.com/articles/x',
    'https://doi.org/10.1000/xyz',
    'https://pubmed.ncbi.nlm.nih.gov/12345/',
    'https://arxiv.org/abs/2401.00001',
    'https://www.cdc.gov/flu/about/index.html',
    'https://link.springer.com/article/10.1007/x',
  ]) assert.equal(isAcademicSource(u), true, u);
});

test('universities count by top-level domain', () => {
  assert.equal(isAcademicSource('https://news.mit.edu/2026/story'), true);
  assert.equal(isAcademicSource('https://www.ox.ac.uk/news/story'), true);
  assert.equal(isAcademicSource('https://www.u-tokyo.ac.jp/en/'), true);
});

test('news outlets and lookalikes do not count', () => {
  assert.equal(isAcademicSource('https://www.reuters.com/world/'), false);
  assert.equal(isAcademicSource('https://www.cnn.com/2026/story'), false);
  assert.equal(isAcademicSource('https://notnature.com/x'), false);
  assert.equal(isAcademicSource('https://nature.com.evil.example/x'), false);
  assert.equal(isAcademicSource('https://education.com/'), false); // not .edu
  assert.equal(isAcademicSource(''), false);
});

// --- shaping the web search ------------------------------------------------------

test('academicQuery appends scholarly terms without touching the claim', () => {
  const q = academicQuery('Unemployment fell to 4.2 percent last quarter');
  assert.ok(q.startsWith('Unemployment fell to 4.2 percent last quarter'));
  assert.ok(/peer-reviewed/.test(q));
});

test('rankAcademic lists academic results first and keeps each group in engine order', () => {
  const results = [
    { url: 'https://cnn.com/a', academic: false, title: 'cnn' },
    { url: 'https://nature.com/b', academic: true, title: 'nature' },
    { url: 'https://bbc.com/c', academic: false, title: 'bbc' },
    { url: 'https://nih.gov/d', academic: true, title: 'nih' },
  ];
  assert.deepEqual(rankAcademic(results).map((r) => r.title), ['nature', 'nih', 'cnn', 'bbc']);
});

test('a web search in academic mode augments the query and ranks academic domains first', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        web: {
          results: [
            { url: 'https://www.cnn.com/a', title: 'cnn', description: '' },
            { url: 'https://www.nature.com/b', title: 'nature', description: '' },
            { url: 'https://www.bbc.com/c', title: 'bbc', description: '' },
          ],
        },
      }),
    };
  };
  try {
    const out = await SEARCH_PROVIDERS.brave.search('the claim', 'k'.repeat(20), { academic: true });
    assert.ok(decodeURIComponent(calls[0]).includes('peer-reviewed'), 'query was not augmented');
    assert.equal(out[0].title, 'nature');
    assert.equal(out[0].academic, true);
    assert.equal(out[1].academic, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('outside academic mode the query is untouched and order is the engine\'s', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return {
      ok: true, status: 200,
      json: async () => ({ web: { results: [
        { url: 'https://www.cnn.com/a', title: 'cnn' },
        { url: 'https://www.nature.com/b', title: 'nature' },
      ] } }),
    };
  };
  try {
    const out = await SEARCH_PROVIDERS.brave.search('the claim', 'k'.repeat(20), {});
    assert.ok(!decodeURIComponent(calls[0]).includes('peer-reviewed'));
    assert.equal(out[0].title, 'cnn');
  } finally {
    globalThis.fetch = realFetch;
  }
});

// --- OpenAlex ----------------------------------------------------------------------
// Shaped exactly like a live response, with the field paths confirmed against the API.

const live = {
  meta: { count: 96620 },
  results: [{
    id: 'https://openalex.org/W123',
    display_name: 'Nobel Lecture: Inflation and Unemployment',
    doi: 'https://doi.org/10.1086/260579',
    publication_year: 1977,
    cited_by_count: 1803,
    open_access: { is_oa: false },
    primary_location: { source: { display_name: 'Journal of Political Economy' } },
    authorships: [{ author: { display_name: 'Milton Friedman' } }],
  }],
};

test('mapOpenAlex maps the live field paths into the panel shape', () => {
  const [w] = mapOpenAlex(live);
  assert.equal(w.title, 'Nobel Lecture: Inflation and Unemployment');
  assert.equal(w.url, 'https://doi.org/10.1086/260579');
  assert.equal(w.venue, 'Journal of Political Economy');
  assert.equal(w.year, 1977);
  assert.equal(w.citations, 1803);
  assert.equal(w.openAccess, false);
  assert.deepEqual(w.authors, ['Milton Friedman']);
});

test('mapOpenAlex tolerates missing fields and falls back to the OpenAlex id for the link', () => {
  const [w] = mapOpenAlex({ results: [{ id: 'https://openalex.org/W9' }] });
  assert.equal(w.title, 'Untitled');
  assert.equal(w.url, 'https://openalex.org/W9');
  assert.equal(w.venue, '');
  assert.equal(w.year, null);
  assert.equal(w.citations, 0);
  assert.deepEqual(w.authors, []);
});

test('mapOpenAlex yields nothing for empty or malformed input', () => {
  assert.deepEqual(mapOpenAlex({}), []);
  assert.deepEqual(mapOpenAlex(null), []);
  assert.deepEqual(mapOpenAlex({ results: 'nope' }), []);
});

test('the OpenAlex provider sends distinctive words, filters to articles, and needs no key', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { calls.push(String(url)); return { ok: true, status: 200, json: async () => live }; };
  try {
    const out = await SCHOLAR_PROVIDERS.openalex.lookup('The agency said that unemployment fell to 4.2 percent in the last quarter.');
    const url = decodeURIComponent(calls[0]);
    assert.ok(url.startsWith('https://api.openalex.org/works?'), url);
    assert.ok(url.includes('filter=type:article'), url);
    assert.ok(url.includes('unemployment') && url.includes('4.2'), url);
    assert.ok(!url.includes('The agency said'), 'full sentence should not be sent');
    assert.ok(!/api_key|key=/.test(url), 'no key expected');
    assert.equal(out.length, 1);
    assert.equal(out[0].venue, 'Journal of Political Economy');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('the none scholar provider returns nothing', async () => {
  assert.deepEqual(await SCHOLAR_PROVIDERS.none.lookup('anything'), []);
});
