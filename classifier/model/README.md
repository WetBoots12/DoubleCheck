# Exported model artifacts

Empty until the ClaimBuster-trained classifier is built
(`docs/prompts/01-classifier-training.md`). The exported TensorFlow.js or ONNX
files go here; `manifest.json` already exposes this folder via
`web_accessible_resources` so the classifier can fetch them at runtime.

Until then, `classifier/inference/classifier.js` falls back to the heuristic
scorer, as described in `docs/architecture.md` section 3.1.
