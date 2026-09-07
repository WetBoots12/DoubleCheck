"""Two small rewrites applied to a sentence before it is scored.

IMPORTANT: classifier/inference/textprep.js is the same code in JavaScript, and the
two must produce identical strings. Running this file writes a fixture that the
JavaScript test checks itself against:

    python classifier/train/textprep.py --fixture classifier/eval/prep_fixture.json

Change one side, change both, then regenerate the fixture.

1. Numbers written as words become digits, so "a quarter of the world's cobalt"
   carries the digit the model's strongest feature looks for.
2. Runs of capitalised words become one ENTITY token, so the model learns the shape
   "ENTITY raised rates by 0.25 point" rather than the names in the debate room.

See textprep.js for the reasoning at length. Pure Python, no dependencies, so the
fixture can be written on a machine without scikit-learn.
"""

import argparse
import json
import re

ENTITY_TOKEN = "xent"

# --- numbers ------------------------------------------------------------------------------

UNITS = {
    "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7,
    "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13,
    "fourteen": 14, "fifteen": 15, "sixteen": 16, "seventeen": 17, "eighteen": 18,
    "nineteen": 19,
}
TENS = {"twenty": 20, "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60, "seventy": 70,
        "eighty": 80, "ninety": 90}
SMALL_SCALES = {"hundred": 100, "thousand": 1000}

NUMBER_WORD = "|".join(list(UNITS) + list(TENS) + list(SMALL_SCALES))

NUMBER_RUN = re.compile(
    r"\b(?:" + NUMBER_WORD + r")(?:(?:[\s-]+|[\s-]+and[\s-]+)(?:" + NUMBER_WORD + r"))*\b",
    re.I,
)

ONE_COUNTS_BEFORE = re.compile(r"^\s+(in|percent|per|million|billion|trillion)\b", re.I)

FRACTIONS = [
    (re.compile(r"\b(two|2)[\s-]thirds\b", re.I), "0.67"),
    (re.compile(r"\b(three|3)[\s-]quarters\b", re.I), "0.75"),
    (re.compile(r"\b(two|2)[\s-]fifths\b", re.I), "0.4"),
    (re.compile(r"\b(three|3)[\s-]fifths\b", re.I), "0.6"),
    (re.compile(r"\b(a|one)[\s-]half\b", re.I), "0.5"),
    (re.compile(r"\b(a|one)[\s-]third\b", re.I), "0.33"),
    (re.compile(r"\b(a|one)[\s-]quarter\b", re.I), "0.25"),
    (re.compile(r"\b(a|one)[\s-]fifth\b", re.I), "0.2"),
    (re.compile(r"\b(a|one)[\s-]sixth\b", re.I), "0.17"),
    (re.compile(r"\b(an|one)[\s-]eighth\b", re.I), "0.13"),
    (re.compile(r"\b(a|one)[\s-]tenth\b", re.I), "0.1"),
    (re.compile(r"\bhalf(?=\s+(of|its|the|a|an|as|their|his|her|our|all|that|this)\b)", re.I), "0.5"),
    (re.compile(r"\ba dozen\b", re.I), "12"),
    (re.compile(r"\btwice\b", re.I), "2 times"),
]

A_SCALE = re.compile(r"\ba (hundred|thousand)\b", re.I)
NO_BEFORE = re.compile(r"\bno\s$")
ANOTHER_AFTER = re.compile(r"^\s+another\b", re.I)


def spoken_year(words):
    """'nineteen ninety five', 'twenty twenty-four': a century word then a tens word."""
    if len(words) < 2 or len(words) > 3:
        return None
    century, tens = words[0], words[1]
    unit = words[2] if len(words) == 3 else None
    if century not in ("nineteen", "twenty") or tens not in TENS:
        return None
    if unit is not None and not (unit in UNITS and UNITS[unit] < 10):
        return None
    return (1900 if century == "nineteen" else 2000) + TENS[tens] + (UNITS[unit] if unit else 0)


def words_to_number(run):
    words = [w for w in re.split(r"[\s-]+", run.lower()) if w and w != "and"]
    year = spoken_year(words)
    if year is not None:
        return year
    total = 0
    current = 0
    for w in words:
        if w in UNITS:
            current += UNITS[w]
        elif w in TENS:
            current += TENS[w]
        elif w == "hundred":
            current = (current or 1) * 100
        elif w == "thousand":
            total += (current or 1) * 1000
            current = 0
    return total + current


def normalize_numbers(text):
    out = str(text or "")
    for pattern, rep in FRACTIONS:
        out = pattern.sub(rep, out)
    out = A_SCALE.sub(lambda m: str(SMALL_SCALES[m.group(1).lower()]), out)

    def replace(m):
        run = m.group(0)
        if run.lower() == "one":
            before = out_text[max(0, m.start() - 3):m.start()].lower()
            if NO_BEFORE.search(before):
                return run
            after = out_text[m.end():]
            if ANOTHER_AFTER.match(after):
                return run
            if not ONE_COUNTS_BEFORE.match(after):
                return run
        return str(words_to_number(run))

    out_text = out
    return NUMBER_RUN.sub(replace, out)


# --- entities -----------------------------------------------------------------------------

OPENERS = set(("the a an this that these those many some most all both each "
               "his her their our its it he she they we you more fewer several few").split())

LEAD = re.compile(r"^[^A-Za-z]+")
TRAIL = re.compile(r"[^A-Za-z'’]+$")
NAME = re.compile(r"^[A-Z][A-Za-z'’]*$")


def core(word):
    return TRAIL.sub("", LEAD.sub("", word))


def looks_like_name(c):
    if len(c) < 2:
        return False
    if c == "I" or c.startswith("I'") or c.startswith("I’"):
        return False
    return bool(NAME.match(c))


def mask_entities(text):
    words = str(text or "").split()
    if not words:
        return ""
    cores = [core(w) for w in words]
    named = []
    for i, c in enumerate(cores):
        if not looks_like_name(c):
            named.append(False)
        elif i == 0:
            named.append(c.lower() not in OPENERS and len(cores) > 1 and looks_like_name(cores[1]))
        else:
            named.append(True)

    out = []
    for i, w in enumerate(words):
        if not named[i]:
            out.append(w)
            continue
        if i > 0 and named[i - 1]:
            continue
        out.append(ENTITY_TOKEN)
    return " ".join(out)


def prepare(text, numbers=True, entities=True):
    """Returns (feature_text, token_text), the same split scorer.js makes."""
    feature_text = normalize_numbers(text) if numbers else str(text or "")
    token_text = mask_entities(feature_text) if entities else feature_text
    return feature_text, token_text


# --- the fixture the JavaScript side checks itself against ---------------------------------

FIXTURE_SENTENCES = [
    "The Great Barrier Reef has lost half its coral cover since 1995.",
    "The Federal Reserve raised interest rates by a quarter point on Wednesday.",
    "The sensor uses a tenth of the power of the previous design.",
    "The mine produced a quarter of the world's cobalt last year.",
    "The hospital has closed two of its emergency wards because of staff shortages.",
    "The prison is holding almost twice as many inmates as it was designed for.",
    "More than forty thousand people have been displaced by the flooding in Bavaria.",
    "Four hundred and fifty homes were lost, and twenty-one people died.",
    "Two-thirds of the school's teachers have left in the past two years.",
    "One in five households now relies on a food bank.",
    "One possible explanation is that the effect is driven by confounding.",
    "No one wanted to be the first to leave, and they looked at one another.",
    "The performances are uniformly excellent, especially in the second half.",
    "Djokovic beat Alcaraz 6-3, 4-6, 7-5 to reach the final.",
    "Man City 2 Liverpool 2 (Haaland 12, Foden 67; Salah 30, Diaz 88).",
    "Tesla delivered 1.8 million vehicles in 2023, up 38 percent from the previous year.",
    "Iran launched more than three hundred drones and missiles at Israel overnight.",
    "I think the government is making a huge mistake here, and I'm not alone.",
    "It was a beautiful morning and the streets of Old Delhi were quiet.",
    "Updated 14:32 GMT, 6 September 2026.",
    "\"Reef lost half its coral,\" the BBC said, quoting Dr. Jane Smith of NOAA.",
    "the reef has lost half its coral cover since nineteen ninety five",
    "in twenty twenty-four turnout was sixty seven percent the highest since twenty twelve",
    "crime in the city is at its lowest level in thirty years",
    "A hundred years ago a dozen ships sailed; a thousand men were aboard.",
    "Wind power supplied a third of the country's electricity last year.",
    "The Office for National Statistics reported that inflation rose to 8.2 percent.",
    "",
    "   ",
    "X",
    "NASA and the FBI disagree; McIlroy and O'Brien do not.",
]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--fixture", help="Write the parity fixture to this path")
    args = ap.parse_args()
    rows = []
    for s in FIXTURE_SENTENCES:
        feature_text, token_text = prepare(s)
        rows.append({"text": s, "numbers": feature_text, "masked": token_text})
    if args.fixture:
        with open(args.fixture, "w", encoding="utf-8") as fh:
            json.dump(rows, fh, indent=2, ensure_ascii=False)
        print(f"wrote {args.fixture} ({len(rows)} sentences)")
    else:
        for r in rows:
            print(r["text"])
            print("  ->", r["masked"])


if __name__ == "__main__":
    main()
