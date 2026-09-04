# Agent prompt: Claim-worthiness classifier (training + export)

Copy everything below into a fresh agent session to build this component.

---

I'm building a Chromium browser extension that fact-checks content in real
time (full design in `docs/architecture.md` at the repo root — read it for
context before starting, especially sections 2, 3.1, and 7).

This task is the first sub-project: a **claim-worthiness classifier**. It does
NOT determine whether a sentence is true or false — it only scores how likely
a sentence is to be a checkable factual claim worth looking into further
(a number claim, a statistic, an attributed statement of fact — as opposed to
opinion, greeting, or filler). Downstream, sentences above a threshold get
sent to a search API for actual fact-checking; that's a separate component,
not your concern here.

## What to build

1. **Dataset**: use the ClaimBuster dataset (sentence-level check-worthiness
   labels, originally from U.S. political speech/debates, academic/CC
   licensed). Find and document the source you pull it from, and note its
   license in the README you write for this component.
2. **Training pipeline** (Python): a small, reproducible script/notebook that
   trains a lightweight classifier — a small transformer (e.g. a distilled
   sentence encoder) or even sentence embeddings + logistic regression is
   fine; prioritize a small model size and fast inference over marginal
   accuracy gains, since this has to run in a browser. Report
   precision/recall/F1 on a held-out split.
3. **Export**: convert the trained model to a browser-runnable format —
   TensorFlow.js or ONNX Runtime Web (pick whichever the trained model type
   supports better and document why). Include the exact conversion steps as a
   script, not just manual notes, so it's reproducible.
4. **Inference wrapper** (JavaScript): a small module with this interface,
   since this is what the extension's content script/background worker will
   import:
   ```js
   // returns a Promise resolving to an array of scores (0-1), one per input sentence,
   // in the same order as the input
   async function scoreClaimWorthiness(sentences: string[]): Promise<number[]>
   ```
   It should lazy-load the model on first call and cache it in memory after.
5. **Unit tests** for the JS wrapper: given a fixed small set of sentences
   (mix of obvious factual claims like "Unemployment fell to 4.2% last
   quarter" and obvious non-claims like "Thanks for watching"), scores should
   consistently rank claims above non-claims. Don't assert exact score
   values — model outputs shift slightly across retrains; assert relative
   ordering and that scores fall in the expected value range instead.

## Out of scope

- Anything about search APIs, LLMs, or the extension's UI — this component
  only produces scores from sentences.
- Multi-language support — English only for v1.
- Real-time/streaming inference optimizations beyond basic batching — a
  simple batched forward pass is fine.

## Deliverables

- `classifier/train/` — Python training pipeline + export script
- `classifier/model/` — exported browser-runnable model artifacts
- `classifier/inference/` — the JS wrapper module + its unit tests
- `classifier/README.md` — dataset source/license, how to retrain, how to
  re-export, and the eval metrics from your held-out split

Ask me if the ClaimBuster dataset isn't accessible in the form you expect, or
if the model's inference latency in-browser looks too slow for scoring
several sentences per second — don't silently ship something that would make
the extension feel laggy.
