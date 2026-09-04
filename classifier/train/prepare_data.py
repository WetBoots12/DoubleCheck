"""Normalize a claim-worthiness dataset into the two columns training expects.

Reads a CSV and writes one with exactly `text` and `label` columns, where label is
1 for a check-worthy factual claim and 0 for anything else.

ClaimBuster's released files (crowdsourced.csv, groundtruth.csv) carry a `Verdict`
column using 1 = check-worthy factual sentence (CFS), 0 = unimportant factual
sentence (UFS), -1 = non-factual sentence (NFS). Only CFS becomes a positive label;
both other classes are negatives, since an unimportant fact is not worth spending a
search call on.

Usage:
    python prepare_data.py --input raw/crowdsourced.csv --output data/dataset.csv
    python prepare_data.py --input mydata.csv --text-column Sentence --label-column Flag
"""

import argparse
import sys

import pandas as pd

TEXT_CANDIDATES = ["text", "Text", "sentence", "Sentence", "claim", "Claim"]
LABEL_CANDIDATES = ["label", "Label", "Verdict", "verdict", "class", "Class"]


def pick_column(df, explicit, candidates, kind):
    if explicit:
        if explicit not in df.columns:
            sys.exit(f"Column '{explicit}' not in file. Available: {list(df.columns)}")
        return explicit
    for name in candidates:
        if name in df.columns:
            return name
    sys.exit(
        f"Could not find a {kind} column automatically. "
        f"Available columns: {list(df.columns)}. Pass --{kind}-column."
    )


def to_binary(series):
    """Map a label column onto 0/1, treating ClaimBuster's -1/0/1 verdicts correctly."""
    values = set(series.dropna().unique())
    if values <= {-1, 0, 1}:
        return (series == 1).astype(int)
    if values <= {0, 1}:
        return series.astype(int)
    sys.exit(f"Unrecognized label values: {sorted(values)}. Expected 0/1 or -1/0/1.")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--input", required=True, help="Raw CSV to read")
    ap.add_argument("--output", default="data/dataset.csv", help="Normalized CSV to write")
    ap.add_argument("--text-column", help="Override text column detection")
    ap.add_argument("--label-column", help="Override label column detection")
    ap.add_argument("--min-length", type=int, default=25,
                    help="Drop sentences shorter than this many characters")
    args = ap.parse_args()

    df = pd.read_csv(args.input)
    text_col = pick_column(df, args.text_column, TEXT_CANDIDATES, "text")
    label_col = pick_column(df, args.label_column, LABEL_CANDIDATES, "label")

    out = pd.DataFrame({
        "text": df[text_col].astype(str).str.strip(),
        "label": to_binary(df[label_col]),
    })

    before = len(out)
    out = out[out["text"].str.len() >= args.min_length]
    out = out.drop_duplicates(subset="text")

    import os
    os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)
    out.to_csv(args.output, index=False)

    positives = int(out["label"].sum())
    print(f"Read {before} rows from {args.input}")
    print(f"Wrote {len(out)} rows to {args.output} "
          f"({positives} check-worthy, {len(out) - positives} not, "
          f"{positives / max(len(out), 1):.1%} positive)")


if __name__ == "__main__":
    main()
