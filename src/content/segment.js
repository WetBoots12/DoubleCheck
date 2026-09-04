// Sentence segmentation shared by both content scripts.
//
// Uses the browser's Intl.Segmenter (ICU sentence rules) rather than a regex on
// terminal punctuation. That fixes quoted questions mid-sentence and abbreviations
// like "U.S.", "e.g." and "Inc.", but measured against real ICU it still breaks on
// honorifics: "Dr. Smith" and "Sen. McCain" each split into two. So a short
// abbreviation list merges those back. Anything without terminal punctuation, such
// as auto-generated captions, comes through as one segment either way.
//
// Loaded as a plain content script (they cannot use ES imports). It installs a
// global rather than exporting, which is also how the Node tests read it. The file
// must stay .js: Chrome refuses to inject content scripts with any other extension.

(function (root) {
  // Tokens that end in a period but do not end a sentence. Lower-case, no period.
  // "no" is deliberately absent: "No. 42" is an abbreviation but "voted no." is a
  // sentence end, so it is handled separately by looking at what follows.
  const ABBREVIATIONS = new Set([
    'mr', 'mrs', 'ms', 'dr', 'prof', 'sen', 'rep', 'gov', 'gen', 'col', 'capt', 'lt',
    'sgt', 'pres', 'hon', 'rev', 'st', 'mt', 'ft', 'vs', 'jr', 'sr',
    'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
    'inc', 'ltd', 'co', 'corp', 'dept', 'est', 'approx', 'fig', 'vol', 'ch', 'pp',
    'u.s', 'u.k', 'e.g', 'i.e', 'etc', 'al',
  ]);

  const segmenter =
    typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
      ? new Intl.Segmenter('en', { granularity: 'sentence' })
      : null;

  function rawSegments(flat) {
    if (segmenter) return [...segmenter.segment(flat)].map((s) => s.segment);
    // Fallback for engines without Intl.Segmenter (none of the supported browsers).
    return flat.split(/(?<=[.!?])\s+(?=[A-Z"'(])/);
  }

  // True when a segment ends with an abbreviation, meaning the break after it is
  // spurious and the next segment continues the same sentence. `next` is the text
  // that follows, consulted for the cases a word alone cannot settle.
  function endsWithAbbreviation(segment, next = '') {
    // Anchored to a word boundary, so "21st." is a sentence end and not "St.".
    const m = segment.trim().match(/(?:^|\s)([A-Za-z][A-Za-z.]*)\.$/);
    if (!m) return false;
    const token = m[1];
    const word = token.toLowerCase();
    if (ABBREVIATIONS.has(word)) return true;
    // "No. 42" continues; "voted no." ends. Only the number that follows tells them apart.
    if (word === 'no') return /^\s*\d/.test(next);
    // Single capital letter initials: "J. Smith", "George W. Bush".
    return /^[A-Z]$/.test(token);
  }

  // Splits text into sentences. Whitespace is collapsed first, and each result is a
  // contiguous substring of that collapsed text, which the highlighter relies on.
  function splitSentences(text, minLength = 0) {
    const flat = (text || '').replace(/\s+/g, ' ').trim();
    if (!flat) return [];

    const merged = [];
    for (const piece of rawSegments(flat)) {
      const last = merged.length - 1;
      if (last >= 0 && endsWithAbbreviation(merged[last], piece)) {
        merged[last] += piece;
      } else {
        merged.push(piece);
      }
    }

    return merged.map((s) => s.trim()).filter((s) => s.length > minLength);
  }

  // Sentences that are page furniture rather than content: sign-up pitches, legal
  // lines, sharing prompts, app plugs. They reach the extractor when a site puts
  // them in plain paragraphs, and a few carry numbers ("join 2 million readers")
  // that the classifier reads as claims. Matched anywhere in the sentence, so a real
  // claim that merely mentions a newsletter is lost too; that trade is deliberate.
  const BOILERPLATE = [
    /\b(sign(?:ing)? up|signup|subscribe|subscription|newsletter|unsubscribe)\b/i,
    /\b(enter your email|your inbox|delivered (?:straight )?to you|get the latest|stay (?:up to date|updated|informed))\b/i,
    /\b(terms of (?:service|use)|privacy policy|cookie policy|all rights reserved)\b/i,
    /\b(follow us|share this|click here|read more|learn more|sign in|log in|create an account|already have an account)\b/i,
    /\b(advertisement|sponsored content|paid partnership)\b/i,
    /\b(download (?:the|our) app|app store|google play)\b/i,
    /\b(support (?:our|independent) journalism|become a (?:member|supporter|subscriber)|donate (?:now|today))\b/i,
    /©|\(c\) \d{4}/,
  ];

  function isBoilerplate(sentence) {
    const s = (sentence || '').trim();
    return s.length > 0 && BOILERPLATE.some((re) => re.test(s));
  }

  const api = { splitSentences, endsWithAbbreviation, isBoilerplate, ABBREVIATIONS };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FCSegment = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
