# Claim-worthiness classifier

Scores a sentence 0 to 1 on how likely it is to be a checkable factual claim. It
does **not** judge whether the claim is true. Its only job is deciding which
sentences are worth spending a search call on.

## What it is

Tf-idf over word unigrams and bigrams, plus eleven binary features (contains a
number, a year, an attribution verb, hedging language, and so on), fed to logistic
regression. Training happens in Python; the fitted weights export to a JSON file
that plain JavaScript scores against in the browser.

That choice is deliberate. The extension scores every sentence on every page, so a
model that ships as JSON and needs no runtime beats a transformer that needs
TensorFlow.js or ONNX and tens of megabytes of weights. If the metrics turn out
to be too weak, a heavier model can replace it behind the same
`scoreClaimWorthiness()` interface without touching the rest of the extension.

A trained model ships in `model/model.json` (0.3 MB, 9,270 terms). The
hand-written heuristic scorer remains as the fallback for when the model fails to
load.

Before the weights see a sentence, a pre-pass rewrites number words as digits and
collapses runs of capitalised words into one token (`train/textprep.py`,
`inference/textprep.js`, identical by construction and checked against each other
by a fixture). Words the training data treats as names, capitalised nearly every
time they appear, are kept out of the vocabulary altogether, so the model learns
that "ENTITY raised rates by 0.25 point" is a claim whoever ENTITY is, rather than
learning the names of the people in the debate room.

## Trained model, current numbers

Trained on ClaimBuster's `2.5xNCS.json` and `groundtruth.csv` together with 2,793
sentences of English Wikinews labelled by ClaimBuster's own scheme
(`train/LABELLING.md`): 12,542 sentences, 29% check-worthy. A further 493 Wikinews
sentences and the calibration half of the benchmark were held out and used only to
calibrate the probabilities.

Five-fold cross-validation over the training data:

| Metric | Value |
|---|---|
| Average precision | 0.828 ± 0.008 |
| ROC AUC | 0.909 ± 0.006 |
| Average precision, debate rows | 0.860 |
| Average precision, Wikinews rows | 0.738 |

On the evaluation half of the multi-domain benchmark (`eval/benchmark.csv`), 185
sentences of news, entertainment, scientific prose, captions and page furniture the
model never saw, against the previous model:

| Metric | Previous | Current |
|---|---|---|
| ROC AUC | 0.940 | 0.970 |
| Average precision | 0.926 | 0.947 |
| Precision at 0.70 | 0.875 | 0.955 |
| Recall at 0.70 | 0.843 | 0.759 |
| False flags among 45 hard negatives, at 0.70 | 9 | 3 |
| Model file | 1,125 KB | ~300 KB |

The probabilities are calibrated on news sentences, so 0.70 is a stricter bar than
it was and recall at that threshold fell while precision rose. At 0.50 the current
model reaches recall 0.855 at precision 0.922, where the previous one had precision
0.700. Run `node classifier/eval/benchmark.mjs` to reproduce any of this.

The extension's default threshold is **0.70**, chosen for precision: every flagged
claim is a search call the user may spend.

## The data, and crediting it

**ClaimBuster**, from the IDIR Lab at the University of Texas at Arlington,
released under **CC BY 4.0**. Attribution is a licence condition, not a courtesy:
see [`ATTRIBUTION.md`](../ATTRIBUTION.md) at the repository root for the required
citations and the authors' funding acknowledgment. The exported model carries the
same attribution in its `attribution` field, because a model trained on CC BY data
is a derivative work and the credit has to travel with the weights.

Raw data lives in `train/raw/` and is git-ignored, so this repository does not
redistribute it. Download it from <https://zenodo.org/records/3836810>.

The zip holds several files. `3xNCS.json` is the one used here: already binary
labelled, filtered by stricter annotator agreement, three non-check-worthy
sentences per check-worthy one. `groundtruth.csv` and `crowdsourced.csv` carry the
raw three-way verdicts, where 1 is a check-worthy factual sentence, 0 an
unimportant factual sentence and -1 a non-factual one; `prepare_data.py` maps only
1 to a positive label, since an unimportant fact is not worth a search call either.

Any other CSV or JSON works too, given a text column and a binary or -1/0/1 label
column. Check the licence of whatever you add, and record it in `ATTRIBUTION.md`.

## Running it

```bash
pip install -r train/requirements.txt

# Blend the corpora into text,label,domain columns, holding a Wikinews slice out
# for calibration so that it can never overlap the training rows
cd classifier/train
python prepare_data.py \
  --input raw/ClaimBuster_Datasets/datasets/2.5xNCS.json --domain debate \
  --input raw/ClaimBuster_Datasets/datasets/groundtruth.csv --domain debate \
  --input wikinews/labelled.csv --domain wikinews \
  --holdout-domain wikinews --holdout 0.15 \
  --output data/dataset.csv

# Cross-validate, fit, calibrate on the held-out news sentences, and export
# model.json + the parity fixture
python train.py --data data/dataset.csv --max-features 10000 \
  --calibrate data/holdout.csv --calibrate ../eval/benchmark.csv --calibrate-split calib

# Confirm the JavaScript scorer reproduces the exported model exactly, then
# measure it on the benchmark's evaluation half, which nothing above has seen
cd ../..
node --test classifier/inference/scorer.test.mjs
node classifier/eval/benchmark.mjs --split eval

# To add more Wikinews: fetch, label by train/LABELLING.md, merge
python classifier/train/fetch_wikinews.py --articles 240
python classifier/train/merge_wikinews.py
```

Training prints a threshold table. Pick the extension's default threshold from it
deliberately: precision matters more than recall here, because every flagged claim
is a search call the user may spend.

## Keeping the two implementations in step

`train.py` and `inference/scorer.js` implement the same tokenization, the same
feature list in the same order, and the same tf-idf formula. They have to, since
one produces the weights the other consumes.

Training writes `model/parity_fixture.json`, holding sentences and the scores the
Python model gave them. The JavaScript test asserts `scorer.js` reproduces those
scores to within 1e-6. That test skips while no model exists, and starts running the
moment one does. **If you change tokenization or features on either side, change
both, or that test will tell you that you didn't.**

## Layout

| Path | What it is |
|---|---|
| `train/prepare_data.py` | Normalizes a raw dataset to `text,label` |
| `train/train.py` | Trains, evaluates, exports `model.json` and the parity fixture |
| `train/textprep.py` | The pre-pass: number words to digits, capitalised runs to one token. Writes the fixture `inference/textprep.js` is checked against |
| `inference/scorer.js` | Pure scoring: tokenizing, features, tf-idf, the heuristic fallback |
| `inference/textprep.js` | The same pre-pass in JavaScript, applied only when the model file declares it |
| `inference/classifier.js` | Loads the model in the extension, falls back to the heuristic |
| `inference/scorer.test.mjs` | Unit tests plus the Python parity check |
| `model/` | The exported `model.json` and its parity fixture |
| `eval/` | The multi-domain benchmark, its runner, the model audit and the pre-pass fixture |
