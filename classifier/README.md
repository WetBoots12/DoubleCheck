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

A trained model ships in `model/model.json` (1.2 MB, 20,000 terms). The
hand-written heuristic scorer remains as the fallback for when the model fails to
load.

## Trained model, current numbers

Trained on ClaimBuster's `3xNCS.json`, the stricter binary split the dataset
authors report trains best: 10,794 sentences, 25.4% check-worthy.

| Metric | Value |
|---|---|
| Average precision | 0.837 |
| ROC AUC | 0.927 |
| Precision at 0.70 | 0.855 |
| Recall at 0.70 | 0.599 |

The extension's default threshold is **0.70**, chosen for precision: every flagged
claim is a search call the user may spend.

Despite training on political debate transcripts, it separates real-world news
prose cleanly. News and encyclopedia claims score 0.77 to 0.99, while chatter,
opinion, questions and navigation text score 0.05 to 0.30. The heuristic scored
the same Wikipedia claim 0.15, so the model is a real improvement on general prose
rather than only on debates.

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

# Normalize whatever CSV you have into text,label columns
python classifier/train/prepare_data.py   --input classifier/train/raw/ClaimBuster_Datasets/datasets/3xNCS.json   --output classifier/train/data/dataset.csv

# Train, evaluate, and export model.json + the parity fixture
cd train && python train.py --data data/dataset.csv

# Confirm the JavaScript scorer reproduces the Python model exactly
node --test classifier/inference/scorer.test.mjs
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
| `inference/scorer.js` | Pure scoring: tokenizing, features, tf-idf, the heuristic fallback |
| `inference/classifier.js` | Loads the model in the extension, falls back to the heuristic |
| `inference/scorer.test.mjs` | Unit tests plus the Python parity check |
| `model/` | Exported `model.json` lands here (git-ignored until trained) |
