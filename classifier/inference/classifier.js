// Claim-worthiness scoring for the extension.
//
//   scoreClaimWorthiness(sentences: string[]) -> Promise<number[]>  // 0..1, input order
//
// Loads the trained model exported by classifier/train/train.py if it is present,
// and falls back to the heuristic scorer when it is missing or fails to load, so the
// extension keeps working either way.

import { scoreWithModel, heuristicScore } from './scorer.js';

const MODEL_PATH = 'classifier/model/model.json';

let model = null;
let loadAttempted = false;

async function loadModel() {
  if (loadAttempted) return model;
  loadAttempted = true;
  try {
    const url = chrome.runtime.getURL(MODEL_PATH);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`model fetch returned ${res.status}`);
    const parsed = await res.json();
    if (!parsed?.vocabulary || !parsed?.coef || !parsed?.idf) {
      throw new Error('model.json is missing required fields');
    }
    model = parsed;
    console.info('[factcheck] loaded trained classifier');
  } catch (err) {
    // Expected until the model is trained; not an error worth alarming the user about.
    console.info('[factcheck] no trained classifier, using heuristic scorer:', err.message);
    model = null;
  }
  return model;
}

export async function scoreClaimWorthiness(sentences) {
  const m = await loadModel();
  if (m) return scoreWithModel(m, sentences);
  return sentences.map(heuristicScore);
}

export function isUsingHeuristic() {
  return model === null;
}
