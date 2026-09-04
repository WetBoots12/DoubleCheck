# FactCheck Sidebar

A Chromium extension that flags check-worthy claims on pages and in YouTube
captions as you read and watch, then helps you cross-reference them against
search results in a side panel.

---

## Disclaimer — read this first

**Nothing this extension shows you is a statement of fact.** It is a research
aid, not an authority. Its purpose is to help you cross-check what you read and
watch for yourself.

Specifically:

- **Flagging a sentence says nothing about whether it is true.** The classifier
  only estimates whether a sentence looks like the kind of claim worth checking.
  A flagged claim is not a suspect claim, and an unflagged one is not a verified
  one. Plenty of false statements will never be flagged.
- **Search results are not verification.** They are links that a search engine
  returned for the wording of a sentence. They may be irrelevant, outdated, wrong,
  or contradicted by better sources the search never surfaced.
- **AI summaries can be confidently wrong.** Language models misread sources,
  overstate agreement, and invent detail. The summary is the model's reading of a
  handful of search snippets, not an adjudication.
- **The thermometer is an evidence score, not a truth score.** Its position comes
  from a published fact-check when one exists, otherwise from the stance the AI
  assigned to each source, weighted by how closely the source matches the claim
  and by a short, visible tier list of source types. "Evidence strength" measures
  how much credible, plainly worded coverage a claim has, which is not the same
  as whether it is true. Everything that went into the reading is listed under
  it. The tier list is this project's own, editable in settings, and is not a
  media-ratings service.
- **Outlet lean estimates are guesses.** They come from the AI model you chose,
  not from any media-ratings organization, and this project has no affiliation
  with AllSides, Ad Fontes Media, Media Bias/Fact Check, or any similar service.
- **Read the actual sources.** The links in the panel are the point. The summary
  above them is a shortcut that can be wrong, and no amount of interface polish
  changes that.

**No liability is accepted.** This software is provided as is, without warranty
of any kind, express or implied. The author accepts no liability for what you
find using it, for what you conclude from it, for decisions you make on the basis
of it, or for any damages arising from its use. You are responsible for verifying
anything that matters to you, and for your own use of the third-party search and
AI services you configure it to call.

If you are redistributing this or relying on it in any professional capacity, get
your own legal advice. The paragraph above is a plain-language statement of
intent, not a lawyer-drafted licence.

---

## What it does

1. Text from the page, or captions from a YouTube video, is split into sentences.
2. A trained classifier scores each sentence for check-worthiness, entirely on
   your machine. Nothing is sent anywhere at this stage.
3. Sentences above the threshold are highlighted on the page and listed in the
   side panel.
4. **Only when you press a button** does it call a search API, and optionally an
   AI model, to cross-reference that claim. Nothing is spent automatically.

That last point is deliberate. A page dense with claims could otherwise burn
through an API quota in seconds.

Answers are also remembered for a day, on your machine only, so checking the same
claim twice, or reading a second article about the same event, costs one call
instead of two. The options page can switch that off and empty what is stored.

The claim detector reads English only. On a page in another language it says so in
the panel and stays out of the way, rather than flagging sentences it cannot judge.
The thumbs-up on the site row overrides that if you want it to try anyway.

## Installing

No build step. Load it unpacked:

1. Open `chrome://extensions` (Brave and Edge work too).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and choose this folder.

It works out of the box. Check sources uses Wikipedia, which needs no key, and
every claim has a Search in browser button that opens your default search engine,
whichever you use. For full web results inside the panel, add a SerpAPI or Brave
Search key on the options page.

Two optional extras, both configured on the same page. **Published fact-checks**
uses Google's free Fact Check Tools API to look for verdicts already published by
organisations such as Snopes, PolitiFact and Full Fact, shown with the search
results when you press Check sources. Most claims have no published fact-check, so
expect it to be empty more often than not.

**Academic mode**, off by default, biases web searches toward journal, university
and science-agency sources and asks OpenAlex, a free scholarly index that needs no
key, for peer-reviewed articles on each claim you check. The claim is sent to
OpenAlex only when you press Check sources.

AI summaries are optional and off by default. You can use your own Anthropic or
OpenAI key, Chrome's built-in on-device model where available, or a local model
served by Ollama or LM Studio. Brave's Leo assistant exposes no extension API and
cannot be used; the local model option covers Brave.

## Using it

| Action | What happens |
|---|---|
| Extension icon | Opens the side panel; the badge counts flagged claims |
| **Check sources** | Spends one search call, reads the top results' pages, and looks for published fact-checks |
| **Search in browser** | Opens the claim in your default search engine, in a new tab. No key needed |
| **Open the transcript** | On YouTube with subtitles off, opens the video's transcript so it can be read |
| **Check with AI** | Searches, then summarizes the results |
| **Summarize with AI** | Summarizes sources already fetched, no extra search |
| Alt+Shift+N / Alt+Shift+P | Step to the next or previous claim on the page |
| Right-click selected text, **Fact-check selected text** | Adds the selection as a claim, bypassing the classifier |
| Auto-check toggle | Stops all scanning |

## Privacy

There is no server. Your API keys are stored on your device with
`chrome.storage.local` and are sent only to the provider you selected. Page text
leaves your browser only when you press a button that calls one of those
providers. The classifier runs locally, so ordinary browsing text is never
transmitted.

## Development

```bash
npm test
```

- [`docs/architecture.md`](docs/architecture.md) — design and components
- [`docs/testing.md`](docs/testing.md) — automated coverage and manual passes
- [`docs/training-data.md`](docs/training-data.md) — data sources and threshold tuning
- [`classifier/README.md`](classifier/README.md) — the model and how to retrain it
- [`ATTRIBUTION.md`](ATTRIBUTION.md) — required credit for the ClaimBuster dataset

## Licence

MIT, see [`LICENSE`](LICENSE). It covers this project's source code only. The
trained model is a derivative of the CC BY 4.0 ClaimBuster dataset and carries its
own attribution requirements; search results, fact-check records and AI summaries
belong to their providers under those providers' terms.

## Credits

The classifier is trained on the ClaimBuster dataset from the IDIR Lab at the
University of Texas at Arlington, used under CC BY 4.0. Attribution is a licence
condition; see [`ATTRIBUTION.md`](ATTRIBUTION.md) for the citations that must
travel with this project and with any model derived from it.
