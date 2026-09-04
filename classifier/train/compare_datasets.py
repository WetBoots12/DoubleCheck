"""Compare what different slices of the training data actually buy you.

More rows is not automatically better: the ClaimBuster files differ in how strictly
annotators had to agree, and the loosely-labelled ones carry more noise. This trains
the same pipeline on each candidate and prints one table, so the choice is measured
rather than assumed.

Usage:
    python compare_datasets.py
"""

import json
import os

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, precision_recall_fscore_support, roc_auc_score
from sklearn.model_selection import train_test_split

from train import FEATURE_NAMES, build_matrix, tokenizer  # noqa: F401
from sklearn.feature_extraction.text import TfidfVectorizer

RAW = os.path.join("raw", "ClaimBuster_Datasets", "datasets")


def from_json(name):
    with open(os.path.join(RAW, name), encoding="utf-8") as fh:
        rows = json.load(fh)
    return pd.DataFrame({"text": [r["text"] for r in rows], "label": [int(r["label"]) for r in rows]})


def from_csv(name):
    df = pd.read_csv(os.path.join(RAW, name), encoding="utf-8")
    # Verdict: 1 = check-worthy factual, 0 = unimportant factual, -1 = non-factual.
    return pd.DataFrame({"text": df["Text"].astype(str), "label": (df["Verdict"] == 1).astype(int)})


def clean(df):
    df = df.dropna(subset=["text", "label"])
    df["text"] = df["text"].astype(str).str.strip()
    df = df[df["text"].str.len() >= 25]
    return df.drop_duplicates(subset="text")


def evaluate(name, df, seed=42):
    df = clean(df)
    texts = df["text"].tolist()
    labels = df["label"].astype(int).to_numpy()
    if labels.sum() < 50:
        return None

    x_tr_t, x_te_t, y_tr, y_te = train_test_split(
        texts, labels, test_size=0.2, random_state=seed, stratify=labels
    )
    vec = TfidfVectorizer(
        tokenizer=tokenizer, lowercase=True, ngram_range=(1, 2), max_features=20000,
        min_df=2, sublinear_tf=False, smooth_idf=True, norm="l2", token_pattern=None,
    )
    x_tr = build_matrix(vec, x_tr_t, fit=True)
    x_te = build_matrix(vec, x_te_t)

    model = LogisticRegression(max_iter=2000, class_weight="balanced", C=1.0)
    model.fit(x_tr, y_tr)
    scores = model.predict_proba(x_te)[:, 1]

    p70, r70, _, _ = precision_recall_fscore_support(
        y_te, (scores >= 0.70).astype(int), average="binary", zero_division=0
    )
    return {
        "dataset": name,
        "rows": len(df),
        "positive": f"{labels.mean():.0%}",
        "ap": average_precision_score(y_te, scores),
        "auc": roc_auc_score(y_te, scores),
        "p@0.70": p70,
        "r@0.70": r70,
    }


def main():
    gt = from_csv("groundtruth.csv")
    cs = from_csv("crowdsourced.csv")

    candidates = [
        ("3xNCS.json (current)", from_json("3xNCS.json")),
        ("2.5xNCS.json", from_json("2.5xNCS.json")),
        ("2xNCS.json", from_json("2xNCS.json")),
        ("groundtruth.csv", gt),
        ("crowdsourced.csv", cs),
        ("groundtruth + crowdsourced", pd.concat([gt, cs], ignore_index=True)),
        ("all NCS + groundtruth", pd.concat([from_json("3xNCS.json"), gt], ignore_index=True)),
    ]

    rows = [r for r in (evaluate(n, d) for n, d in candidates) if r]
    print(f"\n{'dataset':<28}{'rows':>8}{'pos':>6}{'AP':>8}{'AUC':>8}{'P@.70':>8}{'R@.70':>8}")
    print("-" * 74)
    for r in sorted(rows, key=lambda r: -r["ap"]):
        print(f"{r['dataset']:<28}{r['rows']:>8,}{r['positive']:>6}"
              f"{r['ap']:>8.3f}{r['auc']:>8.3f}{r['p@0.70']:>8.3f}{r['r@0.70']:>8.3f}")
    print("\nAP (average precision) is the headline number: it summarizes precision")
    print("across all thresholds and is not fooled by class imbalance the way accuracy is.")


if __name__ == "__main__":
    main()
