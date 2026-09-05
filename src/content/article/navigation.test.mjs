// What the page scanner does when a single-page app changes the URL under it.
//
// The scanner is a classic script, so it is loaded here the way the browser loads
// it: the companion scripts that install the FC globals first, then the scanner,
// all into one vm context holding a DOM small enough to be honest about. The whole
// probe is a single question — did the script read the page's text? — asked through
// a getter on innerText, because reading the text is the first thing that must not
// happen on a page nobody has been given permission to read.

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const SCRIPTS = [
  'src/content/textmatch.js',
  'src/content/segment.js',
  'src/content/mutations.js',
  'src/content/language.js',
  'src/content/regions.js',
  'src/content/article/index.js',
];

const ARTICLE_TEXT = 'The council raised the budget by 12 million dollars this year, records show. '
  + 'Inflation reached 8.2 percent in the year to June, the statistics office reported. '
  + 'Officials said the figure was higher than any forecast made at the start of the year.';

// A DOM with nothing in it but the one thing the test watches.
function makeWorld({ onGetState }) {
  const reads = [];
  let href = 'https://www.riverbendgazette.example/2026/03/city-budget-vote';

  const body = {
    get innerText() { reads.push(href); return ARTICLE_TEXT; },
    querySelectorAll: () => [],
    querySelector: () => null,
    matches: () => false,
    closest: () => null,
    parentElement: null,
    classList: { contains: () => false },
  };

  const documentElement = {
    style: { setProperty() {} },
    setAttribute() {},
    getAttribute: () => 'en',
  };

  const sent = [];
  const sandbox = {
    console,
    // Unreferenced, or the scanner's one-second URL poll keeps the test runner
    // alive for ever after the assertions have all passed.
    setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
    clearTimeout,
    setInterval: (fn, ms) => setInterval(fn, ms).unref(),
    clearInterval,
    Date,
    Set,
    Map,
    document: {
      body,
      documentElement,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => ({ style: {}, classList: { add() {}, contains: () => false }, setAttribute() {}, appendChild() {} }),
      createRange: () => ({ selectNodeContents() {}, setStart() {}, setEnd() {} }),
      createTreeWalker: () => ({ nextNode: () => null }),
      addEventListener() {},
    },
    MutationObserver: class { observe() {} disconnect() {} },
    get location() { return { get href() { return href; }, hostname: 'www.riverbendgazette.example' }; },
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        sendMessage: async (msg) => {
          sent.push(msg);
          if (msg.type === 'getState') return onGetState();
          return undefined;
        },
      },
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const file of SCRIPTS) {
    new vm.Script(readFileSync(file, 'utf8'), { filename: file }).runInContext(sandbox);
  }
  return {
    reads,
    sent,
    navigateTo(next) { href = next; },
    currentUrl() { return href; },
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const FIRST = 'https://www.riverbendgazette.example/2026/03/city-budget-vote';
const PRIVATE = 'https://www.riverbendgazette.example/account/billing';

test('a single-page navigation does not carry the old page\'s permission to the new one', async () => {
  // The worker allowed the article. Then the reader clicks through to their billing
  // page without a document load, which is how every modern news site is built, and
  // the worker goes to sleep before it can answer the question about the new URL.
  let answered = 0;
  const world = makeWorld({
    onGetState: async () => {
      answered += 1;
      if (answered === 1) return { autoCheck: true, scanAllowed: true };
      // The worker is asleep: no answer will ever come for the new page.
      return new Promise(() => {});
    },
  });

  // Let the first page be read, so scanAllowed is genuinely true when we navigate.
  await wait(1400);
  assert.ok(world.reads.length > 0, 'the article itself should have been read');

  world.navigateTo(PRIVATE);
  const before = world.reads.length;

  // The URL poll runs on a one-second interval and the scan follows 900ms later.
  await wait(2400);

  const afterNav = world.reads.slice(before);
  assert.deepEqual(afterNav, [],
    'the scanner read the new page before anyone said it could: '
    + `${afterNav.length} read(s) of ${PRIVATE}`);
});

test('the new page is read once the worker allows it', async () => {
  const world = makeWorld({ onGetState: async () => ({ autoCheck: true, scanAllowed: true }) });
  await wait(1400);

  world.navigateTo(FIRST.replace('city-budget-vote', 'school-funding-vote'));
  const before = world.reads.length;
  await wait(2400);

  assert.ok(world.reads.length > before,
    'an allowed page must still be read after a single-page navigation');
});
