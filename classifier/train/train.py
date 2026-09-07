"""Train the claim-worthiness classifier and export it for the browser.

Model: tf-idf over word unigrams and bigrams, plus a handful of binary features,
fed to logistic regression. This is deliberately small. The extension scores every
sentence on every page, so a model that ships as a JSON file and runs in plain
JavaScript beats a transformer that needs a runtime and tens of megabytes. Swap in
something heavier later if the metrics justify it; the interface the extension sees
(`scoreClaimWorthiness`) does not change.

What a run does:
  1. Stratified K-fold cross-validation over the whole dataset, reporting average
     precision and ROC AUC overall and per domain as a mean and spread across folds.
     One random split was what this used to report, and one split of debate
     transcripts says little about news pages.
  2. Fits the final model on every row.
  3. Calibrates the probabilities on target-domain sentences that were never
     trained on (--calibrate), by Platt scaling: two numbers, fitted on the model's
     raw score, so that 0.70 means what it says on a web page rather than on a
     debate stage. Calibration never changes the ranking, only where the
     thresholds fall.
  4. Exports model.json, with the weights rounded to a few significant digits,
     which measured as free (classifier/eval/audit-model.mjs) and takes 40 percent
     off the file.

IMPORTANT: tokenization, FEATURE_NAMES, the tf-idf arithmetic and the calibration
below must mirror classifier/inference/scorer.js exactly. train.py writes a parity
fixture that the JavaScript test checks against, so a drift between the two fails
that test.

Usage:
    python train.py --data data/dataset.csv
    python train.py --data data/dataset.csv --calibrate data/holdout.csv \
        --calibrate ../eval/benchmark.csv --calibrate-split calib
    python train.py --data data/dataset.csv --max-features 8000 --min-df 3
"""

import argparse
import json
import os
import re

import numpy as np
import pandas as pd
from scipy import sparse
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (average_precision_score, brier_score_loss, log_loss,
                             precision_recall_fscore_support, roc_auc_score)
from sklearn.model_selection import StratifiedKFold

import textprep

TOKEN_RE = re.compile(r"[a-z0-9']+")

# Order matters: the JavaScript scorer appends these in exactly this sequence.
# The last three were added after the model went beyond US political debates.
# ClaimBuster is transcripts, where quantities are dollars and percentages; a page
# about climate, health or technology states its facts in ppm, mg/dL, gigawatts and
# decimals, and in currencies other than the dollar.
FEATURE_NAMES = [
    "has_digit", "has_percent", "has_year", "has_big_number", "has_attribution",
    "has_quantifier", "has_causal", "has_hedge", "first_person", "is_question", "is_long",
    "has_currency", "has_unit", "has_decimal",
]

FEATURE_PATTERNS = {
    "has_digit": re.compile(r"\d"),
    "has_percent": re.compile(r"(%|\bpercent\b)", re.I),
    "has_year": re.compile(r"\b(19|20)\d{2}\b"),
    "has_big_number": re.compile(r"\b(million|billion|trillion|thousand)\b", re.I),
    "has_attribution": re.compile(r"\b(said|says|claimed|according to|reported|announced|stated)\b", re.I),
    "has_quantifier": re.compile(r"\b(more than|less than|fewer than|highest|lowest|record|first|only|never|always|every|most|majority)\b", re.I),
    "has_causal": re.compile(r"\b(caused|causes|led to|because of|due to|resulted in|linked to)\b", re.I),
    "has_hedge": re.compile(r"\b(i think|i feel|in my opinion|maybe|probably|might|could be|seems like)\b", re.I),
    "first_person": re.compile(r"^\s*(i|we|you)\b", re.I),
    "is_question": re.compile(r"\?\s*$"),
    "has_currency": re.compile(
        r"[$£€¥₹₩]|\b(dollars?|pounds?|euros?|yen|yuan|rupees?|usd|eur|gbp|jpy|cny)\b", re.I),
    "has_unit": re.compile(
        r"\b(ppm|ppb|mg|kg|g|mcg|km|cm|mm|ft|mi|kwh|mwh|gwh|gw|mw|kw|tw|celsius|fahrenheit|"
        r"hectares?|acres?|tonnes?|tons?|litres?|liters?|barrels?|degrees?|bpm|calories|"
        r"kilometres?|kilometers?|miles|watts?|joules?|volts?|amps?)\b"
        r"|°\s*[cf]\b|\bmg/dl\b|\bkm/h\b|\bmph\b|\bm/s\b", re.I),
    "has_decimal": re.compile(r"\d+\.\d|\b\d+/\d+\b|\b\d+(?:\.\d+)?e[+-]?\d+\b", re.I),
}

# The pre-pass, mirrored in classifier/inference/textprep.js: number words become
# digits before anything looks at the text, and runs of capitalised words become one
# token before the vectorizer sees it. Recorded in the exported model so the scorer
# applies exactly what the weights were fitted on, and nothing to a model that was
# fitted without it. Switched off by --no-preprocess for a like-for-like comparison.
PREPROCESS = {"numbers": True, "entities": True, "token": textprep.ENTITY_TOKEN}

# Sublinear term frequency: a word used three times in a sentence counts 1 + ln 3,
# not 3. In a single sentence repetition is emphasis, not evidence, and the raw
# count let one repeated word swamp the rest of the vector. Mirrored in scorer.js,
# and declared in the model file so an older model is still scored on raw counts.
TFIDF = {"sublinear": True}


def tokenizer(text):
    _, token_text = textprep.prepare(text, PREPROCESS["numbers"], PREPROCESS["entities"])
    return TOKEN_RE.findall(token_text.lower())


def handcrafted(text):
    if PREPROCESS["numbers"]:
        text = textprep.normalize_numbers(text)
    row = []
    for name in FEATURE_NAMES:
        if name == "is_long":
            row.append(1 if len(text.split()) >= 15 else 0)
        else:
            row.append(1 if FEATURE_PATTERNS[name].search(text) else 0)
    return row


def make_vectorizer(max_features, min_df):
    return TfidfVectorizer(
        tokenizer=tokenizer,
        lowercase=True,
        ngram_range=(1, 2),
        max_features=max_features,
        min_df=min_df,
        sublinear_tf=TFIDF["sublinear"],
        smooth_idf=True,      # scorer.js expects sklearn's smoothed idf
        norm="l2",
        token_pattern=None,
    )


# Names that start a sentence get past the mask, because a capital at position
# zero proves nothing: "Iran went from 0 centrifuges to 4,000" looks like
# "Unemployment fell to 4.2 percent". A dozen such sentences were enough to give
# "iran" and "donald" some of the heaviest weights in the model. This finds the
# words the training data itself treats as names, capitalised nearly every time
# they appear anywhere but first, and keeps every term containing one out of the
# vocabulary. The browser needs no list: a term that is not in the vocabulary is
# simply never looked up, on either side.
NAME_MIN_SEEN = 3
NAME_CAPITALISED_SHARE = 0.9


def name_like_tokens(texts):
    seen, capital = {}, {}
    for text in texts:
        words = str(text).split()
        for i, w in enumerate(words):
            if i == 0:
                continue
            toks = TOKEN_RE.findall(w.lower())
            if not toks:
                continue
            tok = toks[0]
            if tok == "i" or tok.startswith("i'"):
                continue
            seen[tok] = seen.get(tok, 0) + 1
            if w[:1].isupper():
                capital[tok] = capital.get(tok, 0) + 1
    return {t for t, n in seen.items()
            if n >= NAME_MIN_SEEN and capital.get(t, 0) / n >= NAME_CAPITALISED_SHARE}


def fit_vectorizer(texts, max_features, min_df, names):
    """Fit once to choose the vocabulary, drop every term that contains a name,
    then fit again on the reduced vocabulary so the idf values match it."""
    first = make_vectorizer(max_features, min_df).fit(texts)
    kept = [term for term in first.vocabulary_
            if not any(part in names for part in term.split(" "))]
    vectorizer = make_vectorizer(max_features, min_df)
    vectorizer.set_params(vocabulary=sorted(kept))
    vectorizer.fit(texts)
    return vectorizer, len(first.vocabulary_) - len(kept)


def build_matrix(vectorizer, texts, fit=False):
    tfidf = vectorizer.fit_transform(texts) if fit else vectorizer.transform(texts)
    extra = sparse.csr_matrix(np.array([handcrafted(t) for t in texts], dtype=np.float64))
    return sparse.hstack([tfidf, extra], format="csr")


def make_model(c):
    # Check-worthy sentences are the minority class in every dataset of this kind.
    return LogisticRegression(max_iter=3000, class_weight="balanced", C=c)


def threshold_table(y_true, scores):
    rows = []
    for threshold in [0.3, 0.4, 0.5, 0.6, 0.7, 0.8]:
        pred = (scores >= threshold).astype(int)
        p, r, f1, _ = precision_recall_fscore_support(
            y_true, pred, average="binary", zero_division=0
        )
        rows.append((threshold, p, r, f1, int(pred.sum())))
    return rows


def print_thresholds(y_true, scores):
    print("threshold  precision  recall     f1      flagged")
    for threshold, p, r, f1, flagged in threshold_table(y_true, scores):
        print(f"  {threshold:.2f}      {p:.3f}      {r:.3f}   {f1:.3f}   {flagged}")


# --- reading the calibration sentences --------------------------------------------------

def read_labelled(path, split=None):
    """text, label (0/1) from a CSV that may use 0/1 or ClaimBuster's -1/0/1."""
    df = pd.read_csv(path, encoding="utf-8")
    text_col = next(c for c in ("text", "Text", "sentence") if c in df.columns)
    label_col = next(c for c in ("label", "Verdict", "verdict") if c in df.columns)
    if split and "split" in df.columns:
        df = df[df["split"] == split]
    labels = df[label_col].astype(int)
    labels = (labels == 1).astype(int)
    return df[text_col].astype(str).tolist(), labels.to_numpy()


# --- calibration -----------------------------------------------------------------------

def platt(z, y):
    """Platt scaling: p = sigmoid(a*z + b), fitted by logistic regression on the raw
    score. Two parameters, which is what a few hundred sentences can support; isotonic
    regression needs thousands and would overfit this."""
    lr = LogisticRegression(C=1e6, max_iter=1000)
    lr.fit(z.reshape(-1, 1), y)
    return float(lr.coef_[0][0]), float(lr.intercept_[0])


def sigmoid(z):
    return 1.0 / (1.0 + np.exp(-z))


# --- main ---------------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", default="data/dataset.csv",
                    help="CSV with text and label columns, from prepare_data.py")
    ap.add_argument("--out", default="../model", help="Directory to write model.json into")
    ap.add_argument("--max-features", type=int, default=20000)
    ap.add_argument("--min-df", type=int, default=2)
    ap.add_argument("--c", type=float, default=2.0, help="Inverse regularisation strength")
    ap.add_argument("--folds", type=int, default=5)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--calibrate", action="append", default=[],
                    help="CSV of target-domain sentences (text + label) never used in training. Repeatable.")
    ap.add_argument("--calibrate-split", default=None,
                    help="When a calibration file has a split column, keep only this split")
    ap.add_argument("--round", type=int, default=5,
                    help="Significant digits kept in the exported weights; 0 keeps them all")
    ap.add_argument("--no-preprocess", action="store_true",
                    help="Fit on the raw text, without digit normalization or entity masking")
    ap.add_argument("--no-sublinear", action="store_true",
                    help="Use raw term counts rather than 1 + ln(count)")
    ap.add_argument("--keep-names", action="store_true",
                    help="Leave name-like words in the vocabulary, for comparison")
    args = ap.parse_args()
    if args.no_preprocess:
        PREPROCESS["numbers"] = False
        PREPROCESS["entities"] = False
    if args.no_sublinear:
        TFIDF["sublinear"] = False

    df = pd.read_csv(args.data).dropna(subset=["text", "label"])
    texts = df["text"].astype(str).tolist()
    labels = df["label"].astype(int).to_numpy()
    domains = (df["domain"].astype(str).to_numpy()
               if "domain" in df.columns else np.array(["all"] * len(texts)))
    print(f"{len(texts)} sentences, {labels.sum()} check-worthy ({labels.mean():.1%})")
    print(f"vocabulary up to {args.max_features} terms, min_df {args.min_df}, C {args.c}, "
          f"sublinear {TFIDF['sublinear']}, pre-pass {PREPROCESS['numbers'] and PREPROCESS['entities']}")

    # --- 1. cross-validation -----------------------------------------------------------
    # Out-of-fold scores for every row, so the per-domain numbers are over all of
    # a domain's sentences and not a fifth of them.
    names = set() if args.keep_names else name_like_tokens(texts)
    print(f"{len(names)} words the training data treats as names are kept out of the vocabulary")

    oof = np.zeros(len(texts))
    fold_ap, fold_auc = [], []
    skf = StratifiedKFold(n_splits=args.folds, shuffle=True, random_state=args.seed)
    for k, (tr, te) in enumerate(skf.split(texts, labels), 1):
        vec, _ = fit_vectorizer([texts[i] for i in tr], args.max_features, args.min_df, names)
        x_tr = build_matrix(vec, [texts[i] for i in tr])
        x_te = build_matrix(vec, [texts[i] for i in te])
        model = make_model(args.c).fit(x_tr, labels[tr])
        oof[te] = model.predict_proba(x_te)[:, 1]
        fold_ap.append(average_precision_score(labels[te], oof[te]))
        fold_auc.append(roc_auc_score(labels[te], oof[te]))
        print(f"  fold {k}: AP {fold_ap[-1]:.3f}  AUC {fold_auc[-1]:.3f}")

    print(f"\n--- {args.folds}-fold cross-validation ---")
    print(f"average precision: {np.mean(fold_ap):.3f} ± {np.std(fold_ap):.3f}")
    print(f"roc auc:           {np.mean(fold_auc):.3f} ± {np.std(fold_auc):.3f}")
    print("\nout-of-fold, uncalibrated:")
    print_thresholds(labels, oof)

    cv_by_domain = {}
    if len(set(domains)) > 1:
        print(f"\n{'domain':<24}{'rows':>7}{'positives':>11}{'AP':>8}{'AUC':>8}{'P@0.70':>9}{'R@0.70':>9}")
        for name in sorted(set(domains)):
            mask = domains == name
            y_d, s_d = labels[mask], oof[mask]
            if y_d.sum() == 0 or y_d.sum() == len(y_d):
                continue
            p_d, r_d, _, _ = precision_recall_fscore_support(
                y_d, (s_d >= 0.70).astype(int), average="binary", zero_division=0)
            cv_by_domain[name] = {
                "rows": int(mask.sum()), "ap": float(average_precision_score(y_d, s_d)),
                "auc": float(roc_auc_score(y_d, s_d)), "p70": float(p_d), "r70": float(r_d),
            }
            d = cv_by_domain[name]
            print(f"{name:<24}{d['rows']:>7}{int(y_d.sum()):>11}{d['ap']:>8.3f}{d['auc']:>8.3f}{d['p70']:>9.3f}{d['r70']:>9.3f}")
        print("\nA blend is only worth keeping if no domain got worse. One overall "
              "number can hide a corpus that dragged another one down.")

    # --- 2. the final fit, on everything --------------------------------------------------
    vectorizer, removed = fit_vectorizer(texts, args.max_features, args.min_df, names)
    x_all = build_matrix(vectorizer, texts)
    model = make_model(args.c).fit(x_all, labels)
    print(f"\nfinal fit: {len(vectorizer.vocabulary_)} terms, {removed} name-bearing terms removed")

    # --- 3. calibration on sentences the model never saw ------------------------------------
    calibration = None
    if args.calibrate:
        c_texts, c_labels = [], []
        for path in args.calibrate:
            t, y = read_labelled(path, args.calibrate_split)
            print(f"calibration: {len(t)} sentences from {path}" + (f" ({args.calibrate_split})" if args.calibrate_split else ""))
            c_texts += t
            c_labels += list(y)
        c_labels = np.array(c_labels)
        overlap = set(c_texts) & set(texts)
        if overlap:
            raise SystemExit(f"{len(overlap)} calibration sentences are in the training data; "
                             "calibration must be on sentences the model never saw")
        z = model.decision_function(build_matrix(vectorizer, c_texts))
        a, b = platt(z, c_labels)
        before = sigmoid(z)
        after = sigmoid(a * z + b)
        calibration = {
            "a": a, "b": b, "sentences": int(len(c_texts)),
            "sources": [os.path.basename(p) for p in args.calibrate],
        }
        print(f"\n--- calibration on {len(c_texts)} target-domain sentences ---")
        print(f"platt: p = sigmoid({a:.4f} * z + {b:+.4f})")
        print(f"brier score   before {brier_score_loss(c_labels, before):.4f}   after {brier_score_loss(c_labels, after):.4f}")
        print(f"log loss      before {log_loss(c_labels, before):.4f}   after {log_loss(c_labels, after):.4f}")
        print("\ncalibration set, before:")
        print_thresholds(c_labels, before)
        print("\ncalibration set, after:")
        print_thresholds(c_labels, after)

    print("\nPick the extension's default threshold from the calibrated table: precision "
          "matters more than recall here, since every flagged claim costs the user a search call.")

    # --- 4. export ---------------------------------------------------------------------------
    def rounded(x):
        return float(x) if not args.round else float(f"{float(x):.{args.round}g}")

    os.makedirs(args.out, exist_ok=True)
    vocabulary = {term: int(i) for term, i in vectorizer.vocabulary_.items()}
    payload = {
        "version": 2,
        "created_from": os.path.basename(args.data),
        # A model trained on CC BY data is a derivative work, so the credit travels
        # with the weights, not only with the repository.
        "attribution": {
            "datasets": [
                {
                    "dataset": "ClaimBuster",
                    "creator": "IDIR Lab, University of Texas at Arlington",
                    "url": "https://idir.uta.edu/claimbuster/",
                    "doi": "10.5281/zenodo.3609356",
                    "license": "CC BY 4.0",
                    "cite": [
                        "Arslan, Hassan, Li, Tremayne (2020). A Benchmark Dataset of "
                        "Check-worthy Factual Claims. ICWSM.",
                        "Meng, Jimenez, Arslan, Devasier, Obembe, Li (2020). Gradient-Based "
                        "Adversarial Training on Transformer Networks for Detecting "
                        "Check-Worthy Factual Claims.",
                    ],
                },
                {
                    "dataset": "English Wikinews articles",
                    "creator": "Wikinews contributors",
                    "url": "https://en.wikinews.org/",
                    "license": "CC BY 2.5",
                    "credit": "classifier/train/wikinews/sources.csv lists every article used",
                },
            ],
            "notice": "Labels check-worthiness, not truth. Do not present scores as truth ratings.",
        },
        "vocabulary": vocabulary,
        "idf": [rounded(v) for v in vectorizer.idf_],
        "coef": [rounded(v) for v in model.coef_[0]],
        "intercept": rounded(model.intercept_[0]),
        "feature_names": FEATURE_NAMES,
        # What the scorer must do to a sentence before these weights apply to it.
        "preprocess": {k: v for k, v in PREPROCESS.items() if v},
        "tfidf": dict(TFIDF),
        "calibration": calibration,
        "metrics": {
            "cv_folds": args.folds,
            "average_precision": float(np.mean(fold_ap)),
            "average_precision_sd": float(np.std(fold_ap)),
            "roc_auc": float(np.mean(fold_auc)),
            "roc_auc_sd": float(np.std(fold_auc)),
            "by_domain": cv_by_domain,
            "rows": int(len(texts)),
        },
    }
    model_path = os.path.join(args.out, "model.json")
    with open(model_path, "w", encoding="utf-8") as fh:
        # No space after the separators: Python's default added one after every
        # comma and colon, which was a tenth of the file.
        json.dump(payload, fh, separators=(",", ":"))
    size_mb = os.path.getsize(model_path) / 1e6
    print(f"\nwrote {model_path} ({size_mb:.2f} MB, {len(vocabulary)} terms)")

    # Parity fixture: the JavaScript test asserts scorer.js reproduces these numbers,
    # which catches any drift between the two implementations. Scored through the
    # exported (rounded, calibrated) model, since that is what the browser has.
    rng = np.random.RandomState(args.seed)
    sample = [texts[i] for i in rng.choice(len(texts), size=40, replace=False)]
    exported = json.load(open(model_path, encoding="utf-8"))
    fixture_scores = score_like_the_browser(exported, sample)
    with open(os.path.join(args.out, "parity_fixture.json"), "w", encoding="utf-8") as fh:
        json.dump({"sentences": sample, "scores": fixture_scores}, fh, indent=2)
    print(f"wrote {os.path.join(args.out, 'parity_fixture.json')} (40 sentences)")
    print("\nNow run: node --test classifier/inference/")


def score_like_the_browser(exported, sentences):
    """The exported model, applied the way scorer.js applies it: rounded weights,
    the declared tf, the declared calibration. Kept separate from scikit-learn so the
    fixture tests the file the browser gets and not the object Python had."""
    vocab = exported["vocabulary"]
    idf = exported["idf"]
    coef = exported["coef"]
    offset = len(idf)
    sublinear = exported.get("tfidf", {}).get("sublinear", False)
    cal = exported.get("calibration")
    out = []
    for text in sentences:
        toks = tokenizer(text)
        grams = toks + [f"{a} {b}" for a, b in zip(toks, toks[1:])]
        counts = {}
        for g in grams:
            idx = vocab.get(g)
            if idx is not None:
                counts[idx] = counts.get(idx, 0) + 1
        weighted = []
        norm = 0.0
        for idx, n in counts.items():
            tf = 1 + np.log(n) if sublinear else n
            v = tf * idf[idx]
            weighted.append((idx, v))
            norm += v * v
        norm = np.sqrt(norm)
        z = exported["intercept"]
        if norm > 0:
            for idx, v in weighted:
                z += (v / norm) * coef[idx]
        for i, on in enumerate(handcrafted(text)):
            if on:
                z += coef[offset + i]
        if cal:
            z = cal["a"] * z + cal["b"]
        out.append(float(sigmoid(z)))
    return out


if __name__ == "__main__":
    main()
