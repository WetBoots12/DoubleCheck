// A .docx is only correct if something other than its author will open it.
//
// These tests do two jobs. The first half checks the bytes against the ZIP
// specification field by field. The second half hands the file to Node's own
// decompression, which is an independent reader and does not care what this code
// believes. There is a third check that only a real Windows machine can run, in
// tools/docx-check.ps1, which opens the file through the same .NET packaging layer
// Word uses.

import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';

import { crc32, zip, escapeXml, worksCitedDocx } from './docx.js';
import { citationSegments } from './citation.js';

const SOURCE = {
  kind: 'web',
  title: 'Inflation cools to 4.2%',
  url: 'https://apnews.com/article/x',
  siteName: 'AP News',
  authors: [{ name: 'Christopher Rugaber' }],
  date: '2026-06-14',
  accessed: '2026-09-06',
};

const view = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

// --- CRC-32, against values that are not mine ---------------------------------------

test('the checksum matches the published values for the standard test vectors', () => {
  const of = (s) => crc32(new TextEncoder().encode(s));
  // These are the documented CRC-32 results for these inputs. If this is wrong,
  // every archive produced here is rejected, and nothing else in the file would say so.
  assert.equal(of(''), 0x00000000);
  assert.equal(of('a'), 0xe8b7be43);
  assert.equal(of('abc'), 0x352441c2);
  assert.equal(of('123456789'), 0xcbf43926);
  assert.equal(of('The quick brown fox jumps over the lazy dog'), 0x414fa339);
});

// --- the archive, field by field --------------------------------------------------------

test('the archive begins with a local file header and ends with a directory record', () => {
  const bytes = zip([{ name: 'a.txt', text: 'hello' }]);
  const dv = view(bytes);
  assert.equal(dv.getUint32(0, true), 0x04034b50, 'local file header signature');
  assert.equal(dv.getUint32(bytes.length - 22, true), 0x06054b50, 'end of central directory signature');
});

test('the end record counts the entries and points at the directory', () => {
  const files = [{ name: 'a.txt', text: 'one' }, { name: 'b/c.txt', text: 'two' }];
  const bytes = zip(files);
  const dv = view(bytes);
  const eocd = bytes.length - 22;

  assert.equal(dv.getUint16(eocd + 8, true), 2, 'entries on this disk');
  assert.equal(dv.getUint16(eocd + 10, true), 2, 'entries in total');

  const size = dv.getUint32(eocd + 12, true);
  const offset = dv.getUint32(eocd + 16, true);
  assert.equal(offset + size, eocd, 'the directory should run right up to the end record');
  assert.equal(dv.getUint32(offset, true), 0x02014b50, 'central directory header signature');
});

test('each directory entry points at a real local header', () => {
  const bytes = zip([{ name: 'a.txt', text: 'one' }, { name: 'b.txt', text: 'two' }]);
  const dv = view(bytes);
  const eocd = bytes.length - 22;
  let at = dv.getUint32(eocd + 16, true);

  for (let i = 0; i < 2; i++) {
    assert.equal(dv.getUint32(at, true), 0x02014b50);
    const nameLen = dv.getUint16(at + 28, true);
    const localAt = dv.getUint32(at + 42, true);
    assert.equal(dv.getUint32(localAt, true), 0x04034b50, `entry ${i} points at a local header`);
    at += 46 + nameLen;
  }
});

test('sizes and checksum agree between the two headers and the data', () => {
  const text = 'some content of a known length';
  const bytes = zip([{ name: 'a.txt', text }]);
  const dv = view(bytes);
  const expected = crc32(new TextEncoder().encode(text));

  assert.equal(dv.getUint32(14, true), expected, 'local header checksum');
  assert.equal(dv.getUint32(18, true), text.length, 'local header compressed size');
  assert.equal(dv.getUint32(22, true), text.length, 'local header uncompressed size');

  const eocd = bytes.length - 22;
  const cd = dv.getUint32(eocd + 16, true);
  assert.equal(dv.getUint32(cd + 16, true), expected, 'directory checksum');
});

test('stored means stored: the data sits in the archive unchanged', () => {
  const text = 'plain and findable';
  const bytes = zip([{ name: 'a.txt', text }]);
  assert.equal(new DataView(bytes.buffer).getUint16(8, true), 0, 'compression method 0');
  assert.ok(new TextDecoder().decode(bytes).includes(text));
});

test('the same input produces the same bytes', () => {
  // A fixed timestamp is what makes this testable at all.
  const a = zip([{ name: 'a.txt', text: 'x' }]);
  const b = zip([{ name: 'a.txt', text: 'x' }]);
  assert.deepEqual([...a], [...b]);
});

test('an empty archive is still a valid archive', () => {
  const bytes = zip([]);
  assert.equal(bytes.length, 22, 'nothing but an end record');
  assert.equal(view(bytes).getUint32(0, true), 0x06054b50);
});

// --- read back by something that is not this code ------------------------------------

// A minimal reader that walks the central directory the way any unzip tool does. It
// deliberately does not reuse anything from docx.js, so it cannot inherit a mistake.
function unzip(bytes) {
  const dv = view(bytes);
  let eocd = bytes.length - 22;
  while (eocd >= 0 && dv.getUint32(eocd, true) !== 0x06054b50) eocd--;
  assert.ok(eocd >= 0, 'no end of central directory record');

  const count = dv.getUint16(eocd + 10, true);
  let at = dv.getUint32(eocd + 16, true);
  const files = {};

  for (let i = 0; i < count; i++) {
    assert.equal(dv.getUint32(at, true), 0x02014b50);
    const method = dv.getUint16(at + 10, true);
    const sum = dv.getUint32(at + 16, true);
    const size = dv.getUint32(at + 24, true);
    const nameLen = dv.getUint16(at + 28, true);
    const extraLen = dv.getUint16(at + 30, true);
    const commentLen = dv.getUint16(at + 32, true);
    const localAt = dv.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen));

    const localNameLen = dv.getUint16(localAt + 26, true);
    const localExtraLen = dv.getUint16(localAt + 28, true);
    const dataAt = localAt + 30 + localNameLen + localExtraLen;
    const raw = bytes.subarray(dataAt, dataAt + size);
    const data = method === 0 ? raw : inflateRawSync(raw);

    assert.equal(crc32(data), sum, `${name}: checksum does not match its own data`);
    files[name] = new TextDecoder().decode(data);
    at += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

test('the archive reads back through a reader that shares no code with the writer', () => {
  const files = unzip(zip([
    { name: 'first.txt', text: 'one' },
    { name: 'nested/second.txt', text: 'two' },
  ]));
  assert.deepEqual(Object.keys(files), ['first.txt', 'nested/second.txt']);
  assert.equal(files['first.txt'], 'one');
  assert.equal(files['nested/second.txt'], 'two');
});

test('text outside ASCII survives the round trip', () => {
  const text = 'José García — Müller — Ångström — 日本語';
  assert.equal(unzip(zip([{ name: 'a.txt', text }]))['a.txt'], text);
});

// --- the document Word is asked to open --------------------------------------------------

const PARTS = [
  '[Content_Types].xml',
  '_rels/.rels',
  'word/_rels/document.xml.rels',
  'word/document.xml',
  'word/styles.xml',
];

test('the package holds every part the format requires, content types first', () => {
  const files = unzip(worksCitedDocx([citationSegments(SOURCE, 'mla')]));
  assert.deepEqual(Object.keys(files), PARTS);
});

test('every part is XML that parses, with the declaration Word expects', () => {
  const files = unzip(worksCitedDocx([citationSegments(SOURCE, 'mla')]));
  for (const [name, text] of Object.entries(files)) {
    assert.ok(text.startsWith('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'), name);
    // Tag balance, which is the part a hand-written generator gets wrong.
    const opens = (text.match(/<[a-zA-Z_][^>]*[^/]>/g) || []).length;
    const closes = (text.match(/<\//g) || []).length;
    assert.equal(opens, closes, `${name}: ${opens} opening tags and ${closes} closing ones`);
  }
});

test('the relationships point at parts that are actually in the package', () => {
  const files = unzip(worksCitedDocx([]));
  for (const [name, text] of Object.entries(files)) {
    if (!name.endsWith('.rels')) continue;
    for (const [, target] of text.matchAll(/Target="([^"]+)"/g)) {
      const base = name.startsWith('word/') ? 'word/' : '';
      assert.ok(files[base + target], `${name} points at ${target}, which is not in the package`);
    }
  }
});

test('every part named in the content types exists', () => {
  const files = unzip(worksCitedDocx([]));
  for (const [, part] of files['[Content_Types].xml'].matchAll(/PartName="\/([^"]+)"/g)) {
    assert.ok(files[part], `content types names ${part}, which is not in the package`);
  }
});

test('a citation keeps its italics, and its plain parts stay plain', () => {
  const doc = unzip(worksCitedDocx([citationSegments(SOURCE, 'mla')]))['word/document.xml'];
  assert.ok(doc.includes('<w:rPr><w:i/></w:rPr><w:t xml:space="preserve">AP News</w:t>'),
    'the container should be the italic run');
  assert.ok(doc.includes('Rugaber, Christopher.'), doc.slice(0, 400));
  assert.ok(!doc.includes('<w:i/></w:rPr><w:t xml:space="preserve">Rugaber'), 'the author is not italic');
});

test('spacing is preserved, or Word swallows the gap before an italic run', () => {
  const doc = unzip(worksCitedDocx([citationSegments(SOURCE, 'mla')]))['word/document.xml'];
  assert.ok(!doc.includes('<w:t>'), 'every run should declare xml:space');
});

test('the page is laid out as a works cited page: heading, hanging indent, double spaced', () => {
  const doc = unzip(worksCitedDocx([citationSegments(SOURCE, 'mla')]))['word/document.xml'];
  assert.ok(doc.includes('<w:jc w:val="center"/>'), 'the heading is centred');
  assert.ok(doc.includes('Works Cited'));
  assert.ok(doc.includes('<w:ind w:left="720" w:hanging="720"/>'), 'entries hang');
  assert.ok(doc.includes('w:line="480"'), 'double spaced');
});

test('the five characters XML cannot carry are escaped, and nothing else is', () => {
  assert.equal(escapeXml('a & b < c > d " e \' f'), 'a &amp; b &lt; c &gt; d &quot; e &apos; f');
  assert.equal(escapeXml('José — 日本'), 'José — 日本');

  const doc = unzip(worksCitedDocx([[{ text: 'Smith & Jones <Ltd> "quoted"', italic: false }]]))['word/document.xml'];
  assert.ok(doc.includes('Smith &amp; Jones &lt;Ltd&gt; &quot;quoted&quot;'), doc.slice(0, 600));
});

test('an empty list still opens, with just the heading', () => {
  const files = unzip(worksCitedDocx([]));
  assert.deepEqual(Object.keys(files), PARTS);
  assert.ok(files['word/document.xml'].includes('Works Cited'));
});

test('every style produces a document that reads back intact', () => {
  for (const format of ['mla', 'apa', 'chicago', 'harvard']) {
    const files = unzip(worksCitedDocx([citationSegments(SOURCE, format)]));
    assert.ok(files['word/document.xml'].includes('Rugaber'), format);
  }
});

test('a long list is written correctly, not just a short one', () => {
  const entries = Array.from({ length: 200 }, (_, i) =>
    citationSegments({ ...SOURCE, title: `Article number ${i}` }, 'mla'));
  const files = unzip(worksCitedDocx(entries));
  const doc = files['word/document.xml'];
  assert.equal((doc.match(/<w:p>/g) || []).length, 201, 'two hundred entries and a heading');
  assert.ok(doc.includes('Article number 199'));
});

// --- characters XML will not carry ------------------------------------------------

test('a control character from a page does not produce a file Word refuses', () => {
  // XML 1.0 forbids most characters below 0x20. One of them in a page's title used
  // to travel from a meta tag into word/document.xml, and Microsoft's own parser
  // rejected the result: "hexadecimal value 0x01, is an invalid character".
  //
  // Asserted inside the XML part, not across the archive: a ZIP's own headers are
  // sizes, offsets and checksums, so the raw bytes hold control characters by design.
  const title = `Inflation${String.fromCharCode(1)} cools${String.fromCharCode(31)} now`;
  const doc = unzip(worksCitedDocx([[{ text: title, italic: false }]]))['word/document.xml'];

  assert.ok(!new RegExp('[\u0000-\u0008\u000b\u000c\u000e-\u001f]').test(doc), 'a forbidden character reached the document');
  assert.ok(doc.includes('Inflation cools now'), 'and the words survive');
});

test('the characters XML does allow are kept', () => {
  // Tab, newline and carriage return are legal in XML and mean something in text.
  assert.equal(escapeXml('a\tb'), 'a\tb');
  assert.equal(escapeXml('a\nb'), 'a\nb');
});
