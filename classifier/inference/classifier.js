// Claim-worthiness scoring.
//
// Interface (stable — the trained model will drop in behind this):
//   scoreClaimWorthiness(sentences: string[]) -> Promise<number[]>  // 0..1, input order
//
// v1 ships the heuristic fallback described in docs/architecture.md 3.1, because the
// ClaimBuster-trained model (docs/prompts/01-classifier-training.md) is not built yet.
// When it is: load it in loadModel() and score in scoreBatch(); the heuristic stays as
// the documented fallback for when the model fails to load.

let model = null;
let modelLoadFailed = false;

async function loadModel() {
  if (model || modelLoadFailed) return model;
  try {
    // TODO(01-classifier-training): load the exported TF.js/ONNX model from
    // chrome.runtime.getURL('classifier/model/...') and assign to `model`.
    modelLoadFailed = true;
    return null;
  } catch (err) {
    console.warn('[factcheck] classifier model failed to load, using heuristic', err);
    modelLoadFailed = true;
    return null;
  }
}

// Signals that a sentence is asserting a checkable fact rather than opinion or filler.
const NUMERIC = /\b\d[\d,.]*\s*(%|percent|million|billion|trillion|thousand)?\b/i;
const YEAR = /\b(19|20)\d{2}\b/;
const ATTRIBUTION = /\b(said|says|claimed|according to|reported|announced|stated|admitted)\b/i;
const QUANTIFIER = /\b(more than|less than|fewer than|highest|lowest|record|first|only|never|always|every|most|majority)\b/i;
const CAUSAL = /\b(caused|causes|led to|because of|due to|resulted in|linked to)\b/i;
const HEDGE = /\b(i think|i feel|in my opinion|maybe|probably|might|could be|seems like)\b/i;
const FIRST_PERSON = /^\s*(i|we|you)\b/i;
// Capitalized multi-word phrase mid-sentence ~ named entity.
const ENTITY = /(?:^|\s)([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/;

function heuristicScore(text) {
  const t = text.trim();
  if (t.length < 40 || t.split(/\s+/).length < 7) return 0;

  let score = 0.15;
  if (NUMERIC.test(t)) score += 0.3;
  if (YEAR.test(t)) score += 0.1;
  if (ATTRIBUTION.test(t)) score += 0.15;
  if (QUANTIFIER.test(t)) score += 0.15;
  if (CAUSAL.test(t)) score += 0.15;
  if (ENTITY.test(t)) score += 0.15;
  if (HEDGE.test(t)) score -= 0.35;
  if (FIRST_PERSON.test(t)) score -= 0.2;
  if (t.endsWith('?')) score -= 0.3;

  return Math.max(0, Math.min(1, score));
}

export async function scoreClaimWorthiness(sentences) {
  const m = await loadModel();
  if (m) {
    // TODO(01-classifier-training): batched forward pass through the real model.
  }
  return sentences.map(heuristicScore);
}

export function isUsingHeuristic() {
  return !model;
}
