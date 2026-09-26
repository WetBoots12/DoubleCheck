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
  let observer;
  let unwrapped = 0;
  let highlights = [];
  let listener;
  let textNodes = [];
  const wrappedText = [];
  let matchBuilds = 0;
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
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
    Set,
    Map,
    document: {
      body,
      documentElement,
      querySelector: () => null,
      querySelectorAll: (selector) => selector === '.fc-highlight' ? highlights : [],
      createElement: () => ({ dataset: {}, addEventListener() {}, style: {}, classList: { add() {}, contains: () => false }, setAttribute() {}, appendChild() {} }),
      createRange: () => {
        let node, start, end;
        return { selectNodeContents() {}, setStart(n, offset) { node = n; start = offset; },
          setEnd(_n, offset) { end = offset; }, surroundContents() {
            wrappedText.push(node.nodeValue.slice(start, end));
            node.nodeValue = node.nodeValue.slice(0, start);
          } };
      },
      createTreeWalker: () => { let index = 0; return { nextNode: () => textNodes[index++] || null }; },
      addEventListener() {},
    },
    MutationObserver: class { constructor(fn) { observer = fn; } observe() {} disconnect() {} },
    get location() { return { get href() { return href; }, hostname: 'www.riverbendgazette.example' }; },
    chrome: {
      runtime: {
        onMessage: { addListener(fn) { listener = fn; } },
        sendMessage: async (msg) => {
          sent.push(msg);
          if (msg.type === 'getState') return onGetState();
          return undefined;
        },
      },
    },
  };
  let pageshow = null;
  sandbox.addEventListener = (type, fn) => { if (type === 'pageshow') pageshow = fn; };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const file of SCRIPTS) {
    new vm.Script(readFileSync(file, 'utf8'), { filename: file }).runInContext(sandbox);
  }
  const build = sandbox.FCTextMatch.buildMatchIndex;
  sandbox.FCTextMatch.buildMatchIndex = (...args) => { matchBuilds++; return build(...args); };
  return {
    setTextNodes(texts) { textNodes = texts.map((nodeValue) => ({ nodeValue })); },
    wrappedText,
    matchBuilds: () => matchBuilds,
    reads,
    sent,
    mutate() { observer([]); },
    addHighlight() {
      const span = { childNodes: [], parentNode: { normalize() {} },
        replaceWith() { unwrapped++; highlights = highlights.filter((item) => item !== span); } };
      highlights.push(span);
    },
    unwrapped() { return unwrapped; },
    restoreFromCache() { pageshow?.({ persisted: true }); },
    message(msg) { listener(msg, {}, () => {}); },
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


test('anchor navigation preserves claims and their highlight spans', async () => {
  const world = makeWorld({ onGetState: async () => ({ autoCheck: true, scanAllowed: true }) });
  await wait(30);
  world.addHighlight();
  world.navigateTo(FIRST + '#cite_note-5');
  world.mutate();
  await wait(1100);
  assert.equal(world.sent.filter((msg) => msg.type === 'pageChanged').length, 0);
  assert.equal(world.unwrapped(), 0);
});

test('real navigation unwraps highlights and blocks reads immediately on mutation', async () => {
  let answers = 0;
  const world = makeWorld({ onGetState: async () => ++answers === 1
    ? { autoCheck: true, scanAllowed: true } : new Promise(() => {}) });
  await wait(30);
  world.addHighlight();
  const before = world.reads.length;
  world.navigateTo(PRIVATE);
  world.mutate(); // before the one-second navigation poll
  assert.equal(world.unwrapped(), 1);
  assert.equal(world.reads.length, before);
  assert.equal(world.sent.filter((msg) => msg.type === 'pageChanged').length, 1);
});

test('a slow first policy reply never permits early text reads', async () => {
  const world = makeWorld({ onGetState: async () => new Promise(() => {}) });
  world.mutate();
  await wait(1300);
  assert.deepEqual(world.reads, []);
});

test('hash-router navigation still changes the page', async () => {
  const world = makeWorld({ onGetState: async () => ({ autoCheck: true, scanAllowed: true }) });
  await wait(30);
  world.navigateTo(FIRST + '#/another-article');
  world.mutate();
  assert.equal(world.sent.filter((msg) => msg.type === 'pageChanged').length, 1);
});


test('a batch highlights multiple claims in reverse order with one text index', async () => {
  const world = makeWorld({ onGetState: async () => ({ autoCheck: true, scanAllowed: true }) });
  await wait(30);
  world.setTextNodes(['Revenue rose 20 percent. Employment rose 5 percent.']);
  world.message({ type: 'claimStatus', claims: [
    { id: 'c1', text: 'Revenue rose 20 percent.', status: 'unchecked' },
    { id: 'c2', text: 'Employment rose 5 percent.', status: 'unchecked' },
  ] });
  assert.deepEqual(world.wrappedText, ['Employment rose 5 percent.', 'Revenue rose 20 percent.']);
  assert.equal(world.matchBuilds(), 1);
});

test('every policy request names its document, and a back-forward restore is a new one', async () => {
  const world = makeWorld({ onGetState: async () => ({ autoCheck: true, scanAllowed: true }) });
  await wait(30);
  const first = world.sent.filter((m) => m.type === 'getState').map((m) => m.docId);
  assert.ok(first.length && first.every((id) => typeof id === 'string' && id.length >= 8), 'getState carries a document id');
  world.addHighlight();
  world.restoreFromCache();
  await wait(30);
  const ids = world.sent.filter((m) => m.type === 'getState').map((m) => m.docId);
  assert.notEqual(ids.at(-1), first[0], 'the restored page is reported as a new document');
  assert.equal(world.unwrapped(), 1, 'its old highlights are taken down, since the worker has dropped those claims');
});
