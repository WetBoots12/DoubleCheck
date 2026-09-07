// Pure scoring logic. No browser or extension APIs here, so it can be unit tested
// in Node and reused anywhere.
//
// IMPORTANT: tokenize(), FEATURES, and score() must mirror classifier/train/train.py
// exactly. The parity test compares scores from this file against scores the Python
// model produced for the same sentences; if you change one side, change both.

import { prepare } from './textprep.js';

export function tokenize(text) {
  return (text.toLowerCase().match(/[a-z0-9']+/g) || []);
}

// Unigrams plus bigrams, matching scikit-learn's ngram_range=(1, 2).
export function ngrams(tokens) {
  const out = tokens.slice();
  for (let i = 0; i + 1 < tokens.length; i++) out.push(`${tokens[i]} ${tokens[i + 1]}`);
  return out;
}

// Binary signals appended after the tf-idf block. Order must match FEATURE_NAMES in
// train.py.
export const FEATURES = [
  ['has_digit', (t) => /\d/.test(t)],
  ['has_percent', (t) => /(%|\bpercent\b)/i.test(t)],
  ['has_year', (t) => /\b(19|20)\d{2}\b/.test(t)],
  ['has_big_number', (t) => /\b(million|billion|trillion|thousand)\b/i.test(t)],
  ['has_attribution', (t) => /\b(said|says|claimed|according to|reported|announced|stated)\b/i.test(t)],
  ['has_quantifier', (t) => /\b(more than|less than|fewer than|highest|lowest|record|first|only|never|always|every|most|majority)\b/i.test(t)],
  ['has_causal', (t) => /\b(caused|causes|led to|because of|due to|resulted in|linked to)\b/i.test(t)],
  ['has_hedge', (t) => /\b(i think|i feel|in my opinion|maybe|probably|might|could be|seems like)\b/i.test(t)],
  ['first_person', (t) => /^\s*(i|we|you)\b/i.test(t)],
  ['is_question', (t) => /\?\s*$/.test(t)],
  ['is_long', (t) => (t.match(/\S+/g) || []).length >= 15],
  // Added when the model stopped being only about US political debates. Debate
  // transcripts state quantities in dollars and percentages; pages about climate,
  // health or technology use ppm, mg/dL, gigawatts, decimals and other currencies.
  ['has_currency', (t) => /[$\u00a3\u20ac\u00a5\u20b9\u20a9]|\b(dollars?|pounds?|euros?|yen|yuan|rupees?|usd|eur|gbp|jpy|cny)\b/i.test(t)],
  ['has_unit', (t) => /\b(ppm|ppb|mg|kg|g|mcg|km|cm|mm|ft|mi|kwh|mwh|gwh|gw|mw|kw|tw|celsius|fahrenheit|hectares?|acres?|tonnes?|tons?|litres?|liters?|barrels?|degrees?|bpm|calories|kilometres?|kilometers?|miles|watts?|joules?|volts?|amps?)\b|\u00b0\s*[cf]\b|\bmg\/dl\b|\bkm\/h\b|\bmph\b|\bm\/s\b/i.test(t)],
  ['has_decimal', (t) => /\d+\.\d|\b\d+\/\d+\b|\b\d+(?:\.\d+)?e[+-]?\d+\b/i.test(t)],
];

export function handcrafted(text) {
  return FEATURES.map(([, fn]) => (fn(text) ? 1 : 0));
}

function sigmoid(z) {
  return 1 / (1 + Math.exp(-z));
}

// Replicates TfidfVectorizer(sublinear_tf=False, smooth_idf=True, norm='l2'):
// tf is the raw count, idf comes from the model, then the tf-idf block is L2
// normalized on its own before the binary features are appended.
function tfidfContribution(model, text) {
  const counts = new Map();
  for (const gram of ngrams(tokenize(text))) {
    const idx = model.vocabulary[gram];
    if (idx === undefined) continue;
    counts.set(idx, (counts.get(idx) || 0) + 1);
  }

  let norm = 0;
  const weighted = [];
  for (const [idx, count] of counts) {
    const value = count * model.idf[idx];
    weighted.push([idx, value]);
    norm += value * value;
  }
  norm = Math.sqrt(norm);

  let dot = 0;
  if (norm > 0) {
    for (const [idx, value] of weighted) dot += (value / norm) * model.coef[idx];
  }
  return dot;
}

export function scoreWithModel(model, sentences) {
  const offset = model.idf.length;
  return sentences.map((raw) => {
    // What the model was fitted on: digits for number words, one token for a name.
    // A model file that declares no pre-pass gets the text exactly as written.
    const { featureText, tokenText } = prepare(model, raw);
    let z = model.intercept + tfidfContribution(model, tokenText);
    const extra = handcrafted(featureText);
    for (let i = 0; i < extra.length; i++) {
      if (extra[i]) z += model.coef[offset + i];
    }
    return sigmoid(z);
  });
}

// Used until a trained model is present, and whenever loading one fails.
export function heuristicScore(text) {
  const t = text.trim();
  if (t.length < 40 || (t.match(/\S+/g) || []).length < 7) return 0;

  let score = 0.15;
  if (/\b\d[\d,.]*\s*(%|percent|million|billion|trillion|thousand)?\b/i.test(t)) score += 0.3;
  if (/\b(19|20)\d{2}\b/.test(t)) score += 0.1;
  if (/\b(said|says|claimed|according to|reported|announced|stated|admitted)\b/i.test(t)) score += 0.15;
  if (/\b(more than|less than|fewer than|highest|lowest|record|first|only|never|always|every|most|majority)\b/i.test(t)) score += 0.15;
  if (/\b(caused|causes|led to|because of|due to|resulted in|linked to)\b/i.test(t)) score += 0.15;
  if (/(?:^|\s)([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/.test(t)) score += 0.15;
  if (/\b(i think|i feel|in my opinion|maybe|probably|might|could be|seems like)\b/i.test(t)) score -= 0.35;
  if (/^\s*(i|we|you)\b/i.test(t)) score -= 0.2;
  if (t.endsWith('?')) score -= 0.3;

  return Math.max(0, Math.min(1, score));
}

// --- why a sentence scored the way it did --------------------------------------
//
// The panel used to show a bare number, which is an oracle: it tells the reader a
// sentence is worth checking without telling them what about it is checkable. The
// handcrafted signals are already computed for every sentence scanned and their
// weights are already loaded, so naming the ones that pushed the score up costs a
// lookup. It also keeps the promise the extension makes about what the score means,
// because "a percentage, someone quoted" is a description of the sentence rather
// than a judgement about the world.
//
// Only the signals present in the sentence AND weighted upward are named. A signal
// the model learned to weigh against, such as hedging, is not the reason a sentence
// was flagged, so listing it would mislead.

export const FEATURE_LABELS = {
  has_digit: 'a number',
  has_percent: 'a percentage',
  has_year: 'a year',
  has_big_number: 'a large quantity',
  has_attribution: 'someone quoted',
  has_quantifier: 'a superlative or comparison',
  has_causal: 'a cause and effect',
  has_hedge: 'hedging language',
  first_person: 'written in the first person',
  is_question: 'a question',
  is_long: 'a long sentence',
  has_currency: 'an amount of money',
  has_unit: 'a unit of measurement',
  has_decimal: 'a precise figure',
};

export function explainFeatures(model, text, limit = 3) {
  if (!model?.coef || !model?.idf) return [];
  const offset = model.idf.length;
  const present = handcrafted(prepare(model, text).featureText);

  return FEATURES
    .map(([name], i) => ({ name, weight: present[i] ? (model.coef[offset + i] ?? 0) : 0 }))
    .filter((f) => f.weight > 0)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit)
    .map((f) => FEATURE_LABELS[f.name] || f.name);
}
