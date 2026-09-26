// Locating a sentence inside a page's text nodes.
//
// A sentence rarely lives in one text node: links, bold phrases, and inline spans
// split it into several. The extracted sentence is also whitespace-collapsed, while
// the DOM keeps the original newlines and indentation, and often non-breaking
// spaces. So a plain indexOf against a single node's text misses most real
// sentences, which is why many flagged claims never got highlighted.
//
// buildMatchPlan concatenates the text nodes into one whitespace-normalized string,
// remembering where every normalized character came from, finds the sentence in
// that, and reports the per-node character ranges to wrap.
//
// Loaded as a plain content script (they cannot use ES imports). It installs a
// global rather than exporting, which is also how the Node tests read it. The file
// must stay .js: Chrome refuses to inject content scripts with any other extension.

(function (root) {
  function normalize(text) {
    return text.replace(/\s+/g, ' ').trim();
  }

  // Returns [{ nodeIndex, start, end }] covering the sentence, or null if absent.
  // Ranges are half-open: [start, end).
  function buildMatchIndex(nodeTexts) {

    let flat = '';
    const origin = []; // origin[i] = [nodeIndex, offsetWithinNode] for flat[i]
    let lastWasSpace = true; // also trims leading whitespace

    for (let n = 0; n < nodeTexts.length; n++) {
      const raw = nodeTexts[n] || '';
      for (let i = 0; i < raw.length; i++) {
        const ch = raw[i];
        if (/\s/.test(ch)) {
          // \s covers the non-breaking spaces innerText commonly yields.
          if (lastWasSpace) continue;
          flat += ' ';
          origin.push([n, i]);
          lastWasSpace = true;
        } else {
          flat += ch;
          origin.push([n, i]);
          lastWasSpace = false;
        }
      }
    }

    return { flat, origin };
  }

  function planFromIndex({ flat, origin }, needle) {
    const target = normalize(needle || '');
    if (!target) return null;
    const at = flat.indexOf(target);
    if (at === -1) return null;

    const spans = [];
    let node = origin[at][0];
    let start = origin[at][1];
    let end = start;

    for (let k = at; k < at + target.length; k++) {
      const [n, offset] = origin[k];
      if (n !== node) {
        spans.push({ nodeIndex: node, start, end: end + 1 });
        node = n;
        start = offset;
      }
      end = offset;
    }
    spans.push({ nodeIndex: node, start, end: end + 1 });
    return spans;
  }

  function buildMatchPlan(nodeTexts, needle) {
    return planFromIndex(buildMatchIndex(nodeTexts), needle);
  }
  const api = { normalize, buildMatchPlan, buildMatchIndex, planFromIndex };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FCTextMatch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
