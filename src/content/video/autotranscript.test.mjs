// Opening a YouTube video's own transcript without being asked.
//
// The video script is a classic script, so it is loaded the way the browser loads it:
// its companion scripts first, then the script, into one vm context holding a page
// small enough to be honest about. The one question each test asks is whether the
// transcript button was pressed, and how many times.

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const SCRIPTS = [
  'src/content/textmatch.js',
  'src/content/segment.js',
  'src/content/language.js',
  'src/content/video/index.js',
];

function fakeElement() {
  const el = {
    style: {},
    classList: { add() {}, remove() {}, contains: () => false },
    isConnected: true,
    textContent: '',
    attachShadow: () => fakeElement(),
    append() {}, appendChild() {}, replaceChildren() {}, addEventListener() {},
    getAttribute: () => null,
  };
  return el;
}

function makeWatchPage({ autoTranscript = true, scanAllowed = true, hasTranscript = true, alreadyOpen = false } = {}) {
  const page = { hasTranscript, alreadyOpen, clicks: 0, videoId: 'abc123', clock: 0 };
  let tick = null;

  const transcriptButton = { click() { page.clicks++; page.alreadyOpen = true; } };
  const document = {
    body: fakeElement(),
    documentElement: fakeElement(),
    createElement: () => fakeElement(),
    createTextNode: () => fakeElement(),
    getElementById: () => null,
    querySelectorAll: () => [],
    querySelector(selector) {
      if (selector === 'ytd-video-description-transcript-section-renderer button') {
        return page.hasTranscript ? transcriptButton : null;
      }
      if (selector.includes('engagement-panel-searchable-transcript')) return page.alreadyOpen ? fakeElement() : null;
      return null;
    },
  };

  const sandbox = {
    console,
    Math, Set, Map, URLSearchParams, Promise,
    Date: { now: () => page.clock },
    setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
    clearTimeout,
    setInterval: (fn) => { tick = fn; return 1; },
    clearInterval() {},
    MutationObserver: class { observe() {} disconnect() {} },
    document,
    get location() {
      return { href: `https://www.youtube.com/watch?v=${page.videoId}`, pathname: '/watch', search: `?v=${page.videoId}` };
    },
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        sendMessage: async (msg) => (msg.type === 'getState'
          ? { autoCheck: true, scanAllowed, appearance: { showVideoOverlay: true, autoTranscript } }
          : undefined),
      },
    },
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const file of SCRIPTS) new vm.Script(readFileSync(file, 'utf8'), { filename: file }).runInContext(sandbox);

  return {
    page,
    // One poll of the script's one-second interval, after the policy answer is in.
    async tickAt(ms) {
      await new Promise((r) => setImmediate(r));
      page.clock = ms;
      tick();
    },
  };
}

test('a video with a transcript has it opened once, after the page settles', async () => {
  const w = makeWatchPage();
  await w.tickAt(500);
  assert.equal(w.page.clicks, 0, 'not while the previous video may still be on the page');
  await w.tickAt(3000);
  assert.equal(w.page.clicks, 1);
  await w.tickAt(4000);
  await w.tickAt(5000);
  assert.equal(w.page.clicks, 1, 'opened once, not on every poll');
});

test('with the setting off, nothing is opened', async () => {
  const w = makeWatchPage({ autoTranscript: false });
  await w.tickAt(3000);
  await w.tickAt(4000);
  assert.equal(w.page.clicks, 0);
});

test('a page the extension may not read is not touched', async () => {
  const w = makeWatchPage({ scanAllowed: false });
  await w.tickAt(3000);
  assert.equal(w.page.clicks, 0);
});

test('a video without a transcript is left alone, and one that gains the section is opened', async () => {
  const w = makeWatchPage({ hasTranscript: false });
  await w.tickAt(3000);
  assert.equal(w.page.clicks, 0);
  w.page.hasTranscript = true; // YouTube renders the description late
  await w.tickAt(4000);
  assert.equal(w.page.clicks, 1);
});

test('a transcript the reader already opened is not pressed again', async () => {
  const w = makeWatchPage({ alreadyOpen: true });
  await w.tickAt(3000);
  assert.equal(w.page.clicks, 0);
});

test('a transcript the reader closed stays closed for that video, and the next video gets its own', async () => {
  const w = makeWatchPage();
  await w.tickAt(3000);
  assert.equal(w.page.clicks, 1);
  w.page.alreadyOpen = false; // the reader closes it
  await w.tickAt(4000);
  assert.equal(w.page.clicks, 1, 'closing it was an answer for this video');

  w.page.videoId = 'next456'; // YouTube moves to another video without a reload
  await w.tickAt(5000); // the poll notices the new address and asks for permission again
  await w.tickAt(9000);
  assert.equal(w.page.clicks, 2);
});
