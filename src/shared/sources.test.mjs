import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SOURCE_LIMIT, sourceKey, makeSource, addSource, removeSource, hasSource, citableSources,
} from './sources.js';
import { worksCitedRtf, worksCitedText } from './rtf.js';
import { citationSegments, formatCitation } from './citation.js';

const AT = Date.UTC(2026, 8, 6);

const PAGE = {
  url: 'https://www.apnews.com/article/inflation',
  title: 'Inflation cools to 4.2%',
  siteName: 'AP News',
  authors: [{ name: 'Christopher Rugaber' }],
  date: '2026-06-14',
};

// --- what counts as the same source ------------------------------------------------

test('tracking parameters and a fragment do not make a second source', () => {
  const a = sourceKey('https://www.apnews.com/article/x?utm_source=twitter&utm_medium=social#top');
  const b = sourceKey('https://apnews.com/article/x');
  assert.equal(a, b);
});

test('a parameter that is part of the address is kept', () => {
  // ?id=123 selects the article; dropping it would point at a different page.
  assert.notEqual(sourceKey('https://example.com/a?id=123'), sourceKey('https://example.com/a'));
});

test('something that is not an address still gets a stable key', () => {
  assert.equal(sourceKey('not an address'), 'not an address');
  assert.equal(sourceKey(''), '');
});

// --- building a record ----------------------------------------------------------------

test('a page becomes a record with the day it was kept', () => {
  const s = makeSource(PAGE, AT);
  assert.equal(s.url, PAGE.url);
  assert.equal(s.title, 'Inflation cools to 4.2%');
  assert.equal(s.accessed, '2026-09-06');
  assert.equal(s.addedAt, AT);
});

test('a record with no address is not a record', () => {
  for (const bad of [{}, { url: '' }, { url: '   ' }, null]) {
    assert.equal(makeSource(bad, AT), null);
  }
});

test('empty author entries are dropped rather than stored as blanks', () => {
  const s = makeSource({ ...PAGE, authors: [{ name: '' }, 'Jane Doe', { name: '  ' }] }, AT);
  assert.deepEqual(s.authors, ['Jane Doe']);
});

// --- the list -------------------------------------------------------------------------

test('a source is kept, newest first', () => {
  let list = [];
  ({ list } = addSource(list, makeSource(PAGE, AT)));
  ({ list } = addSource(list, makeSource({ ...PAGE, url: 'https://bbc.co.uk/b', title: 'Second' }, AT + 1)));
  assert.deepEqual(list.map((s) => s.title), ['Second', 'Inflation cools to 4.2%']);
});

test('keeping the same page again replaces the entry rather than duplicating it', () => {
  // A reader pressing the button again is usually fixing something, so the fresh
  // read wins.
  let list = [];
  ({ list } = addSource(list, makeSource(PAGE, AT)));
  const again = addSource(list, makeSource({ ...PAGE, title: 'A corrected headline' }, AT + 5));

  assert.equal(again.list.length, 1);
  assert.equal(again.replaced, true);
  assert.equal(again.list[0].title, 'A corrected headline');
});

test('the same page with tracking parameters is the same entry', () => {
  let list = [];
  ({ list } = addSource(list, makeSource(PAGE, AT)));
  const again = addSource(list, makeSource({ ...PAGE, url: `${PAGE.url}?utm_source=x` }, AT + 5));
  assert.equal(again.list.length, 1);
  assert.equal(again.replaced, true);
});

test('the list is capped, and the oldest fall off', () => {
  let list = [];
  for (let i = 0; i < SOURCE_LIMIT + 20; i++) {
    ({ list } = addSource(list, makeSource({ ...PAGE, url: `https://example.com/${i}` }, AT + i)));
  }
  assert.equal(list.length, SOURCE_LIMIT);
  assert.equal(list[0].url, `https://example.com/${SOURCE_LIMIT + 19}`, 'newest is kept');
  assert.ok(!list.some((s) => s.url === 'https://example.com/0'), 'oldest is dropped');
});

test('a record that could not be built changes nothing', () => {
  const list = [makeSource(PAGE, AT)];
  const res = addSource(list, null);
  assert.equal(res.added, false);
  assert.equal(res.list.length, 1);
});

test('a source can be removed, and asked about', () => {
  let list = [];
  ({ list } = addSource(list, makeSource(PAGE, AT)));
  assert.equal(hasSource(list, `${PAGE.url}#somewhere`), true);
  assert.equal(hasSource(list, 'https://elsewhere.example'), false);
  assert.deepEqual(removeSource(list, sourceKey(PAGE.url)), []);
});

// --- the list is already what a citation needs -------------------------------------------

test('a kept source cites without any further translation', () => {
  const list = [makeSource(PAGE, AT)];
  const [source] = citableSources(list);
  assert.equal(formatCitation(source, 'mla'),
    'Rugaber, Christopher. "Inflation cools to 4.2%." AP News, 14 June 2026, '
    + 'www.apnews.com/article/inflation. Accessed 6 Sept. 2026.');
});

test('bookkeeping fields do not leak into a citation', () => {
  const [source] = citableSources([makeSource(PAGE, AT)]);
  assert.equal(source.addedAt, undefined);
  assert.equal(source.key, undefined);
});

// --- the file a word processor opens --------------------------------------------------

test('the RTF carries the italics that plain text cannot', () => {
  const rtf = worksCitedRtf([citationSegments(citableSources([makeSource(PAGE, AT)])[0], 'mla')]);
  assert.ok(rtf.includes('{\\i AP News}'), 'the container should be italic');
  assert.ok(rtf.startsWith('{\\rtf1'));
  assert.ok(rtf.trimEnd().endsWith('}'));
});

test('a works cited page is laid out as one: hanging indent, double spaced', () => {
  const rtf = worksCitedRtf([citationSegments(citableSources([makeSource(PAGE, AT)])[0], 'mla')]);
  assert.ok(rtf.includes('\\li720\\fi-720'), 'second lines should be indented');
  assert.ok(rtf.includes('\\sl480'), 'double spaced');
  assert.ok(rtf.includes('Works Cited'));
});

test('the three characters that mean something to RTF are escaped', () => {
  const rtf = worksCitedRtf([[{ text: 'A title with \\ and { and }', italic: false }]]);
  assert.ok(rtf.includes('A title with \\\\ and \\{ and \\}'), rtf);
});

test('accents and other letters survive as escapes a word processor understands', () => {
  const rtf = worksCitedRtf([[{ text: 'José García — Müller', italic: false }]]);
  assert.ok(![...rtf].some((c) => c.codePointAt(0) > 127), 'the file should be plain ASCII');
  assert.ok(rtf.includes('\\u233?'), 'e-acute');
  assert.ok(rtf.includes('\\u8212?'), 'em dash');
});

test('a character outside the basic plane is written as its two halves', () => {
  const rtf = worksCitedRtf([[{ text: '\u{1F600}', italic: false }]]);
  assert.ok(rtf.includes('\\u-10179?\\u-8704?'), rtf);
});

test('an empty list still produces a file that opens', () => {
  const rtf = worksCitedRtf([]);
  assert.ok(rtf.startsWith('{\\rtf1'));
  assert.ok(rtf.trimEnd().endsWith('}'));
  assert.ok(rtf.includes('Works Cited'));
});

test('the plain text export is the same list under a heading', () => {
  const text = worksCitedText(['Adams, Alan. "One."', 'Young, Zoe. "Two."']);
  assert.equal(text, 'Works Cited\n\nAdams, Alan. "One."\nYoung, Zoe. "Two."');
});

test('a control character does not reach the rich text file either', () => {
  const rtf = worksCitedRtf([[{ text: 'Inflation\u0001 cools\u001f now', italic: false }]]);
  assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(rtf), 'a control character survived');
  assert.ok(rtf.includes('Inflation cools now'));
});
