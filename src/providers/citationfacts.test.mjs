// The guardrails are not something a caller can forget.
//
// Every provider builds its own request from the material it is given. There is no
// argument through which a prompt could be passed instead, so the only way to reach
// a model from here is with the rules attached. These tests hold that shut by
// inspecting what each provider actually puts on the wire.

import test from 'node:test';
import assert from 'node:assert/strict';

import { LLM_PROVIDERS } from './index.js';
import { CITATION_RULES } from '../shared/citationprompt.js';

const MATERIAL = {
  source: { title: 'Inflation cools to 4.2%', url: 'https://apnews.com/article/x', siteName: 'apnews.com' },
  missing: ['author', 'date'],
  pageText: 'By Christopher Rugaber. Published 14 June 2026.',
  searchResults: [{ title: 'Same piece elsewhere', url: 'https://x.example', snippet: 'By Christopher Rugaber' }],
};

const GOOD_REPLY = JSON.stringify({ authors: ['Christopher Rugaber'], date: '2026-06-14', notFound: [] });

// Each network provider, with the shape of the answer its API returns.
const NETWORKED = [
  ['anthropic', 'key', {}, (text) => ({ content: [{ text }] })],
  ['openai', 'key', {}, (text) => ({ choices: [{ message: { content: text } }] })],
  ['local', '', { url: 'http://localhost:11434/v1' }, (text) => ({ choices: [{ message: { content: text } }] })],
];

function captureFetch(shape, reply = GOOD_REPLY) {
  const sent = [];
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
    return { ok: true, status: 200, json: async () => shape(reply) };
  };
  return sent;
}

for (const [id, key, opts, shape] of NETWORKED) {
  test(`${id} cannot send a citation request without the rules`, async () => {
    const sent = captureFetch(shape);
    await LLM_PROVIDERS[id].lookupCitationFacts(MATERIAL, key, opts);

    assert.equal(sent.length, 1);
    const prompt = sent[0].body.messages[0].content;
    assert.ok(prompt.includes(CITATION_RULES), 'the rules were not in the request');
    assert.ok(prompt.includes('Fields still missing: author, date.'));
    assert.ok(prompt.includes('By Christopher Rugaber'), 'the material was not sent');
  });

  test(`${id} asks for extraction, not for writing`, async () => {
    const sent = captureFetch(shape);
    await LLM_PROVIDERS[id].lookupCitationFacts(MATERIAL, key, opts);
    assert.equal(sent[0].body.temperature, 0,
      'a model asked to be creative about a byline is being asked for the wrong thing');
  });

  test(`${id} reads back only what survives the checks`, async () => {
    captureFetch(shape, JSON.stringify({ authors: ['admin'], date: 'sometime in 2026' }));
    const facts = await LLM_PROVIDERS[id].lookupCitationFacts(MATERIAL, key, opts);
    assert.deepEqual(facts.authors, [], 'a placeholder is refused whatever produced it');
    assert.equal(facts.date, '', 'a vague date is not a date');
  });

  test(`${id} returns what a good answer contains`, async () => {
    captureFetch(shape);
    const facts = await LLM_PROVIDERS[id].lookupCitationFacts(MATERIAL, key, opts);
    assert.deepEqual(facts.authors, [{ name: 'Christopher Rugaber', fromAi: true }]);
    assert.equal(facts.date, '2026-06-14');
  });
}

test('the keyed providers refuse without a key rather than calling out', async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error('should not be reached'); };
  for (const id of ['anthropic', 'openai']) {
    await assert.rejects(() => LLM_PROVIDERS[id].lookupCitationFacts(MATERIAL, '', {}));
  }
  assert.equal(called, false);
});

test('the built-in model gets the same rules as every other', async () => {
  const prompts = [];
  globalThis.LanguageModel = {
    async availability() { return 'available'; },
    async create() {
      return { async prompt(text) { prompts.push(text); return GOOD_REPLY; }, destroy() {} };
    },
  };
  const facts = await LLM_PROVIDERS.builtin.lookupCitationFacts(MATERIAL);
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0].includes(CITATION_RULES));
  assert.deepEqual(facts.authors, [{ name: 'Christopher Rugaber', fromAi: true }]);
  delete globalThis.LanguageModel;
});

test('with no provider chosen, nothing is asked and nothing is claimed', async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; return { ok: true, json: async () => ({}) }; };
  assert.equal(await LLM_PROVIDERS.none.lookupCitationFacts(MATERIAL, '', {}), null);
  assert.equal(called, false);
});

test('every provider offers the method, so no choice of provider is a dead end', () => {
  for (const [id, p] of Object.entries(LLM_PROVIDERS)) {
    assert.equal(typeof p.lookupCitationFacts, 'function', id);
  }
});

test('this did not change how the summary function is called', async () => {
  // The two are separate AI functions. A change to one must not reach the other.
  const sent = captureFetch((text) => ({ content: [{ text }] }), '{"verdict":"unclear","summary":"x"}');
  await LLM_PROVIDERS.anthropic.crossReference('A claim.', [], 'key', {});
  const prompt = sent[0].body.messages[0].content;
  assert.ok(!prompt.includes(CITATION_RULES), 'the citation rules leaked into the summary prompt');
  assert.equal(sent[0].body.temperature, undefined, 'the summary call was not given a temperature it never had');
});
