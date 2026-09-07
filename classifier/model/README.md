# The exported model

`model.json` is the trained claim-worthiness classifier: 20,000 tf-idf terms,
fourteen hand-written features, and the logistic regression weights over them,
written by `classifier/train/train.py`. `classifier/inference/classifier.js` fetches
it from the extension package at startup and scores against it in plain
JavaScript. There is no runtime, no TensorFlow.js and no ONNX; the file is the
model.

`parity_fixture.json` holds forty sentences and the probabilities the Python model
gave them. `classifier/inference/scorer.test.mjs` asserts the JavaScript scorer
reproduces every one to within 1e-6, which is what catches the two implementations
drifting apart.

A model file may carry a `preprocess` field naming the pre-pass it was fitted with:
number words rewritten as digits, and runs of capitalised words masked to one
token. The scorer applies exactly what the file declares and nothing to a file
that declares nothing, so an older model keeps scoring as it always did. The
pre-pass itself lives in `classifier/inference/textprep.js` and its Python twin
`classifier/train/textprep.py`, with their own parity fixture in
`classifier/eval/prep_fixture.json`.

If the model fails to load, `classifier.js` falls back to the heuristic scorer in
`scorer.js`, so the extension keeps working without it.

A model trained on ClaimBuster data is a derivative work under CC BY 4.0; the
attribution travels inside the file, in its `attribution` field. See
`ATTRIBUTION.md` at the repository root.
