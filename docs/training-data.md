# Training data for the claim-worthiness classifier

> **Status: trained.** The shipped model uses ClaimBuster's `2.5xNCS.json`
> combined with `groundtruth.csv`: 10,706 sentences, average precision 0.864,
> ROC AUC 0.935, precision 0.870 at the 0.70 default threshold. Attribution
> requirements are in [`ATTRIBUTION.md`](../ATTRIBUTION.md).

## Which ClaimBuster files to train on

The zip holds several label files and they are not equally useful. Run
`classifier/train/compare_datasets.py` to reproduce this table; figures are held-out
average precision, averaged over five random seeds.

| Training set | Rows | AP | P@0.70 | Real-world margin |
|---|---|---|---|---|
| groundtruth.csv | 990 | **0.874** | 0.887 | 0.34 (missed a claim) |
| 2.5xNCS.json | 9,442 | 0.849 | 0.878 | 0.48 |
| 2.5xNCS + groundtruth (**shipped**) | 10,706 | 0.844 | 0.867 | **0.48** |
| 3xNCS.json | 10,794 | 0.831 | 0.851 | 0.46 |
| crowdsourced.csv | 21,943 | 0.741 | 0.744 | not tested |
| groundtruth + crowdsourced | 22,926 | 0.757 | 0.772 | not tested |

Two findings worth keeping in mind:

**More rows made it worse.** The largest file is also the noisiest, and training on
it dropped average precision from 0.85 to 0.74. Label quality beat quantity by a
wide margin here. Reach for stricter annotator agreement before reaching for volume.

**The best held-out score was the worst model in practice.** `groundtruth.csv`
scored highest on its own test split, but on real news sentences it separated
claims from non-claims by only 0.34 and missed one claim outright, because 990 rows
give too thin a vocabulary. That is the trap in optimizing a held-out number from a
distribution that is not your users' distribution. Always spot-check candidates on
real page text before believing the table.

A caution on the dataset's README: it reports 22,501 sentences for
`groundtruth.csv` and 1,032 for `crowdsourced.csv`, but the files on disk are the
other way round. Trust the files.

## The dataset we planned on

**ClaimBuster**, from the University of Texas at Arlington.

| | |
|---|---|
| Download | <https://zenodo.org/records/3836810> (`ClaimBuster_Datasets.zip`, 4.7 MB) |
| DOI | 10.5281/zenodo.3609356 |
| License | Creative Commons Attribution 4.0 — redistribution and reuse allowed with attribution (see [`ATTRIBUTION.md`](../ATTRIBUTION.md)) |
| Size | 23,533 sentences |
| Source material | Every U.S. general election presidential debate, 1960 to 2016 |
| Labels | Non-factual statement, unimportant factual statement, check-worthy factual statement |

Cite the 2020 AAAI ICWSM paper by Arslan, Hassan, Li and Tremayne when using it.

The zip contains the crowdsourced and groundtruth files. `prepare_data.py` reads
either, and maps only check-worthy factual sentences to a positive label, treating
unimportant facts as negatives on the reasoning that they are not worth a search
call.

```bash
python classifier/train/prepare_data.py --input crowdsourced.csv --output classifier/train/data/dataset.csv
```

## The problem with using only ClaimBuster

It is transcribed political debate speech from 1960 to 2016. This extension runs on
news articles, blog posts, and YouTube captions. That gap matters more than it may
sound:

- Debate speech is spoken, first-person, and adversarial. News prose is written,
  third-person, and attributed. The surface cues differ, and a bag-of-n-grams model
  keys on surface cues.
- Debate transcripts are clean single sentences. Captions arrive without
  punctuation or capitalization, which strips signals the model may lean on.
- The vocabulary is dated and heavily U.S.-political. Sports, health, science, and
  finance claims are barely represented.

This concern turned out milder than expected. Spot-checking the trained model on
news prose, encyclopedia text and page furniture, claims scored 0.77 to 0.99 and
non-claims 0.05 to 0.30, a clean gap either side of the 0.70 threshold. Worth
re-measuring on your own browsing rather than trusting one spot check, but the
domain shift is not crippling.

## Worth adding

**CLEF CheckThat! check-worthiness data.** The strongest external option, and much
closer to the extension's real input than debate transcripts are. The 2024 task
released 66,630 labeled instances across four languages, 24,191 of them English,
drawn from social and mainstream media rather than debate stages. Datasets live in
the lab's GitLab repositories, one per year:

- 2024: <https://gitlab.com/checkthat_lab/clef2024-checkthat-lab>
- 2025: <https://gitlab.com/checkthat_lab/clef2025-checkthat-lab>

Licensing varies by year and by subtask, so check each release before use and
record what you find in `ATTRIBUTION.md`. The 2025 edition adds claim
normalization and numerical-claim tasks, which are adjacent rather than a drop-in
replacement.

Given the finding above, add it as a *separate* labeled pool and measure, rather
than pouring it in and assuming more is better. Mainstream-media phrasing is
exactly the vocabulary the debate data lacks, so this is the most promising single
addition available.

**Your own captions and articles.** The highest-value addition, because it matches
the real input distribution exactly. The stress fixture and the caption probe both
produce sentences you can label. A few hundred labeled sentences drawn from pages
you actually browse will likely help more than tens of thousands of debate lines.

**Negative examples from page furniture.** Nav text, captions, promos, and cookie
notices are what the extractor accidentally picks up. None appear in ClaimBuster,
so the model never learns to reject them. Harvesting these from real pages as
negatives is cheap and directly targets the failure mode.

## What Snopes suggests about labeling

Snopes rates claims on a five-point scale, True, Mostly True, Mixture, Mostly False
and False, plus categories such as Outdated, Miscaptioned and Satire. Two things in
their approach transfer usefully here, even though they are verifying truth and this
classifier is not:

**They rate a precisely worded claim, not a passage.** The wording of the claim
statement is what the rating applies to. That argues for labeling at sentence
granularity and for splitting compound sentences before labeling, since half a
sentence can be checkable while the other half is opinion.

**Their selection is driven by what is circulating and consequential.** Not every
verifiable statement is worth checking. "The meeting was on Tuesday" is factual and
pointless. This is the same distinction ClaimBuster draws between unimportant and
check-worthy factual sentences, and it is the distinction the classifier has to
learn. When labeling your own data, ask "would a fact-checker bother?", not "is this
a fact?".

A caution on scope: their graded scale is for verdicts, and this classifier does not
produce verdicts. Do not try to train truth ratings into it. Truth assessment here
comes from the search results and the optional AI step, which see evidence the
classifier never does.

## Tuning the threshold

`train.py` prints precision, recall and F1 across thresholds from 0.3 to 0.8, plus
how many test sentences each would flag.

Favor precision. Every flagged claim is a button the user might press, and every
press is a search call against their quota. A model flagging 40% of a page at 0.55
precision is worse than useless: it trains the user to ignore the panel. Start
around the threshold giving roughly 0.7 precision, then check it against a real
article and the stress fixture.

The shipped model's table put 0.70 at 0.855 precision and 0.599 recall, flagging
385 of 2,159 held-out sentences, which is the default now set in the extension.
Dropping to 0.50 would raise recall to 0.758 but cut precision to 0.721, meaning
roughly one flagged claim in four is not worth checking.

## Sources

- [ClaimBuster dataset on Zenodo](https://zenodo.org/records/3836810)
- [A Benchmark Dataset of Check-worthy Factual Claims (arXiv)](https://arxiv.org/abs/2004.14425)
- [Snopes fact-check ratings](https://www.snopes.com/fact-check-ratings/)
