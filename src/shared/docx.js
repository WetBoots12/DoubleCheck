// A works cited page as a real Word document.
//
// A .docx is a ZIP archive of XML parts, so producing one without a library means
// writing the archive by hand. That is what this file does: a store-only ZIP writer
// with a correct CRC-32, and the smallest Open Packaging Conventions package Word
// will open. It is not a general-purpose zip library and does not try to be; it
// writes a handful of small text parts and nothing else.
//
// Store-only, meaning no compression. The ZIP format allows it, every reader accepts
// it, and the alternative is implementing DEFLATE. The documents here are a few
// kilobytes of text, so the saving would be invisible and the risk would not be.
//
// Pure: no DOM, no network, no chrome.*. Returns bytes; the caller wraps them in a
// Blob and hands them to the reader.

const encoder = new TextEncoder();

// --- CRC-32, which every ZIP entry needs and no runtime provides -------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// --- the archive ---------------------------------------------------------------------

// Every multi-byte field in a ZIP is little-endian, and a reader that finds otherwise
// rejects the file rather than guessing.
function writer() {
  const parts = [];
  let length = 0;
  const push = (bytes) => { parts.push(bytes); length += bytes.length; };
  return {
    get length() { return length; },
    bytes: push,
    u16(v) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v & 0xffff, true); push(b); },
    u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); push(b); },
    done() {
      const out = new Uint8Array(length);
      let at = 0;
      for (const p of parts) { out.set(p, at); at += p.length; }
      return out;
    },
  };
}

// MS-DOS packs a timestamp into two 16-bit words, with two-second resolution and a
// year counted from 1980. Fixed by default so the same list produces the same bytes,
// which is what makes the output testable.
function dosDateTime(date) {
  if (!date) return { time: 0, date: 0x0021 }; // 1 January 1980, midnight
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return { time: 0, date: 0x0021 };
  const year = Math.max(1980, d.getUTCFullYear());
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

// files: [{ name, text }]. Returns the archive as bytes.
export function zip(files, { modified = null } = {}) {
  const stamp = dosDateTime(modified);
  const out = writer();
  const central = [];

  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = encoder.encode(file.text);
    const sum = crc32(data);
    const offset = out.length;

    // Local file header.
    out.u32(0x04034b50);
    out.u16(20);           // version needed to extract: 2.0
    out.u16(0x0800);       // names and comments are UTF-8
    out.u16(0);            // stored, not deflated
    out.u16(stamp.time);
    out.u16(stamp.date);
    out.u32(sum);
    out.u32(data.length);  // compressed size, which for stored is the real size
    out.u32(data.length);
    out.u16(name.length);
    out.u16(0);            // no extra field
    out.bytes(name);
    out.bytes(data);

    central.push({ name, sum, size: data.length, offset });
  }

  const directoryAt = out.length;
  for (const entry of central) {
    out.u32(0x02014b50);
    out.u16(20);           // version made by
    out.u16(20);           // version needed
    out.u16(0x0800);
    out.u16(0);
    out.u16(stamp.time);
    out.u16(stamp.date);
    out.u32(entry.sum);
    out.u32(entry.size);
    out.u32(entry.size);
    out.u16(entry.name.length);
    out.u16(0);            // extra
    out.u16(0);            // comment
    out.u16(0);            // disk this entry starts on
    out.u16(0);            // internal attributes
    out.u32(0);            // external attributes
    out.u32(entry.offset);
    out.bytes(entry.name);
  }
  const directorySize = out.length - directoryAt;

  // End of central directory.
  out.u32(0x06054b50);
  out.u16(0);
  out.u16(0);
  out.u16(central.length);
  out.u16(central.length);
  out.u32(directorySize);
  out.u32(directoryAt);
  out.u16(0);              // no archive comment

  return out.done();
}

// --- the document -----------------------------------------------------------------------

// Characters XML 1.0 will not carry at all, whatever they are escaped as. Tab,
// newline and carriage return are the three below 0x20 that are legal; the rest are
// forbidden outright, and a document containing one is rejected by the parser rather
// than rendered oddly.
//
// They reach here from a page's own meta tags. Collapsing whitespace does not remove
// them, because a control byte is not whitespace, so one in a headline used to travel
// all the way into word/document.xml. Microsoft's parser was the thing that noticed:
// "hexadecimal value 0x01, is an invalid character."
// Legal below 0x20: tab, newline, carriage return. Everything else there is
// forbidden outright, as are the two non-characters at the end of the plane.
// Written as a code-point test rather than a character class, because a class of
// control characters is the kind of thing an editing layer turns into the literal
// bytes it describes.
function stripForbidden(text) {
  let out = '';
  for (const ch of String(text || '')) {
    const c = ch.codePointAt(0);
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) continue;
    if (c === 0xfffe || c === 0xffff) continue;
    out += ch;
  }
  return out;
}

// The five characters XML cannot carry literally. Anything else, including every
// accent and dash a citation contains, goes through as UTF-8.
export function escapeXml(text) {
  return stripForbidden(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// A run of text. xml:space="preserve" matters: without it Word eats the space
// between a title and the italic publication that follows it.
function run(segment) {
  const properties = segment.italic ? '<w:rPr><w:i/></w:rPr>' : '';
  return `<w:r>${properties}<w:t xml:space="preserve">${escapeXml(segment.text)}</w:t></w:r>`;
}

// Double spacing, and a hanging indent so an entry's second line sits half an inch
// in. Both are counted in twentieths of a point, which is what Word measures in.
const SPACING = '<w:spacing w:line="480" w:lineRule="auto" w:after="0"/>';
const HANGING = '<w:ind w:left="720" w:hanging="720"/>';

function paragraph(segments, properties) {
  return `<w:p><w:pPr>${properties}${SPACING}</w:pPr>${segments.map(run).join('')}</w:p>`;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOCUMENT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

// Without this the document opens in whatever the reader's Word defaults to, which
// is not the twelve-point serif every one of these style guides asks for.
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr>
<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/>
<w:sz w:val="24"/><w:szCs w:val="24"/>
</w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
</w:styles>`;

// entries: arrays of { text, italic } segments, one array per citation.
export function worksCitedDocx(entries, { title = 'Works Cited', modified = null } = {}) {
  const body = [
    paragraph([{ text: title, italic: false }], '<w:jc w:val="center"/>'),
    ...(entries || []).filter((e) => e && e.length).map((segments) => paragraph(segments, HANGING)),
  ].join('');

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body>
</w:document>`;

  // Order matters to some readers: the content types part must come first.
  return zip([
    { name: '[Content_Types].xml', text: CONTENT_TYPES },
    { name: '_rels/.rels', text: ROOT_RELS },
    { name: 'word/_rels/document.xml.rels', text: DOCUMENT_RELS },
    { name: 'word/document.xml', text: document },
    { name: 'word/styles.xml', text: STYLES },
  ], { modified });
}
