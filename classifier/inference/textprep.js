// Two small rewrites applied to a sentence before it is scored.
//
// IMPORTANT: classifier/train/textprep.py is the same code in Python, and the two
// must produce identical strings. A fixture written by the Python side is checked
// against this file by scorer.test.mjs. Change one, change both.
//
// 1. Numbers written as words become digits. The model's strongest signal is a
//    digit, and the claims it missed on the benchmark were the ones that spelled the
//    figure out: "a tenth of the power", "a quarter of the world's cobalt", "two of
//    its emergency wards". Rewriting "a quarter" as "0.25" lets the same weights
//    see the same thing, without a second feature that would only overlap the first.
//
// 2. Runs of capitalised words become one ENTITY token. The training data is
//    political debate, and its heaviest learned terms are the people in the room:
//    hillary, clinton, obama, castro, assad. None of them says anything about
//    whether a sentence is a claim. Masking names lets the model learn that a
//    sentence shaped "ENTITY raised rates by 0.25 point" is a claim whoever ENTITY
//    is, and it costs nothing in vocabulary because thousands of names collapse
//    into one term.
//
// Both are deterministic and need no dictionary beyond the number words. The
// entity rule is capitalisation, which is what the page gives us; it cannot see a
// name in lowercase caption text, and that is measured rather than assumed.
//
// Pure: no DOM, no chrome.*.

// The token a masked run becomes. Chosen so it cannot collide with an English word
// and carries no digit, which would fire the digit feature on every name.
export const ENTITY_TOKEN = 'xent';

// --- numbers ---------------------------------------------------------------------------

const UNITS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SMALL_SCALES = { hundred: 100, thousand: 1000 };
const BIG_SCALES = ['million', 'billion', 'trillion'];

const NUMBER_WORD = [...Object.keys(UNITS), ...Object.keys(TENS), ...Object.keys(SMALL_SCALES)].join('|');

// A run of number words joined by spaces, hyphens or "and": "forty thousand",
// "twenty-one", "four hundred and fifty". Optionally followed by million/billion,
// which is kept as a word because the model already weighs it.
const NUMBER_RUN = new RegExp(
  `\\b(?:${NUMBER_WORD})(?:(?:[\\s-]+|[\\s-]+and[\\s-]+)(?:${NUMBER_WORD}))*\\b`,
  'gi',
);

// "one" alone is a pronoun as often as a number: "one of the", "no one", "one
// possible explanation". It is rewritten only where it is clearly counting.
const ONE_COUNTS_BEFORE = /^\s+(in|percent|per|million|billion|trillion)\b/i;

const FRACTIONS = [
  // [pattern, replacement]. Order matters: the longer forms first.
  [/\b(two|2)[\s-]thirds\b/gi, '0.67'],
  [/\b(three|3)[\s-]quarters\b/gi, '0.75'],
  [/\b(two|2)[\s-]fifths\b/gi, '0.4'],
  [/\b(three|3)[\s-]fifths\b/gi, '0.6'],
  [/\b(a|one)[\s-]half\b/gi, '0.5'],
  [/\b(a|one)[\s-]third\b/gi, '0.33'],
  [/\b(a|one)[\s-]quarter\b/gi, '0.25'],
  [/\b(a|one)[\s-]fifth\b/gi, '0.2'],
  [/\b(a|one)[\s-]sixth\b/gi, '0.17'],
  [/\b(an|one)[\s-]eighth\b/gi, '0.13'],
  [/\b(a|one)[\s-]tenth\b/gi, '0.1'],
  // "half its coral cover", "half of the country": the fraction, not "the second
  // half" or "half-time", which are left alone.
  [/\bhalf(?=\s+(of|its|the|a|an|as|their|his|her|our|all|that|this)\b)/gi, '0.5'],
  [/\ba dozen\b/gi, '12'],
  [/\btwice\b/gi, '2 times'],
];

// "nineteen ninety five" and "twenty twenty-four" are how captions spell a year:
// a century word followed by a tens word, which is not how any other quantity is
// said. Anything else goes through the ordinary adding-up.
function spokenYear(words) {
  if (words.length < 2 || words.length > 3) return null;
  const [century, tens, unit] = words;
  if (!(century === 'nineteen' || century === 'twenty') || !(tens in TENS)) return null;
  if (unit !== undefined && !(unit in UNITS && UNITS[unit] < 10)) return null;
  return (century === 'nineteen' ? 1900 : 2000) + TENS[tens] + (unit ? UNITS[unit] : 0);
}

function wordsToNumber(run) {
  const words = run.toLowerCase().split(/[\s-]+/).filter((w) => w && w !== 'and');
  const year = spokenYear(words);
  if (year !== null) return year;
  let total = 0;
  let current = 0;
  for (const w of words) {
    if (w in UNITS) current += UNITS[w];
    else if (w in TENS) current += TENS[w];
    else if (w === 'hundred') current = (current || 1) * 100;
    else if (w === 'thousand') { total += (current || 1) * 1000; current = 0; }
  }
  return total + current;
}

export function normalizeNumbers(text) {
  let out = String(text || '');
  for (const [re, rep] of FRACTIONS) out = out.replace(re, rep);
  out = out.replace(/\ba (hundred|thousand)\b/gi, (_, s) => String(SMALL_SCALES[s.toLowerCase()]));
  out = out.replace(NUMBER_RUN, (run, offset, whole) => {
    const lower = run.toLowerCase();
    if (lower === 'one') {
      const before = whole.slice(Math.max(0, offset - 3), offset).toLowerCase();
      if (/\bno\s$/.test(before)) return run;
      const after = whole.slice(offset + run.length);
      if (/^\s+another\b/i.test(after)) return run;
      if (!ONE_COUNTS_BEFORE.test(after)) return run;
    }
    return String(wordsToNumber(run));
  });
  return out;
}

// --- entities --------------------------------------------------------------------------

// Words that begin a sentence because of grammar rather than because they are a
// name, so a capital at position zero is not evidence on its own.
const OPENERS = new Set(('the a an this that these those many some most all both each '
  + 'his her their our its it he she they we you more fewer several few').split(' '));

function core(word) {
  return word.replace(/^[^A-Za-z]+/, '').replace(/[^A-Za-z'’]+$/, '');
}

// Capitalised, at least two letters, not the pronoun I or one of its contractions.
function looksLikeName(c) {
  if (c.length < 2) return false;
  if (c === 'I' || c.startsWith("I'") || c.startsWith('I’')) return false;
  return /^[A-Z][A-Za-z'’]*$/.test(c);
}

export function maskEntities(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  const cores = words.map(core);
  const named = cores.map((c, i) => {
    if (!looksLikeName(c)) return false;
    // The first word is capitalised whatever it is. It counts as a name only when
    // the word after it is capitalised too, "Federal Reserve", "Man City"; a lone
    // "Tesla" at the start is left as a word, as it was before.
    if (i === 0) return !OPENERS.has(c.toLowerCase()) && cores.length > 1 && looksLikeName(cores[1]);
    return true;
  });

  const out = [];
  for (let i = 0; i < words.length; i++) {
    if (!named[i]) { out.push(words[i]); continue; }
    if (i > 0 && named[i - 1]) continue; // same run as the word before
    out.push(ENTITY_TOKEN);
  }
  return out.join(' ');
}

// What a model asks for, read from its file. A model trained without the pre-pass
// declares nothing and is scored exactly as before.
export function prepare(model, text) {
  const numbers = Boolean(model?.preprocess?.numbers);
  const entities = Boolean(model?.preprocess?.entities);
  const featureText = numbers ? normalizeNumbers(text) : String(text || '');
  const tokenText = entities ? maskEntities(featureText) : featureText;
  return { featureText, tokenText };
}
