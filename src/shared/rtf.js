// A works cited page as a file Word will open.
//
// Rich Text Format rather than .docx, and the reason is worth stating. A .docx is a
// zip archive of XML, and this extension has no dependencies and no build step, so
// producing one means hand-writing a zip writer. RTF is plain text, every word
// processor in common use opens it, and unlike a .txt it carries the italics that
// MLA and APA require on a container or a journal title. Those italics are the whole
// reason a citation export is not simply a text file.
//
// Pure: no DOM, no network, no chrome.*.

// RTF is a plain-text format with three characters that mean something structural,
// and a document that does not escape them is a document that will not open.
function escapeRtf(text) {
  let out = '';
  for (const ch of String(text || '')) {
    const code = ch.codePointAt(0);
    // Control characters mean nothing in a citation and arrive only from a page's
    // own markup. They are dropped for the same reason the Word writer drops them:
    // a document is not the place to pass a stray byte along.
    if (code < 0x20 && ch !== '\n') continue;
    if (ch === '\\' || ch === '{' || ch === '}') out += `\\${ch}`;
    else if (ch === '\n') out += '\\line ';
    else if (code < 128) out += ch;
    else if (code <= 0xffff) {
      // \uN is a signed 16-bit integer, so anything above 32767 is written negative.
      // The question mark after it is what a reader too old to understand \u shows
      // instead, and it is required rather than decorative.
      out += `\\u${code > 32767 ? code - 65536 : code}?`;
    } else {
      // Outside the basic plane, RTF wants the two surrogates separately.
      const v = code - 0x10000;
      const hi = 0xd800 + (v >> 10);
      const lo = 0xdc00 + (v & 0x3ff);
      out += `\\u${hi - 65536}?\\u${lo - 65536}?`;
    }
  }
  return out;
}

function runs(segments) {
  return segments
    .map((s) => (s.italic ? `{\\i ${escapeRtf(s.text)}}` : escapeRtf(s.text)))
    .join('');
}

// entries: arrays of { text, italic } segments, one array per citation.
//
// The paragraph settings are what a works cited page actually looks like: double
// spaced, and a hanging indent so the second line of an entry sits half an inch in.
// \li720\fi-720 is that indent in twips, which is the unit RTF counts in.
export function worksCitedRtf(entries, { title = 'Works Cited' } = {}) {
  const body = (entries || [])
    .filter((e) => e && e.length)
    .map((segments) => `\\li720\\fi-720\\sl480\\slmult1 ${runs(segments)}\\par`)
    .join('\n');

  return [
    '{\\rtf1\\ansi\\ansicpg1252\\deff0',
    '{\\fonttbl{\\f0\\froman\\fcharset0 Times New Roman;}}',
    '\\f0\\fs24',
    `\\qc\\sl480\\slmult1 ${escapeRtf(title)}\\par`,
    '\\ql',
    body,
    '}',
  ].filter(Boolean).join('\n');
}

// The same list as plain text, for readers who want it that way.
export function worksCitedText(lines, { title = 'Works Cited' } = {}) {
  return [title, '', ...(lines || [])].join('\n');
}
