// Settings survive being changed from two places at once.
//
// The options page and the side panel are both open at the same time in ordinary
// use: the reader drags the confidence slider in one and presses the thumbs-down in
// the other. Each save is a read, a change and a write, so without a queue the
// second save reads the settings before the first has written and then discards it.

import test from 'node:test';
import assert from 'node:assert/strict';

// Storage that takes a moment, the way real storage does. Without the delay the
// read-modify-write happens to interleave less and the bug hides.
const data = new Map();
globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        await new Promise((r) => setTimeout(r, 5));
        return data.has(key) ? { [key]: structuredClone(data.get(key)) } : {};
      },
      async set(obj) {
        await new Promise((r) => setTimeout(r, 5));
        for (const [k, v] of Object.entries(obj)) data.set(k, structuredClone(v));
      },
    },
  },
};

const { saveSettings, getSettings, DEFAULT_SETTINGS } = await import('./messages.js');

test('three changes made at once all survive', async () => {
  data.clear();
  await Promise.all([
    saveSettings({ threshold: 0.9 }),
    saveSettings({ autoCheck: false }),
    saveSettings({ blockedDomains: ['example.com'] }),
  ]);

  const s = await getSettings();
  assert.equal(s.threshold, 0.9, 'the confidence slider was lost');
  assert.equal(s.autoCheck, false, 'the auto-check toggle was lost');
  assert.deepEqual(s.blockedDomains, ['example.com'], 'the blocked site was lost');
});

test('a great many changes at once still all survive', async () => {
  data.clear();
  const domains = Array.from({ length: 25 }, (_, i) => `site${i}.example`);
  await Promise.all(domains.map((d) => saveSettings({ [`t_${d}`]: d })));

  const s = await getSettings();
  for (const d of domains) assert.equal(s[`t_${d}`], d, `${d} was lost`);
});

test('a save that fails does not stall every save after it', async () => {
  data.clear();
  const realSet = chrome.storage.local.set;
  chrome.storage.local.set = async () => { throw new Error('storage is full'); };
  await assert.rejects(saveSettings({ threshold: 0.5 }));
  chrome.storage.local.set = realSet;

  await saveSettings({ threshold: 0.8 });
  assert.equal((await getSettings()).threshold, 0.8);
});

test('unknown keys still fall back to their defaults', async () => {
  data.clear();
  await saveSettings({ threshold: 0.6 });
  const s = await getSettings();
  assert.equal(s.searchProvider, DEFAULT_SETTINGS.searchProvider);
});
