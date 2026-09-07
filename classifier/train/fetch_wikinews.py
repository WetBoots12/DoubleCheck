"""Collect sentences from English Wikinews articles for labelling.

Wikinews is news prose, written in the third person, attributed and full of
figures, across politics, science, sport, business and entertainment: the domain
the extension runs in and the one the ClaimBuster debate data does not cover. Its
text is CC BY 2.5, so a model trained on it can be shipped, provided the articles
are credited; this script writes the credit list as it goes.

What it does:
  1. Samples random published articles until each topic bucket has its share, so
     the set is not all politics.
  2. Fetches each article's plain text through the MediaWiki API, one request per
     article as the extracts endpoint requires, with a pause between requests.
  3. Keeps only the article body: the dateline, headings, the sources list and
     everything after it are discarded rather than labelled, which is what
     ClaimBuster did with moderators and questioners.
  4. Splits the body into sentences and drops any under five words, ClaimBuster's
     own cut.

Writes:
  raw/wikinews/sentences.csv       one row per sentence, unlabelled, with its article
  wikinews/sources.csv             the articles used: title, address, date (the credit)

Standard library only, so it runs wherever train.py does.

    python classifier/train/fetch_wikinews.py --articles 240
"""

import argparse
import csv
import json
import os
import random
import re
import sys
import time
import urllib.parse
import urllib.request

API = "https://en.wikinews.org/w/api.php"
# Wikimedia asks for a descriptive agent with a way to reach whoever is running it.
USER_AGENT = "FactCheckSidebar-training/1.0 (https://github.com/; classifier training data collection)"

TOPICS = [
    "Politics and conflicts", "Science and technology", "Sports", "Culture and entertainment",
    "Health", "Economy and business", "Crime and law", "Disasters and accidents", "Environment",
]

# Section headings after which an article is no longer prose.
END_SECTIONS = {"sources", "source", "related news", "related stories", "external links",
                "see also", "notes", "references", "sister links", "external link"}

ABBREVIATIONS = {"mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "no", "vs", "u.s", "u.k",
                 "e.g", "i.e", "gen", "gov", "sen", "rep", "lt", "col", "capt", "sgt", "inc", "co",
                 "ltd", "corp", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept",
                 "oct", "nov", "dec", "mt", "ft", "approx", "dept", "est", "ave"}

HERE = os.path.dirname(os.path.abspath(__file__))


def api(params, pause):
    params = {**params, "format": "json"}
    url = API + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                data = json.load(res)
            time.sleep(pause)
            return data
        except Exception as err:  # noqa: BLE001 - retry whatever the network did
            wait = 2 ** attempt
            print(f"  retry in {wait}s: {err}", file=sys.stderr)
            time.sleep(wait)
    raise RuntimeError("the API stopped answering")


def sample_articles(per_topic, pause, seed):
    """Random published articles, spread across the topic categories."""
    rng = random.Random(seed)
    buckets = {t: [] for t in TOPICS}
    seen = set()
    wanted = ["Category:Published", "Category:Disputed", "Category:No publish"] + [f"Category:{t}" for t in TOPICS]
    while any(len(b) < per_topic for b in buckets.values()):
        data = api({
            "action": "query", "generator": "random", "grnnamespace": 0, "grnlimit": 20,
            "prop": "categories", "cllimit": 50, "clcategories": "|".join(wanted),
        }, pause)
        pages = list(data.get("query", {}).get("pages", {}).values())
        rng.shuffle(pages)
        for p in pages:
            cats = {c["title"].replace("Category:", "") for c in p.get("categories", [])}
            if "Published" not in cats or "Disputed" in cats or "No publish" in cats:
                continue
            if p["pageid"] in seen:
                continue
            topics = [t for t in TOPICS if t in cats and len(buckets[t]) < per_topic]
            if not topics:
                continue
            seen.add(p["pageid"])
            buckets[rng.choice(topics)].append({"pageid": p["pageid"], "title": p["title"], "topics": sorted(cats & set(TOPICS))})
        print("  " + ", ".join(f"{t.split()[0]} {len(b)}" for t, b in buckets.items()), file=sys.stderr)
    return [a for b in buckets.values() for a in b]


def fetch_text(pageid, pause):
    data = api({
        "action": "query", "pageids": pageid, "prop": "extracts|info", "explaintext": 1,
        "exsectionformat": "plain", "inprop": "url",
    }, pause)
    page = list(data["query"]["pages"].values())[0]
    return page.get("extract", ""), page.get("fullurl", "")


DATELINE = re.compile(r"^(monday|tuesday|wednesday|thursday|friday|saturday|sunday),\s+\w+\s+\d{1,2},\s+\d{4}\s*$", re.I)


def body_paragraphs(extract):
    """The prose of the article: no dateline, no headings, nothing after the sources."""
    out = []
    date = ""
    for raw in extract.split("\n"):
        line = raw.strip()
        if not line:
            continue
        if DATELINE.match(line):
            date = line
            continue
        if line.lower().rstrip(":") in END_SECTIONS:
            break
        # A heading: short, no sentence punctuation. Skipped, not labelled.
        if len(line) < 60 and not re.search(r"[.!?]", line):
            continue
        # Editorial notes and pointers to Wikinews itself are not the story.
        if re.search(r"\bwikinews\b|this article|have your say|\bimage:|\bfile:", line, re.I):
            continue
        out.append(line)
    return out, date


def split_sentences(paragraph):
    text = re.sub(r"\s+", " ", paragraph).strip()
    # A boundary is sentence punctuation, an optional closing quote or bracket, then
    # whitespace before a capital, digit or opening quote. Marked, then split on the
    # mark, because Python's look-behind cannot be variable width.
    marked = re.sub(r"([.!?][\"'”’)\]]?)\s+(?=[\"'“‘(\[A-Z0-9])", "\\1\n", text)
    parts = marked.split("\n")
    merged = []
    for piece in parts:
        piece = piece.strip()
        if not piece:
            continue
        if merged:
            last = merged[-1]
            tail = re.search(r"([A-Za-z.]+)\.$", last)
            if tail and tail.group(1).lower().rstrip(".") in ABBREVIATIONS:
                merged[-1] = last + " " + piece
                continue
            # A split right after a single capital letter is an initial, "J. Smith".
            if re.search(r"\b[A-Z]\.$", last):
                merged[-1] = last + " " + piece
                continue
        merged.append(piece)
    return merged


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--articles", type=int, default=240, help="How many articles, spread over the topics")
    ap.add_argument("--pause", type=float, default=0.25, help="Seconds between requests")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--out", default=os.path.join(HERE, "raw", "wikinews", "sentences.csv"))
    ap.add_argument("--sources", default=os.path.join(HERE, "wikinews", "sources.csv"))
    args = ap.parse_args()

    per_topic = max(1, args.articles // len(TOPICS))
    print(f"sampling {per_topic} articles per topic", file=sys.stderr)
    articles = sample_articles(per_topic, args.pause, args.seed)

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    os.makedirs(os.path.dirname(args.sources), exist_ok=True)
    rows = []
    sources = []
    for k, art in enumerate(articles, 1):
        extract, url = fetch_text(art["pageid"], args.pause)
        paragraphs, date = body_paragraphs(extract)
        n = 0
        for para in paragraphs:
            for s in split_sentences(para):
                if len(s.split()) < 5:
                    continue
                n += 1
                rows.append({
                    "sentence_id": f"{art['pageid']}_{n}",
                    "text": s,
                    "pageid": art["pageid"],
                    "title": art["title"],
                    "url": url,
                    "date": date,
                    "topics": "; ".join(art["topics"]),
                })
        sources.append({"pageid": art["pageid"], "title": art["title"], "url": url, "date": date,
                        "topics": "; ".join(art["topics"]), "sentences": n})
        print(f"  [{k}/{len(articles)}] {n:>3} sentences  {art['title'][:70]}", file=sys.stderr)

    with open(args.out, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    with open(args.sources, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(sources[0].keys()))
        w.writeheader()
        w.writerows(sources)
    print(f"\nwrote {len(rows)} sentences from {len(sources)} articles to {args.out}")
    print(f"wrote the credit list to {args.sources}")


if __name__ == "__main__":
    main()
