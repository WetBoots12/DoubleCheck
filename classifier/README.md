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

Until a model is trained, the extension falls back to a hand-written heuristic
scorer. That fallback is why flagging currently over-fires on pages dense with
numbers and proper nouns.

## Getting data

The task is "check-worthiness detection." The dataset built for exactly this is
**ClaimBuster**, from the University of Texas at Arlington: sentences drawn from
U.S. presidential debates, each labeled by human raters as a check-worthy factual
sentence (CFS), an unimportant factual sentence (UFS), or a non-factual sentence
(NFS). It is released for research use, and its two files are `crowdsourced.csv`
and `groundtruth.csv`.

`prepare_data.py` maps CFS to label 1 and both other classes to 0, on the reasoning
that an unimportant fact is not worth a search call either.

Any other CSV works too, as long as it has a text column and a binary or -1/0/1
label column. Check the license of whatever you use, and record it here.

## Running it

```bash
pip install -r train/requirements.txt

# Normalize whatever CSV you have into text,label columns
python train/prepare_data.py --input raw/crowdsourced.csv --output train/data/dataset.csv

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
