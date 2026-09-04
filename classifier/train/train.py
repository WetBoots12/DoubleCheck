"""Train the claim-worthiness classifier and export it for the browser.

Model: tf-idf over word unigrams and bigrams, plus a handful of binary features,
fed to logistic regression. This is deliberately small. The extension scores every
sentence on every page, so a model that ships as a JSON file and runs in plain
JavaScript beats a transformer that needs a runtime and tens of megabytes. Swap in
something heavier later if the metrics justify it; the interface the extension sees
(`scoreClaimWorthiness`) does not change.

IMPORTANT: tokenization and FEATURE_NAMES below must mirror
classifier/inference/scorer.js exactly. train.py writes a parity fixture that the
JavaScript test checks against, so a drift between the two fails that test.

Usage:
    python train.py --data data/dataset.csv
    python train.py --data data/dataset.csv --max-features 30000 --min-df 3
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
from sklearn.metrics import (average_precision_score, classification_report,
                             precision_recall_fscore_support, roc_auc_score)
from sklearn.model_selection import train_test_split

TOKEN_RE = re.compile(r"[a-z0-9']+")

# Order matters: the JavaScript scorer appends these in exactly this sequence.
FEATURE_NAMES = [
    "has_digit", "has_percent", "has_year", "has_big_number", "has_attribution",
    "has_quantifier", "has_causal", "has_hedge", "first_person", "is_question", "is_long",
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
}


def tokenizer(text):
    return TOKEN_RE.findall(text.lower())


def handcrafted(text):
    row = []
    for name in FEATURE_NAMES:
        if name == "is_long":
            row.append(1 if len(text.split()) >= 15 else 0)
        else:
            row.append(1 if FEATURE_PATTERNS[name].search(text) else 0)
    return row


def build_matrix(vectorizer, texts, fit=False):
    tfidf = vectorizer.fit_transform(texts) if fit else vectorizer.transform(texts)
    extra = sparse.csr_matrix(np.array([handcrafted(t) for t in texts], dtype=np.float64))
    return sparse.hstack([tfidf, extra], format="csr")


def threshold_table(y_true, scores):
    rows = []
    for threshold in [0.3, 0.4, 0.5, 0.6, 0.7, 0.8]:
        pred = (scores >= threshold).astype(int)
        p, r, f1, _ = precision_recall_fscore_support(
            y_true, pred, average="binary", zero_division=0
        )
        flagged = int(pred.sum())
        rows.append((threshold, p, r, f1, flagged))
    return rows


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data", default="data/dataset.csv",
                    help="CSV with text and label columns, from prepare_data.py")
    ap.add_argument("--out", default="../model", help="Directory to write model.json into")
    ap.add_argument("--max-features", type=int, default=20000)
    ap.add_argument("--min-df", type=int, default=2)
    ap.add_argument("--test-size", type=float, default=0.2)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    df = pd.read_csv(args.data).dropna(subset=["text", "label"])
    texts = df["text"].astype(str).tolist()
    labels = df["label"].astype(int).to_numpy()
    print(f"{len(texts)} sentences, {labels.sum()} check-worthy ({labels.mean():.1%})")

    x_train_text, x_test_text, y_train, y_test = train_test_split(
        texts, labels, test_size=args.test_size, random_state=args.seed, stratify=labels
    )

    vectorizer = TfidfVectorizer(
        tokenizer=tokenizer,
        lowercase=True,
        ngram_range=(1, 2),
        max_features=args.max_features,
        min_df=args.min_df,
        sublinear_tf=False,   # scorer.js uses raw counts
        smooth_idf=True,      # scorer.js expects sklearn's smoothed idf
        norm="l2",
        token_pattern=None,
    )

    x_train = build_matrix(vectorizer, x_train_text, fit=True)
    x_test = build_matrix(vectorizer, x_test_text)

    # Check-worthy sentences are the minority class in every dataset of this kind.
    model = LogisticRegression(max_iter=2000, class_weight="balanced", C=1.0)
    model.fit(x_train, y_train)

    scores = model.predict_proba(x_test)[:, 1]
    print("\n--- Held-out performance ---")
    print(classification_report(y_test, (scores >= 0.5).astype(int),
                                target_names=["not check-worthy", "check-worthy"],
                                zero_division=0))
    print(f"average precision: {average_precision_score(y_test, scores):.3f}")
    print(f"roc auc:           {roc_auc_score(y_test, scores):.3f}")

    print("\nthreshold  precision  recall     f1      flagged")
    for threshold, p, r, f1, flagged in threshold_table(y_test, scores):
        print(f"  {threshold:.2f}      {p:.3f}      {r:.3f}   {f1:.3f}   {flagged}")
    print("\nPick the extension's default threshold from this table: precision matters "
          "more than recall here, since every flagged claim costs the user a search call.")

    os.makedirs(args.out, exist_ok=True)
    vocabulary = {term: int(i) for term, i in vectorizer.vocabulary_.items()}
    payload = {
        "version": 1,
        "created_from": os.path.basename(args.data),
        "vocabulary": vocabulary,
        "idf": [float(v) for v in vectorizer.idf_],
        "coef": [float(v) for v in model.coef_[0]],
        "intercept": float(model.intercept_[0]),
        "feature_names": FEATURE_NAMES,
        "metrics": {
            "average_precision": float(average_precision_score(y_test, scores)),
            "roc_auc": float(roc_auc_score(y_test, scores)),
            "test_size": int(len(y_test)),
        },
    }
    model_path = os.path.join(args.out, "model.json")
    with open(model_path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh)
    size_mb = os.path.getsize(model_path) / 1e6
    print(f"\nwrote {model_path} ({size_mb:.2f} MB, {len(vocabulary)} terms)")

    # Parity fixture: the JavaScript test asserts scorer.js reproduces these numbers,
    # which catches any drift between the two implementations.
    sample = x_test_text[:40]
    fixture = {
        "sentences": sample,
        "scores": [float(s) for s in model.predict_proba(build_matrix(vectorizer, sample))[:, 1]],
    }
    fixture_path = os.path.join(args.out, "parity_fixture.json")
    with open(fixture_path, "w", encoding="utf-8") as fh:
        json.dump(fixture, fh, indent=2)
    print(f"wrote {fixture_path} ({len(sample)} sentences)")
    print("\nNow run: node --test classifier/inference/")


if __name__ == "__main__":
    main()
