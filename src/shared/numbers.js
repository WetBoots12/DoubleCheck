// Comparing the figures in a claim with the figures in a source.
//
// Lexical overlap counts numbers double, on the reasoning that a factual claim
// usually turns on one. But overlap only ever notices agreement. If the claim says
// inflation rose to 8.2 percent and the source says inflation was 2.1 percent, the
// words "inflation" and "percent" match, the source looks relevant, and the flat
// contradiction between the two figures goes unmentioned. That is the case a reader
// most needs pointed out.
//
// So: pull the quantities out of both, pair them up by unit and by what they are
// quantities of, and say plainly when the paired numbers disagree.
//
// This reports a disagreement between two texts. It is not a verdict on the claim:
// the source may be about a different month, a different country, or simply wrong.
// The panel shows it as something to look at, which is the whole posture of the
// extension.
//
// Pure: no DOM, no network, no chrome.*.

const SCALES = {
  k: 1e3, thousand: 1e3, thousands: 1e3,
  m: 1e6, million: 1e6, millions: 1e6, mn: 1e6,
  bn: 1e9, billion: 1e9, billions: 1e9,
  tn: 1e12, trillion: 1e12, trillions: 1e12,
};

const CURRENCY = { $: 'usd', '£': 'gbp', '€': 'eur', '¥': 'jpy' };
const CURRENCY_WORDS = { dollars: 'usd', dollar: 'usd', pounds: 'gbp', pound: 'gbp', euros: 'eur', euro: 'eur', yen: 'jpy' };

const STOPWORDS = new Set(('a an the and or but if then than that this these those of in on at to for with from by as '
  + 'is are was were be been being it its he she they we you his her their our your not no do does did has have had '
  + 'will would could should may might can said says according also more most about into over under after before '
  + 'about roughly around nearly almost just only up down out')
  .split(' '));

// Matches "4.2 percent", "4.2%", "$5 billion", "5 billion dollars", "12,000",
// "1.2m", "3 percentage points".
// The word suffixes carry their own \b so that "12 metres" is not read as 12
// million; the percent sign cannot, because there is no word boundary after it,
// and a trailing \b on the whole group silently dropped every "8.2%".
const QUANTITY = /(?:([$£€¥])\s*)?(\d[\d,]*(?:\.\d+)?)\s*(%|(?:percent(?:age)?(?:\s+points?)?|k|mn?|bn|tn|thousand|million|billion|trillion)\b)?/gi;

function words(text) {
  return (String(text || '').toLowerCase().match(/[a-z][a-z'-]*/g) || []).filter((w) => !STOPWORDS.has(w));
}

// The words around a figure, which say what it is a quantity of.
function contextAround(text, start, end) {
  const before = words(text.slice(Math.max(0, start - 60), start)).slice(-4);
  const after = words(text.slice(end, end + 40)).slice(0, 3);
  return new Set([...before, ...after]);
}

export function extractQuantities(text) {
  const source = String(text || '');
  const out = [];
  QUANTITY.lastIndex = 0;
  let m;
  while ((m = QUANTITY.exec(source)) !== null) {
    const [whole, symbol, digits, suffixRaw] = m;
    if (!digits) continue;
    const suffix = (suffixRaw || '').toLowerCase().trim();
    const plain = Number(digits.replace(/,/g, ''));
    if (!Number.isFinite(plain)) continue;

    const trailing = source.slice(m.index + whole.length, m.index + whole.length + 12).toLowerCase();
    const currencyWord = Object.keys(CURRENCY_WORDS).find((w) => new RegExp(`^\\s*${w}\\b`).test(trailing));

    let unit = 'count';
    if (suffix.startsWith('%') || suffix.startsWith('percent')) unit = 'percent';
    else if (symbol) unit = CURRENCY[symbol];
    else if (currencyWord) unit = CURRENCY_WORDS[currencyWord];

    // A four-digit number used as a date is not a quantity. Dates belong to
    // shared/dates.js, and comparing them here would read as "the claim says 2023
    // and the source says 2019", which is not a contradiction between figures.
    // It is only a year when it is being used as one: "in 2019", "since 2019".
    // "2019 people" is a count that happens to look like a year.
    const lead = source.slice(Math.max(0, m.index - 20), m.index).toLowerCase();
    const looksLikeYear = unit === 'count' && !suffix && /^(19|20)\d{2}$/.test(digits)
      && /\b(in|since|by|from|until|till|during|before|after|of|for)\s*$/.test(lead);
    if (looksLikeYear) continue;

    const scale = SCALES[suffix] || 1;
    out.push({
      value: plain * scale,
      unit,
      raw: whole.trim() + (currencyWord ? ` ${currencyWord}` : ''),
      context: contextAround(source, m.index, m.index + whole.length),
    });
  }
  return out;
}

function overlap(a, b) {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n;
}

// Two figures are the same figure when they are within a whisker of each other.
// Rounding differs between outlets: 4.2 and 4.24 are one number reported twice.
const TOLERANCE = 0.02;

export function sameValue(a, b, tolerance = TOLERANCE) {
  if (a === b) return true;
  const scale = Math.max(Math.abs(a), Math.abs(b));
  if (!scale) return true;
  return Math.abs(a - b) / scale <= tolerance;
}

export function formatValue(q) {
  return q.raw;
}

// Pair the claim's figures with the source's and report the disagreements.
// Requires the same unit and at least one shared context word, so "4.2 percent
// unemployment" is never compared against "4.2 percent inflation", and a bare
// count is never compared against a sum of money.
export function compareQuantities(claim, sourceText, opts = {}) {
  const minOverlap = opts.minOverlap ?? 1;
  const claimQs = extractQuantities(claim);
  const sourceQs = extractQuantities(sourceText);
  const conflicts = [];
  let agreements = 0;

  for (const c of claimQs) {
    const candidates = sourceQs
      .map((s) => ({ s, shared: overlap(c.context, s.context) }))
      .filter((p) => p.s.unit === c.unit && p.shared >= minOverlap)
      .sort((a, b) => b.shared - a.shared);
    if (!candidates.length) continue;

    // Agreement anywhere settles it: a source that states the same figure and also
    // mentions another is not contradicting the claim.
    const agreeing = candidates.find((p) => sameValue(c.value, p.s.value));
    if (agreeing) {
      agreements++;
      continue;
    }
    const best = candidates[0].s;
    conflicts.push({
      claim: formatValue(c),
      source: formatValue(best),
      unit: c.unit,
      note: `the claim says ${formatValue(c)}, this source says ${formatValue(best)}`,
    });
  }

  return {
    status: conflicts.length ? 'conflicts' : agreements ? 'agrees' : 'none',
    conflicts,
    agreements,
    note: conflicts.length ? conflicts[0].note : '',
  };
}
