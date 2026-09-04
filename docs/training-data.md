# Training data for the claim-worthiness classifier

> **Status: trained.** The model in `classifier/model/model.json` is trained on
> ClaimBuster's `3xNCS.json`. Average precision 0.837, ROC AUC 0.927, precision
> 0.855 at the 0.70 threshold the extension now defaults to. Attribution
> requirements are in [`ATTRIBUTION.md`](../ATTRIBUTION.md).

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

**CLEF CheckThat! check-worthiness data.** Multiple years of shared-task data
covering tweets and political speech, and closer to social-media phrasing than
debates are. Licensing varies by year, so check each release.

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
