"""Normalize claim-worthiness datasets into the columns training expects.

Reads one or more files and writes a CSV with `text`, `label` and `domain` columns,
where label is 1 for a check-worthy factual claim and 0 for anything else, and
domain records which corpus a row came from.

The domain column exists so that a blend can be judged rather than assumed. The
model is trained on US political debates, and the open question is how it behaves on
health, climate, technology and financial claims. Blending another corpus in without
being able to see per-corpus performance would answer that question by guessing;
train.py reports each domain separately when the column is present.

A caution that belongs here rather than in a commit message: a dataset that labels
whether a claim is TRUE is not a dataset for this task. FEVER, Climate-FEVER,
PubHealth and HealthVer all label veracity, and training on them teaches the model
to recognise verifiable-sounding sentences that someone already verified, which is a
different thing from a sentence worth checking. CLEF CheckThat! Task 1 is the
check-worthiness task. Check the licence of anything added here, and credit it in
ATTRIBUTION.md, as ClaimBuster is credited.

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
import json
import os
import sys

import pandas as pd

TEXT_CANDIDATES = ["text", "Text", "sentence", "Sentence", "claim", "Claim"]
LABEL_CANDIDATES = ["label", "Label", "Verdict", "verdict", "class", "Class"]

# Data credit: ClaimBuster, IDIR Lab, University of Texas at Arlington, CC BY 4.0.
# See ATTRIBUTION.md at the repository root. Required when redistributing either
# the data or a model derived from it.


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


def default_domain(path):
    """A readable name when --domain was not given: the file's own stem."""
    return os.path.splitext(os.path.basename(path))[0].lower()


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
    ap.add_argument("--input", required=True, action="append",
                    help="Raw CSV or JSON to read. Repeat to blend several corpora.")
    ap.add_argument("--domain", action="append", default=None,
                    help="Name for the matching --input, e.g. politics. Repeatable.")
    ap.add_argument("--cap", type=int, default=0,
                    help="Keep at most this many rows per source, sampled at random. "
                         "Use when one corpus would otherwise dominate the blend.")
    ap.add_argument("--seed", type=int, default=13, help="Sampling seed for --cap")
    ap.add_argument("--output", default="data/dataset.csv", help="Normalized CSV to write")
    ap.add_argument("--text-column", help="Override text column detection")
    ap.add_argument("--label-column", help="Override label column detection")
    ap.add_argument("--min-length", type=int, default=25,
                    help="Drop sentences shorter than this many characters")
    # Calibration has to happen on sentences the model never trained on, in the
    # domain it runs in. This carves a random slice out of one domain before the
    # training file is written, so the two can never overlap by accident.
    ap.add_argument("--holdout-domain", default=None,
                    help="Domain to hold a calibration slice out of, e.g. wikinews")
    ap.add_argument("--holdout", type=float, default=0.15,
                    help="Fraction of --holdout-domain to hold out")
    ap.add_argument("--holdout-output", default="data/holdout.csv",
                    help="Where the held-out slice is written")
    args = ap.parse_args()

    domains = args.domain or []
    if domains and len(domains) != len(args.input):
        sys.exit(f"Got {len(args.input)} --input and {len(domains)} --domain; "
                 "give one domain per input, or none at all.")

    frames = []
    for i, path in enumerate(args.input):
        if path.lower().endswith(".json"):
            # 2xNCS/2.5xNCS/3xNCS: already binary, already filtered by stricter label
            # agreement. The dataset authors report these train better than the raw CSVs.
            with open(path, encoding="utf-8") as fh:
                rows = json.load(fh)
            df = pd.DataFrame(rows)
        else:
            df = pd.read_csv(path, encoding="utf-8")

        text_col = pick_column(df, args.text_column, TEXT_CANDIDATES, "text")
        label_col = pick_column(df, args.label_column, LABEL_CANDIDATES, "label")

        part = pd.DataFrame({
            "text": df[text_col].astype(str).str.strip(),
            "label": to_binary(df[label_col]),
            "domain": domains[i] if domains else default_domain(path),
        })
        read = len(part)
        part = part[part["text"].str.len() >= args.min_length]
        if args.cap and len(part) > args.cap:
            part = part.sample(n=args.cap, random_state=args.seed)
        print(f"Read {read} rows from {path} -> {len(part)} kept "
              f"({int(part['label'].sum())} check-worthy)")
        frames.append(part)

    out = pd.concat(frames, ignore_index=True)

    # Later sources do not silently overwrite earlier ones: the same sentence in two
    # corpora keeps its first label, and the count of collisions is reported, because
    # two corpora disagreeing about a sentence is worth knowing about.
    dupes = int(out.duplicated(subset="text").sum())
    out = out.drop_duplicates(subset="text", keep="first")

    os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)

    if args.holdout_domain:
        pool = out[out["domain"] == args.holdout_domain]
        if pool.empty:
            sys.exit(f"No rows in domain '{args.holdout_domain}' to hold out from")
        held = pool.sample(frac=args.holdout, random_state=args.seed)
        out = out.drop(held.index)
        os.makedirs(os.path.dirname(args.holdout_output) or ".", exist_ok=True)
        held.to_csv(args.holdout_output, index=False)
        print(f"Held out {len(held)} {args.holdout_domain} rows "
              f"({int(held['label'].sum())} check-worthy) to {args.holdout_output}; "
              "they are not in the training file")

    out.to_csv(args.output, index=False)

    positives = int(out["label"].sum())
    if dupes:
        print(f"Dropped {dupes} sentences already present in an earlier source")
    print(f"Wrote {len(out)} rows to {args.output} "
          f"({positives} check-worthy, {len(out) - positives} not, "
          f"{positives / max(len(out), 1):.1%} positive)")
    if "domain" in out.columns and out["domain"].nunique() > 1:
        print("\nrows per domain:")
        for name, count in out["domain"].value_counts().items():
            share = out[out["domain"] == name]["label"].mean()
            print(f"  {name:<16} {count:>6}  {share:.1%} check-worthy")


if __name__ == "__main__":
    main()
