import test from 'node:test';
import assert from 'node:assert/strict';

import { LLM_PROVIDERS } from './index.js';

// Chrome's on-device model is slow in two places the extension controls: loading
// the model, which used to happen on every press, and writing the answer, which is
// paid one word at a time. These cover the first, and the streaming that makes the
// second visible.

const ANSWER = '{"verdict":"unclear","sources":[],"summary":"Nothing decisive.","agreement":"","dispute":""}';

const RESULTS = [
  { source: 'apnews.com', title: 'Rate falls', snippet: 'The rate fell to 4.2 percent.' },
];

// A stand-in for LanguageModel that records what was asked of it.
function stub({ canClone = true, stream = null } = {}) {
  const log = { created: 0, cloned: 0, destroyed: 0, prompts: [], streamed: 0 };
  const make = () => {
    const session = {
      prompt: async (p) => { log.prompts.push(p); return ANSWER; },
      destroy: () => { log.destroyed++; },
    };
    if (canClone) session.clone = async () => { log.cloned++; return make(); };
    if (stream) {
      session.promptStreaming = (p) => {
        log.prompts.push(p);
        log.streamed++;
        return { async *[Symbol.asyncIterator]() { for (const c of stream) yield c; } };
      };
    }
    return session;
  };
  globalThis.LanguageModel = {
    availability: async () => 'available',
    create: async () => { log.created++; return make(); },
  };
  return log;
}

function cleanUp() {
  LLM_PROVIDERS.builtin.release();
  delete globalThis.LanguageModel;
}

test('the model is loaded once and every call works on a clone of it', async () => {
  const log = stub();
  try {
    await LLM_PROVIDERS.builtin.crossReference('A claim.', RESULTS);
    await LLM_PROVIDERS.builtin.crossReference('Another claim.', RESULTS);
    await LLM_PROVIDERS.builtin.crossReference('A third.', RESULTS);
    assert.equal(log.created, 1, 'the model should be loaded once, not once per claim');
    assert.equal(log.cloned, 3);
    assert.equal(log.destroyed, 3, 'each clone is released, so the conversation never grows');
  } finally {
    cleanUp();
  }
});

test('warming up loads the model without asking it anything', async () => {
  const log = stub();
  try {
    LLM_PROVIDERS.builtin.warmUp();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(log.created, 1);
    assert.equal(log.prompts.length, 0, 'warming up must not spend a generation');

    await LLM_PROVIDERS.builtin.crossReference('A claim.', RESULTS);
    assert.equal(log.created, 1, 'the warmed session is the one the first press uses');
  } finally {
    cleanUp();
  }
});

test('a browser whose sessions cannot be cloned still works, one session per call', async () => {
  const log = stub({ canClone: false });
  try {
    await LLM_PROVIDERS.builtin.crossReference('A claim.', RESULTS);
    await LLM_PROVIDERS.builtin.crossReference('Another claim.', RESULTS);
    assert.equal(log.cloned, 0);
    assert.ok(log.created >= 2, `expected a session per call, got ${log.created}`);
    assert.equal(log.destroyed, 2);
  } finally {
    cleanUp();
  }
});

test('releasing the model destroys it, and the next call loads it again', async () => {
  const log = stub();
  try {
    await LLM_PROVIDERS.builtin.crossReference('A claim.', RESULTS);
    assert.equal(log.created, 1);
    LLM_PROVIDERS.builtin.release();
    await new Promise((r) => setTimeout(r, 0));
    await LLM_PROVIDERS.builtin.crossReference('A claim.', RESULTS);
    assert.equal(log.created, 2);
  } finally {
    cleanUp();
  }
});

// --- streaming ---------------------------------------------------------------------

test('the answer is streamed when someone is watching, and arrives whole', async () => {
  const parts = ['{"verdict":"unclear",', '"summary":"Nothing ', 'decisive."}'];
  const log = stub({ stream: parts });
  const seen = [];
  try {
    const out = await LLM_PROVIDERS.builtin.crossReference('A claim.', RESULTS, '', {
      onProgress: (text) => seen.push(text),
    });
    assert.equal(log.streamed, 1);
    assert.equal(seen.length, 3);
    assert.equal(seen.at(-1), parts.join(''), 'progress reports the whole answer so far');
    assert.equal(out.summary, 'Nothing decisive.');
  } finally {
    cleanUp();
  }
});

test('a browser that streams the whole answer each time is not read as repetition', async () => {
  // Chrome has shipped both shapes. Cumulative chunks must not be concatenated.
  const cumulative = ['{"summary":"One', '{"summary":"One two', '{"summary":"One two three"}'];
  const log = stub({ stream: cumulative });
  const seen = [];
  try {
    const out = await LLM_PROVIDERS.builtin.crossReference('A claim.', RESULTS, '', {
      onProgress: (text) => seen.push(text),
    });
    assert.equal(seen.at(-1), cumulative.at(-1));
    assert.equal(out.summary, 'One two three');
    assert.equal(log.streamed, 1);
  } finally {
    cleanUp();
  }
});

test('nobody watching means no streaming, and a progress display that throws loses nothing', async () => {
  const quiet = stub({ stream: ['{"summary":"x"}'] });
  try {
    await LLM_PROVIDERS.builtin.crossReference('A claim.', RESULTS);
    assert.equal(quiet.streamed, 0, 'without onProgress the plain prompt is enough');
  } finally {
    cleanUp();
  }

  const noisy = stub({ stream: ['{"summary":"kept"}'] });
  try {
    const out = await LLM_PROVIDERS.builtin.crossReference('A claim.', RESULTS, '', {
      onProgress: () => { throw new Error('the panel went away'); },
    });
    assert.equal(out.summary, 'kept');
    assert.equal(noisy.destroyed, 1);
  } finally {
    cleanUp();
  }
});

test('a model that will not load reports the failure rather than a broken answer', async () => {
  globalThis.LanguageModel = { availability: async () => 'available', create: async () => { throw new Error('no model'); } };
  try {
    await assert.rejects(() => LLM_PROVIDERS.builtin.crossReference('A claim.', RESULTS), /no model/);
    // The failure must not be remembered as a session; the next attempt tries again.
    let tries = 0;
    globalThis.LanguageModel.create = async () => { tries++; throw new Error('no model'); };
    await assert.rejects(() => LLM_PROVIDERS.builtin.crossReference('A claim.', RESULTS));
    assert.ok(tries >= 1, 'a second press should try to load the model again');
  } finally {
    cleanUp();
  }
});
