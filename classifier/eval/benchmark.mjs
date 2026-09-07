// Runs a model against the multi-domain benchmark and reports how it does per domain.
//
// The training data is US political debate speech. The extension runs on news,
// reviews, papers, shop pages and captions, and a held-out number from the debate
// corpus says nothing about those. benchmark.csv is labelled text in the shapes
// the extension actually meets, and this prints precision and recall at the two
// thresholds the extension uses, plus ROC AUC and average precision, per domain.
//
// The benchmark has two halves, fixed in the file. The eval half is only ever
// scored. The calib half is what a calibration step may fit on. Reporting them
// separately is what keeps a calibrated model's numbers honest.
//
//   node classifier/eval/benchmark.mjs                    # shipped model, eval half
//   node classifier/eval/benchmark.mjs --split calib
//   node classifier/eval/benchmark.mjs --model path/to/model.json --out results/x.json
//   node classifier/eval/benchmark.mjs --heuristic         # the fallback scorer
//   node classifier/eval/benchmark.mjs --misses 15         # show the worst mistakes

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scoreWithModel, heuristicScore } from '../inference/scorer.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FLAG = 0.70;
const FAINT = 0.50;

// --- reading the file -------------------------------------------------------------------

// A small CSV reader: quoted fields, doubled quotes inside them, CRLF or LF.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows;
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

export function loadBenchmark(split = 'eval') {
  const rows = parseCsv(readFileSync(join(HERE, 'benchmark.csv'), 'utf8'))
    .map((r) => ({ text: r.text, label: Number(r.label), domain: r.domain, split: r.split }));
  return split === 'all' ? rows : rows.filter((r) => r.split === split);
}

// --- the metrics ------------------------------------------------------------------------

function atThreshold(rows, scores, threshold) {
  let tp = 0; let fp = 0; let fn = 0; let tn = 0;
  rows.forEach((r, i) => {
    const flagged = scores[i] >= threshold;
    if (r.label && flagged) tp++;
    else if (r.label) fn++;
    else if (flagged) fp++;
    else tn++;
  });
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { tp, fp, fn, tn, precision, recall, f1 };
}

// Probability that a random positive outranks a random negative. Ties count half.
export function rocAuc(labels, scores) {
  const pos = scores.filter((_, i) => labels[i] === 1);
  const neg = scores.filter((_, i) => labels[i] === 0);
  if (!pos.length || !neg.length) return null;
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

// Area under the precision-recall curve, stepwise, as scikit-learn computes it.
export function averagePrecision(labels, scores) {
  const order = scores.map((s, i) => i).sort((a, b) => scores[b] - scores[a]);
  const positives = labels.filter((l) => l === 1).length;
  if (!positives || positives === labels.length) return null;
  let hits = 0; let sum = 0;
  order.forEach((idx, rank) => {
    if (labels[idx] === 1) { hits++; sum += hits / (rank + 1); }
  });
  return sum / positives;
}

export function evaluate(rows, scores) {
  const labels = rows.map((r) => r.label);
  return {
    n: rows.length,
    positives: labels.filter((l) => l === 1).length,
    auc: rocAuc(labels, scores),
    ap: averagePrecision(labels, scores),
    flag: atThreshold(rows, scores, FLAG),
    faint: atThreshold(rows, scores, FAINT),
  };
}

export function byDomain(rows, scores) {
  const out = { all: evaluate(rows, scores) };
  for (const domain of [...new Set(rows.map((r) => r.domain))]) {
    const idx = rows.map((r, i) => (r.domain === domain ? i : -1)).filter((i) => i >= 0);
    out[domain] = evaluate(idx.map((i) => rows[i]), idx.map((i) => scores[i]));
  }
  return out;
}

// --- printing ---------------------------------------------------------------------------

const f3 = (x) => (x == null ? '  n/a' : x.toFixed(3));

export function printTable(report) {
  console.log(`${'domain'.padEnd(15)}${'n'.padStart(5)}${'pos'.padStart(5)}${'AUC'.padStart(8)}${'AP'.padStart(8)}`
    + `${'P@.70'.padStart(8)}${'R@.70'.padStart(8)}${'P@.50'.padStart(8)}${'R@.50'.padStart(8)}`);
  for (const [name, m] of Object.entries(report)) {
    console.log(`${name.padEnd(15)}${String(m.n).padStart(5)}${String(m.positives).padStart(5)}`
      + `${f3(m.auc).padStart(8)}${f3(m.ap).padStart(8)}`
      + `${f3(m.flag.precision).padStart(8)}${f3(m.flag.recall).padStart(8)}`
      + `${f3(m.faint.precision).padStart(8)}${f3(m.faint.recall).padStart(8)}`);
  }
}

function printMisses(rows, scores, limit) {
  const wrong = rows.map((r, i) => ({ ...r, score: scores[i] }))
    .filter((r) => (r.label === 1) !== (r.score >= FLAG))
    .sort((a, b) => Math.abs(b.score - FLAG) - Math.abs(a.score - FLAG))
    .slice(0, limit);
  if (!wrong.length) return;
  console.log(`\nworst mistakes at ${FLAG}:`);
  for (const r of wrong) {
    console.log(`  ${r.label ? 'MISSED ' : 'FALSE  '}${r.score.toFixed(2)}  [${r.domain}] ${r.text.slice(0, 90)}`);
  }
}

// --- main -------------------------------------------------------------------------------

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const split = arg('--split', 'eval');
  const modelPath = arg('--model', join(HERE, '..', 'model', 'model.json'));
  const useHeuristic = process.argv.includes('--heuristic');
  const rows = loadBenchmark(split);

  const scores = useHeuristic
    ? rows.map((r) => heuristicScore(r.text))
    : scoreWithModel(JSON.parse(readFileSync(modelPath, 'utf8')), rows.map((r) => r.text));

  console.log(`${useHeuristic ? 'heuristic scorer' : modelPath} on the ${split} half (${rows.length} sentences)\n`);
  const report = byDomain(rows, scores);
  printTable(report);
  printMisses(rows, scores, Number(arg('--misses', 0)));

  const out = arg('--out', '');
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify({ model: useHeuristic ? 'heuristic' : modelPath, split, report }, null, 2));
    console.log(`\nwrote ${out}`);
  }
}
