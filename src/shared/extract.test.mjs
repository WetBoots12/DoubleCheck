import test from 'node:test';
import assert from 'node:assert/strict';

import { extractParagraphs, relevantExcerpt, decodeEntities, keywords, scoreParagraph } from './extract.js';

const CLAIM = 'Unemployment fell to 4.2 percent in the last quarter, the Labor Department said.';

// Shaped like a real article page: chrome around it, the useful number buried in
// the third paragraph, and a subscribe box that must not become evidence.
const PAGE = `<!doctype html><html><head><title>Jobs</title>
<script>window.dataLayer=[{"p":"<p>not a paragraph</p>"}];</script>
<style>p { color: red }</style></head>
<body>
<nav><p>Sections: World, Business, Sport, Culture, Opinion and more from our newsroom</p></nav>
<header><p>Subscribe today for unlimited access to award-winning journalism from our reporters</p></header>
<article>
  <h1>Jobs report</h1>
  <p>The labour market showed further signs of cooling this month, analysts said, as several
  large employers announced hiring freezes across the technology sector.</p>
  <p>Short one.</p>
  <p>Unemployment fell to 4.2&nbsp;percent in the final quarter of the year, the Labor Department
  said on Friday, down from 4.4 percent in the previous three months and the lowest reading
  recorded since early 2020.</p>
  <ul><li>The rate among workers aged under 25 stood at 8.1 percent, unchanged from the quarter
  before it, according to the same release from the department.</li></ul>
  <p>Sign up for our daily newsletter to get the morning briefing delivered to your inbox</p>
</article>
<footer><p>Copyright 2026. All rights reserved. Terms of service and privacy policy apply here.</p></footer>
</body></html>`;

test('paragraphs come out of a real page shape, and the chrome does not', () => {
  const paras = extractParagraphs(PAGE);
  const all = paras.join(' | ');
  assert.ok(paras.some((p) => p.includes('Unemployment fell to 4.2 percent')), all);
  assert.ok(paras.some((p) => p.includes('aged under 25')), 'list items carry numbers too');
  assert.ok(!all.includes('not a paragraph'), 'script contents must never be read as text');
  assert.ok(!all.includes('color: red'), 'style contents must not be read');
  assert.ok(!all.includes('Sections: World'), 'navigation is not the article');
  assert.ok(!/Subscribe today|Sign up for our daily|All rights reserved/.test(all), all);
  assert.ok(!all.includes('Short one'), 'fragments below the floor are dropped');
});

test('markup inside a paragraph is stripped, not left in the text', () => {
  const [p] = extractParagraphs('<p>The figure was <strong>4.2<em>%</em></strong> in <a href="/q">the quarter</a> just ended, officials said clearly.</p>', { minChars: 20 });
  assert.equal(p, 'The figure was 4.2 % in the quarter just ended, officials said clearly.');
  assert.ok(!p.includes('<'), p);
});

test('entities are decoded, including numeric and hex forms', () => {
  // &eacute; used to stand here as the example of a name we did not know. It is
  // known now, because author names carry accents and a half-decoded one breaks a
  // citation. The rule it was demonstrating still holds, so it needs a name that is
  // genuinely not in the table.
  assert.equal(decodeEntities('caf&eacute; &amp; bar'), 'café & bar');
  assert.equal(decodeEntities('a &frac34; b'), 'a &frac34; b', 'unknown names are left alone');
  assert.equal(decodeEntities('4.2&nbsp;percent'), '4.2 percent');
  assert.equal(decodeEntities('it&#39;s &#x27;quoted&#x27;'), "it's 'quoted'");
  assert.equal(decodeEntities('&lt;p&gt;'), '<p>');
  assert.equal(decodeEntities('&#999999999999;'), '&#999999999999;', 'nonsense code points are left alone');
  assert.equal(decodeEntities(''), '');
  assert.equal(decodeEntities(undefined), '');
});

test('a decoded entity cannot smuggle markup back in', () => {
  // &lt;script&gt; decodes to <script>, which must not then be treated as a tag.
  const paras = extractParagraphs('<p>The tag &lt;script&gt; appears in the article text itself, which is worth keeping intact here.</p>');
  assert.equal(paras.length, 1);
  assert.ok(paras[0].includes('<script>'), paras[0]);
});

test('the excerpt is the part of the page that bears on the claim', () => {
  const excerpt = relevantExcerpt(CLAIM, extractParagraphs(PAGE));
  assert.ok(excerpt.includes('4.2 percent'), excerpt);
  assert.ok(excerpt.includes('Labor Department'), excerpt);
  assert.ok(!excerpt.includes('hiring freezes'), 'an unrelated paragraph should not be pulled in');
});

test('paragraphs keep the order they had on the page', () => {
  const paras = ['Later, the Labor Department confirmed the unemployment figure of 4.2 percent for the quarter.',
    'Unemployment was the subject of the report published by the Labor Department on Friday morning.'];
  const excerpt = relevantExcerpt('unemployment Labor Department 4.2', paras);
  assert.ok(excerpt.indexOf('Later, the Labor') < excerpt.indexOf('Unemployment was the subject'), excerpt);
});

test('an excerpt is capped, so one long page cannot fill a prompt', () => {
  const long = Array.from({ length: 20 }, (_, i) => `Unemployment fell to 4.2 percent in quarter ${i} according to the Labor Department and other sources cited widely.`);
  const excerpt = relevantExcerpt(CLAIM, long, { maxChars: 400 });
  assert.ok(excerpt.length <= 400, `expected a capped excerpt, got ${excerpt.length}`);
  assert.ok(excerpt.length > 0);
});

test('a page about something else yields nothing, so the snippet is kept', () => {
  const paras = extractParagraphs(`<p>The cricket season opened in unusually warm weather this week, with spectators filling the stands across the county grounds.</p>`);
  assert.equal(relevantExcerpt(CLAIM, paras), '');
});

test('malformed and empty input does not throw', () => {
  assert.deepEqual(extractParagraphs(''), []);
  assert.deepEqual(extractParagraphs(null), []);
  assert.deepEqual(extractParagraphs('<p>unclosed paragraph with plenty of words in it to pass the floor'), []);
  assert.deepEqual(extractParagraphs('not html at all, just a bare string of text with no tags anywhere'), []);
  assert.equal(relevantExcerpt('', ['some text']), '');
  assert.equal(relevantExcerpt(CLAIM, []), '');
});

test('the same line repeated in a template is only taken once', () => {
  const dup = '<p>The Labor Department said unemployment fell to 4.2 percent in the final quarter.</p>';
  assert.equal(extractParagraphs(dup + dup + dup).length, 1);
});

test('numbers weigh double when deciding what is relevant', () => {
  const words = keywords(CLAIM);
  const withNumber = scoreParagraph(words, 'Unemployment was 4.2 percent that quarter.');
  const withoutNumber = scoreParagraph(words, 'Unemployment was discussed that quarter.');
  assert.ok(withNumber > withoutNumber, `${withNumber} should beat ${withoutNumber}`);
});

test('keywords drop filler and keep short numbers', () => {
  const k = keywords('It was 15 percent of the total in 2024');
  assert.ok(k.has('15') && k.has('2024') && k.has('percent'));
  assert.ok(!k.has('the') && !k.has('was') && !k.has('of'));
});

test('accented names decode, and their case is kept', () => {
  // An undecoded entity ends in a semicolon, and anything downstream that splits on
  // one turns "José García" into three authors, the last of them called "a".
  assert.equal(decodeEntities('Jos&eacute; Garc&iacute;a'), 'José García');
  assert.equal(decodeEntities('M&uuml;ller'), 'Müller');
  assert.equal(decodeEntities('&Aring;ngstr&ouml;m'), 'Ångström');
  assert.equal(decodeEntities('&Ccedil;elik'), 'Çelik');
});

test('an entity whose case carries no meaning still decodes', () => {
  assert.equal(decodeEntities('a &AMP; b'), 'a & b');
});

test('an entity that is not one is left exactly as it was', () => {
  assert.equal(decodeEntities('&notanentity;'), '&notanentity;');
});


test('unclosed region and paragraph floods stay bounded', () => {
  for (const tag of ['<nav>', '<p>', '<!--', '<p ']) {
    const start = performance.now();
    assert.deepEqual(extractParagraphs(tag.repeat(400000)), []);
    assert.ok(performance.now() - start < 1500, 'malformed HTML stalled parsing');
  }
});

test('source fetch refuses local destinations and redirects before following them', async () => {
  const { fetchPageHtml } = await import('../providers/index.js');
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    // Model the fetch API rejecting a redirect when redirect:error is set.
    if (init.redirect === 'error') throw new TypeError('redirect refused');
    return { ok: true, headers: { get: () => 'text/html' }, text: async () => 'private data' };
  };
  try {
    for (const url of ['http://10.0.0.1/', 'http://127.1/', 'http://2130706433/',
      'http://localhost:8080/', 'http://foo.localhost/', 'http://intranet/',
      'http://[::1]/', 'http://[::ffff:192.168.1.1]/', 'http://100.64.0.1/',
      'http://name:secret@example.com/']) assert.equal(await fetchPageHtml(url), '');
    assert.equal(calls.length, 0);
    assert.equal(await fetchPageHtml('https://example.com/redirect'), '');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.redirect, 'error');
    assert.equal(calls[0].init.credentials, 'omit');
  } finally { globalThis.fetch = realFetch; }
});

test('provider timeout also covers a response body that never finishes', async () => {
  const { fetchJson } = await import('../providers/index.js');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, { signal }) => ({
    ok: true, status: 200,
    json: () => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
  });
  try {
    await assert.rejects(fetchJson('https://example.com', {}, { timeoutMs: 15 }), /timed out/);
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ recovered: true }) });
    assert.deepEqual(await fetchJson('https://example.com'), { recovered: true });
  } finally { globalThis.fetch = realFetch; }
});

test('a tag too long for the token pattern is still stripped, not quoted as text', () => {
  const img = `<img alt="chart" src="data:image/png;base64,${'A'.repeat(6000)}">`;
  const html = `<p>Unemployment fell to 4.2 percent in the last quarter ${img} the Labor Department said on Friday.</p>`;
  const [para] = extractParagraphs(html, { minChars: 20 });
  assert.ok(para, 'the paragraph is still found');
  assert.ok(!para.includes('base64') && !para.includes('<'), `markup leaked into the text: ${para.slice(0, 80)}`);
  assert.match(para, /4\.2 percent in the last quarter the Labor Department said/);
});
