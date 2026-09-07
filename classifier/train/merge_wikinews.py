"""Join the Wikinews sentences to their labels and write the dataset that is committed.

The sentences come from fetch_wikinews.py and the labels from a hand-labelling pass
that followed LABELLING.md, ClaimBuster's own scheme: 1 for a check-worthy factual
sentence, 0 for an unimportant factual one, -1 for a non-factual one. A label of x
means the line was not prose at all, a source citation or a scoreboard that slipped
past the body filter, and is discarded rather than labelled, as ClaimBuster
discarded its moderators.

One article is capped at forty sentences. A live-coverage piece ran to 280, all of
it protest colour, and without the cap one story would have been a tenth of the set.

Writes wikinews/labelled.csv with the text, the verdict and the article it came
from, so the CC BY credit travels with every row.

    python classifier/train/merge_wikinews.py
"""

import argparse
import collections
import csv
import os

HERE = os.path.dirname(os.path.abspath(__file__))
CAP = 40


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--sentences", default=os.path.join(HERE, "raw", "wikinews", "sentences.csv"))
    ap.add_argument("--labels", default=os.path.join(HERE, "raw", "wikinews", "labels.csv"))
    ap.add_argument("--out", default=os.path.join(HERE, "wikinews", "labelled.csv"))
    args = ap.parse_args()

    with open(args.labels, encoding="utf-8") as fh:
        labels = {r["sentence_id"]: r["verdict"].strip() for r in csv.DictReader(fh)}
    with open(args.sentences, encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))

    kept = []
    dropped = collections.Counter()
    for r in rows:
        index = int(r["sentence_id"].split("_")[1])
        if index > CAP:
            dropped["over the per-article cap"] += 1
            continue
        verdict = labels.get(r["sentence_id"])
        if verdict is None:
            dropped["unlabelled"] += 1
            continue
        if verdict == "x":
            dropped["not prose"] += 1
            continue
        kept.append({
            "sentence_id": r["sentence_id"],
            "text": r["text"],
            "Verdict": int(verdict),
            "title": r["title"],
            "url": r["url"],
            "date": r["date"],
            "topics": r["topics"],
        })

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(kept[0].keys()))
        w.writeheader()
        w.writerows(kept)

    counts = collections.Counter(r["Verdict"] for r in kept)
    articles = len({r["url"] for r in kept})
    print(f"wrote {len(kept)} sentences from {articles} articles to {args.out}")
    print(f"  CFS (1): {counts[1]}   UFS (0): {counts[0]}   NFS (-1): {counts[-1]}"
          f"   check-worthy share {counts[1] / len(kept):.1%}")
    for reason, n in dropped.items():
        print(f"  dropped {n}: {reason}")
    by_topic = collections.Counter()
    pos_topic = collections.Counter()
    for r in kept:
        for t in r["topics"].split("; "):
            if t:
                by_topic[t] += 1
                pos_topic[t] += r["Verdict"] == 1
    print("  by topic:")
    for t, n in by_topic.most_common():
        print(f"    {t:<28}{n:>5}  {pos_topic[t] / n:.0%} check-worthy")


if __name__ == "__main__":
    main()
