// What is in model.json, and what could come out of it.
//
// The model is 20,000 tf-idf terms plus fourteen hand features, exported as JSON at
// full double precision. Three questions decide how much of that is worth shipping:
// which terms carry no weight, which carry weight only because the training data is
// political debate, and how many digits of each weight the score actually needs.
// This answers all three by measurement, and changes nothing.
//
//   node classifier/eval/audit-model.mjs
//   node classifier/eval/audit-model.mjs --names 40      # more overfitted terms

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scoreWithModel, tokenize } from '../inference/scorer.js';
import { loadBenchmark, parseCsv } from './benchmark.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const model = JSON.parse(readFileSync(join(HERE, '..', 'model', 'model.json'), 'utf8'));

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

const terms = Object.entries(model.vocabulary).map(([term, i]) => ({ term, i, coef: model.coef[i], idf: model.idf[i] }));
const bytes = (v) => Buffer.byteLength(JSON.stringify(v));

// --- 1. what the bytes are ---------------------------------------------------------------

console.log('=== payload ===');
const total = bytes(model);
const parts = {
  vocabulary: bytes(model.vocabulary),
  coef: bytes(model.coef),
  idf: bytes(model.idf),
  other: 0,
};
parts.other = total - parts.vocabulary - parts.coef - parts.idf;
for (const [k, v] of Object.entries(parts)) console.log(`  ${k.padEnd(12)}${(v / 1e3).toFixed(0).padStart(7)} KB  ${(100 * v / total).toFixed(0).padStart(3)}%`);
console.log(`  ${'total'.padEnd(12)}${(total / 1e3).toFixed(0).padStart(7)} KB`);

// --- 2. weights that do nothing ----------------------------------------------------------

console.log('\n=== weight distribution over the 20,000 terms ===');
const abs = terms.map((t) => Math.abs(t.coef)).sort((a, b) => b - a);
const mass = abs.reduce((s, x) => s + x, 0);
for (const cut of [0.01, 0.05, 0.1, 0.25, 0.5]) {
  const below = abs.filter((x) => x < cut).length;
  console.log(`  |coef| < ${String(cut).padEnd(5)} ${String(below).padStart(6)} terms  (${(100 * below / abs.length).toFixed(0)}%)`);
}
let acc = 0;
for (const k of [1000, 2500, 5000, 10000]) {
  acc = abs.slice(0, k).reduce((s, x) => s + x, 0);
  console.log(`  top ${String(k).padEnd(6)} terms hold ${(100 * acc / mass).toFixed(0)}% of the total |weight|`);
}

// Document frequency, recovered from the smoothed idf: idf = ln((1+n)/(1+df)) + 1.
// n is the number of training sentences the vectorizer saw. The rarest term was
// kept by min_df=2, so the largest idf belongs to df=2, which pins n.
const n = Math.round(Math.max(...terms.map((t) => (1 + 2) * Math.exp(t.idf - 1) - 1)));
const df = (t) => Math.round((1 + n) / Math.exp(t.idf - 1) - 1);
const rare = terms.filter((t) => df(t) <= 2).length;
console.log(`\n  training sentences seen by the vectorizer: ${n}`);
console.log(`  terms seen in only 2 sentences (the min_df floor): ${rare} (${(100 * rare / terms.length).toFixed(0)}%)`);
const bigrams = terms.filter((t) => t.term.includes(' '));
console.log(`  bigrams: ${bigrams.length}, of which ${bigrams.filter((t) => Math.abs(t.coef) < 0.05).length} weigh under 0.05`);

// --- 3. terms that are the debates, not the task ------------------------------------------

// A term is a name if, in the training data, it is nearly always capitalised when it
// is not the first word of the sentence. That is the same test entity masking will
// use in Phase 2, so this list is also a preview of what masking would remove.
console.log('\n=== terms that are debate vocabulary rather than claim structure ===');
const dataset = parseCsv(readFileSync(join(HERE, '..', 'train', 'data', 'dataset.csv'), 'utf8'));
const capital = new Map();
const seen = new Map();
for (const row of dataset) {
  const words = String(row.text).match(/\S+/g) || [];
  words.forEach((w, i) => {
    if (i === 0) return;
    const [tok] = tokenize(w);
    if (!tok) return;
    seen.set(tok, (seen.get(tok) || 0) + 1);
    if (/^[A-Z]/.test(w)) capital.set(tok, (capital.get(tok) || 0) + 1);
  });
}
// The pronoun I, and its contractions, are capitalised by grammar rather than
// because they name anything.
const nameLike = (tok) => tok !== 'i' && !tok.startsWith("i'")
  && (seen.get(tok) || 0) >= 3 && (capital.get(tok) || 0) / seen.get(tok) >= 0.9;
const names = terms.filter((t) => t.term.split(' ').some(nameLike));
const namedMass = names.reduce((s, t) => s + Math.abs(t.coef), 0);
console.log(`  ${names.length} terms contain a capitalised-in-training word, holding ${(100 * namedMass / mass).toFixed(1)}% of |weight|`);
const shown = Number(arg('--names', 25));
console.log(`  strongest ${shown}, by |weight|:`);
for (const t of [...names].sort((a, b) => Math.abs(b.coef) - Math.abs(a.coef)).slice(0, shown)) {
  console.log(`    ${t.term.padEnd(22)} ${t.coef >= 0 ? '+' : ''}${t.coef.toFixed(2)}   df=${df(t)}`);
}

const DEBATE = ['senator', 'governor', 'president', 'opponent', 'administration', 'congress', 'bill',
  'vote', 'voted', 'campaign', 'debate', 'moderator', 'republican', 'democrat', 'democrats', 'republicans',
  'mr', 'question', 'america', 'american', 'americans', 'washington', 'tonight'];
const debate = terms.filter((t) => t.term.split(' ').some((w) => DEBATE.includes(w)));
console.log(`\n  ${debate.length} terms are debate-room vocabulary (senator, bill, vote, tonight, mr...)`);
console.log('  strongest 15:');
for (const t of [...debate].sort((a, b) => Math.abs(b.coef) - Math.abs(a.coef)).slice(0, 15)) {
  console.log(`    ${t.term.padEnd(22)} ${t.coef >= 0 ? '+' : ''}${t.coef.toFixed(2)}`);
}

// --- 4. what pruning and rounding would cost ----------------------------------------------

// Each variant is built and scored on the whole benchmark; the number that matters is
// the largest change to any sentence's score, since that is what could move a flag.
console.log('\n=== what shrinking the file would do to the scores ===');
const rows = loadBenchmark('all');
const texts = rows.map((r) => r.text);
const base = scoreWithModel(model, texts);

function variant({ round = null, minAbs = 0 } = {}) {
  const keep = terms.filter((t) => Math.abs(t.coef) >= minAbs);
  const vocabulary = {};
  const coef = [];
  const idf = [];
  const r = (x) => (round == null ? x : Number(x.toPrecision(round)));
  keep.forEach((t, k) => { vocabulary[t.term] = k; coef.push(r(t.coef)); idf.push(r(t.idf)); });
  const offset = model.idf.length;
  const extra = model.feature_names.map((_, k) => r(model.coef[offset + k]));
  return { ...model, vocabulary, coef: [...coef, ...extra], idf, intercept: r(model.intercept) };
}

console.log(`  ${'variant'.padEnd(34)}${'terms'.padStart(7)}${'KB'.padStart(7)}${'max |Δscore|'.padStart(14)}${'flags moved'.padStart(13)}`);
for (const [label, opts] of [
  ['as shipped', {}],
  ['rounded to 5 significant digits', { round: 5 }],
  ['rounded to 4', { round: 4 }],
  ['drop |coef| < 0.01, round 5', { minAbs: 0.01, round: 5 }],
  ['drop |coef| < 0.05, round 5', { minAbs: 0.05, round: 5 }],
  ['drop |coef| < 0.10, round 5', { minAbs: 0.1, round: 5 }],
  ['drop |coef| < 0.25, round 5', { minAbs: 0.25, round: 5 }],
]) {
  const m = variant(opts);
  const s = scoreWithModel(m, texts);
  const delta = Math.max(...s.map((x, i) => Math.abs(x - base[i])));
  const moved = s.filter((x, i) => (x >= 0.7) !== (base[i] >= 0.7)).length;
  console.log(`  ${label.padEnd(34)}${String(m.idf.length).padStart(7)}${(bytes(m) / 1e3).toFixed(0).padStart(7)}${delta.toFixed(4).padStart(14)}${String(moved).padStart(13)}`);
}
console.log('\n  "flags moved" is how many of the benchmark sentences crossed 0.70 in either direction.');
