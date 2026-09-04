# FactCheck Browser Extension — Architecture & Design Spec

Status: approved for implementation (v1)
Date: 2026-08-29

## 1. Goal

A Chromium-based (Manifest V3) browser extension that watches content a user is
reading or watching and flags sentences worth fact-checking, in real time,
without requiring the user to select text or click anything (though they can
turn this off).

## 2. Core pipeline

```
Page/video text
   -> sentence segmentation
   -> Classifier (NN): check-worthiness score per sentence
   -> threshold filter (skipped entirely if auto-check is toggled off)
   -> flagged claim
   -> Search API: query built from the claim, returns source results
   -> LLM (optional, if user configured a key or enabled built-in browser AI):
      synthesizes/cross-references the search results into a short summary
   -> Side panel feed entry + inline highlight on the page
```

Key point: the NN never judges truth. It only decides *whether a sentence is
worth checking*. Truth-adjacent signal comes from the search results; the LLM
step (optional) just makes those results easier to read — it does not replace
them, and the extension must remain useful with the LLM step entirely absent
(search-only mode).

## 3. Components

### 3.1 Classifier module (sub-project 1, built first)

- A model trained offline (Python) on ClaimBuster-style labeled data
  (sentence -> check-worthiness score), exported to a browser-runnable format
  (TensorFlow.js or ONNX Runtime Web).
- Ships as a small package consumed by the content script: given a batch of
  sentences, returns a check-worthiness score per sentence.
- Runs entirely client-side — no network call for scoring.
- If the model fails to load (fetch error, unsupported browser, etc.), the
  extension falls back to a heuristic trigger (sentences with numbers,
  statistics, or named-entity-like capitalized phrases) so the pipeline still
  functions in a degraded mode.

### 3.2 Content scripts

Two variants, chosen by the background worker based on the page's origin/DOM
shape:

- **Article/text mode** (default, any page): extracts visible text from the
  main content area, segments it into sentences, watches for DOM changes
  (infinite scroll, SPA navigation) and re-scans incrementally rather than
  rescanning the whole page each time.
- **Video mode** (YouTube first): reads the transcript/closed-caption track
  already exposed in the page (YouTube's transcript panel and/or the caption
  cues rendered during playback) instead of requiring audio processing.
  Captions arrive as a timed stream of short text cues, which get grouped into
  sentences before being scored the same way as article text. Other video
  platforms are out of scope for v1; the interface should not assume
  YouTube-only, so a second platform can be added later without touching the
  rest of the pipeline.

Both variants are responsible for two things only: (1) turning
page/video content into scoreable sentences, and (2) drawing inline highlights
(JavaScript + injected CSS classes, color-coded by outcome) around sentences
the background worker reports back as flagged, with a click handler that
scrolls/focuses the matching entry in the side panel.

### 3.3 Background service worker

The orchestrator. A Manifest V3 service worker (JavaScript) that behaves like
a small pipeline script: receives scored sentences from the content script,
applies the user's auto-check toggle and score threshold, and for each
flagged sentence calls the provider adapter layer (search, then optionally
LLM). It also:

- Tracks per-tab state (which claims have been found, their results).
- Updates the toolbar badge count (`chrome.action.setBadgeText`) with the
  number of flagged claims on the current page, adblocker-style.
- Routes results to the side panel for the active tab.
- Applies basic rate limiting/backoff against the configured search and LLM
  APIs so a busy page doesn't burn through quota instantly.

### 3.4 Side panel UI

- A running feed of flagged claims for the current tab: the sentence, its
  search results (title/source/link), and the LLM summary if one was
  produced.
- Auto-check on/off toggle, visible and persistent per the user's global
  setting.
- Clicking a feed entry scrolls the page to and highlights the source
  sentence; clicking a highlighted sentence on the page scrolls the panel to
  its entry.

### 3.5 Toolbar badge / notification

- The extension icon shows a badge count of flagged claims found on the
  current page (same pattern as an ad blocker's blocked-count badge), updated
  by the background worker as claims are found.
- No intrusive popup/notification beyond the badge for v1 — opening the side
  panel is how the user sees detail.

### 3.6 Options page (settings)

- A bundled HTML page registered as the extension's `options_page`, which
  Chromium opens as a normal full browser tab — this gets the "redirected to
  a site to customize your experience" feel you wanted, with no hosting
  required and no data leaving the browser.
- Lets the user: paste/edit their search API key and (optional) LLM API key,
  choose the search provider and LLM provider from the adapter registry
  (including a "use this browser's built-in AI" option where available), set
  the check-worthiness threshold, and toggle auto-check on/off globally.
- Settings are persisted with `chrome.storage.local`, which survives browser
  restarts (this is the correct persistent store for this — plain HTTP cache
  is not durable and isn't the right tool here).

### 3.6b Provider response cache

`src/shared/cache.js`. A time-limited LRU over `chrome.storage.local`, holding the
answers from the only calls that cost money or quota: search, published fact-checks,
OpenAlex and the AI summary. Keyed on everything that would change the answer, so a
different provider, query, mode or model is a different entry. Default limits: a
24-hour life and 200 entries.

It never changes *when* a call happens, only what a repeat click costs. Failures are
not stored, so a rate-limited provider can be retried at once. Entries include claim
text, so the options page carries a switch and a clear button.

### 3.6c Language gate

`src/content/language.js`. The model's vocabulary is English, and on foreign text it
scores erratically rather than failing, so pages that are not English are not
scanned. Two signals: the page's own `lang` attribute, then the share of English
function words in the text, which also catches a template left on the wrong locale.
Every threshold leans towards scanning, because a wrong "not English" disables the
extension silently, which is the worse error. The user's thumbs-up overrides it.

Video captions are judged the same way but from the captions themselves, never from
the page's `lang`: on YouTube that attribute describes the interface, not what is
being said. The first sentences are held until there is enough text to judge, then
released or dropped, and released anyway if a sparse video never provides a sample.

### 3.6d Reading the sources

`src/shared/extract.js`. A search snippet is about 150 characters, usually cut
mid-sentence, and often missing the number the claim turns on, which reads to both
the evidence score and the model as a source that says nothing. On a check the user
asked for, the top two results are fetched and the paragraphs mentioning the claim
are used instead.

The service worker has no DOM, so the parsing is text work rather than a pretend
DOM, and every failure falls back to the snippet. Requests omit credentials, so no
cookies are sent, and carry a timeout, a content-type check and a size cap. The
excerpt is cached rather than the page, since it is small and it is what is used.

Syndication is handled alongside it: the content script reports the canonical link,
the Open Graph URL and any wire credit line in the opening paragraph, and all of
those are excluded from search along with the domain in the address bar. A portal's
copy of a wire story and the wire's own copy are one source, not two.

### 3.6e Dates and figures

`src/shared/dates.js` and `src/shared/numbers.js`, both feeding the evidence score.

Dates: a claim is about a year it names or about the present, and a source is
weighed against that. A page cannot report on a year it predates, and a claim about
now is weakly served by a page years old. Undated sources are never penalised.

Figures: lexical overlap only ever notices agreement, so a source saying 2.1 percent
where the claim says 8.2 percent looked highly relevant and said nothing. Quantities
are now pulled from both, paired by unit and by what they are quantities of, and
disagreements are reported. This is stated as a disagreement between two texts, not
as a verdict: the source may be about another period or another country, or may be
wrong itself.

### 3.6f Video without captions showing

Reading a video whose subtitles are off would ideally mean fetching its caption
track. The track URL is in the watch page and a content script can read it there,
so the obstacle is not the isolated world. The obstacle is the endpoint: it answers
200 with an empty body without a token the player mints, in every format tried.
That was tested against a live video, not assumed, and it is why this is not built.

What works is the transcript YouTube already offers, which the video script reads
whenever it is open. The side panel offers a button that opens it, so the viewer
does not have to find it under "…more". It is their page and their click, one step
further along, and no request goes anywhere YouTube did not send it.

### 3.6g Appearance

`src/shared/appearance.js` turns settings into CSS variables, and `highlight.css`
reads them with fallbacks so a page rendered before the settings arrive still looks
right. Content scripts cannot import modules, so the worker computes the values and
sends them as plain data with every state reply.

Colours are a named list rather than a free picker: the choices stay legible on light
and dark pages and stay distinguishable from one another, which a picker cannot
promise. The styles include one that draws nothing on the page at all, for readers
who want only the side panel.

### 3.6h Which regions of a page count

`src/content/regions.js`. Navigation, newsletter boxes, promos, share bars, players
and recommendation rails are recognised partly by class-name substrings, which works
for a widget and fails badly for a container. Fox News wraps stories in
`<article class="article-wrap has-video">`, so the player rule matched the article
itself: 284 blocks examined, 284 excluded, nothing flagged on any story with a video
in it.

The rule that fixes it needs no per-site knowledge. A region holding at least half
the article's text is the article, whatever it calls itself; furniture is small. Any
size that cannot be measured keeps the old behaviour and excludes, so a named region
is only rescued on positive evidence.

Measured live before and after: Fox went from 0 blocks to 54 of article prose, while
the BBC, the Associated Press, NPR and Wikipedia were unchanged.

### 3.6i Search engines

`src/shared/engines.js`. The Search in browser button hands a claim to an engine the
user already uses, and engines do not read a query the same way, so the query is
shaped per engine rather than one shape going everywhere.

Google and Bing, and Yahoo which is Bing, take two quoted phrases. DuckDuckGo and
Brave both describe their own operators as unreliable or experimental, and measured
against a live search the same claim returned 2 results with two quoted phrases and
5 with one, so they get one. Answer engines such as Perplexity are asked a question
in ordinary words, following their own guidance to write full questions rather than
keyword queries. An unnamed browser default gets the conservative shape that every
engine handles.

A named engine is opened by address; the browser's own default goes through
`chrome.search`, which is the only way to honour a setting an extension cannot read.

### 3.7 Provider adapter layer

Two small interfaces so vendors are swappable without touching the rest of
the extension:

```
SearchProvider.search(query: string) -> SearchResult[]
LLMProvider.crossReference(claim: string, results: SearchResult[]) -> string
```

v1 ships:
- One concrete `SearchProvider` (a generic REST search API adapter — e.g.
  Bing/SerpAPI-shaped — configurable via the options page).
- One concrete `LLMProvider` for user-supplied keys (Anthropic/OpenAI-style
  chat completion adapter).
- One concrete `LLMProvider` for the browser's built-in AI where available
  (Chrome's on-device Prompt API / Gemini Nano, behind a feature-detection
  check — if the API isn't present, this option is hidden in the options
  page rather than erroring).

The LLM step is always optional: if no LLM provider is configured, the side
panel shows raw search results with no summary, and the pipeline still works
end to end.

## 4. Data flow (per flagged sentence)

1. Content script segments new text, batches sentences to the background
   worker.
2. Background worker runs the classifier, filters by threshold (no-op if
   auto-check is off).
3. For each flagged sentence: background worker calls `SearchProvider.search`
   using the sentence text as the query.
4. If an LLM provider is configured, background worker calls
   `LLMProvider.crossReference(sentence, results)` to get a short summary.
5. Background worker stores the claim + results (+ summary) in per-tab state
   and pushes an update to the side panel if open.
6. Background worker tells the content script which sentence to highlight and
   with what status (checked/pending/error).
7. Toolbar badge count is updated.

## 5. Error handling

- No search API key configured: side panel shows a prompt to add one in
  settings instead of silently doing nothing; classifier still runs and
  claims still get flagged/highlighted, just without results.
- Classifier fails to load: fall back to heuristic trigger (see 3.1).
- Search/LLM API call fails or is rate-limited: that claim's entry shows an
  inline error state; the rest of the queue is unaffected.
- Restricted pages (chrome:// pages, PDFs without a content script, etc.):
  extension icon shows a disabled state, no scanning attempted.

## 5a. Reading a page again

`rescanTab` is the single definition of "read this page from nothing", used by the
Rescan button and by the thumbs-up alike. Both sides remember what they have judged,
the content script so it does not ship a sentence twice and the worker so it does
not score it twice, and both memories have to be emptied together.

Anything less produced a bug worth remembering: allowing a site that had been
refused told the page to collect, but every sentence on it was already marked as
seen from the attempt before the rule changed, so nothing was ever shipped and the
thumbs-up appeared to do nothing at all.

## 5b. What is never scanned

One function, `scanPolicy`, decides whether anything may happen for a tab, and every
path that could read, score, store or send a page's text consults it: the automatic
scan, the right-click menu, and a rescan alike. A right-click is an explicit request
and still does not override it, because sending a sentence from a bank statement to a
search API is the exact thing the rules exist to prevent.

URL rules cannot see a form, so a page reporting a password or card field is
remembered as private for as long as the tab stays there, and anything already
collected from it is thrown away. The content script also waits briefly for the
policy answer before its first read, so on a blocked page the text is usually never
read at all rather than read and then discarded.

## 6. Security & privacy

- No backend server for this project. API keys are stored only in
  `chrome.storage.local` on the user's machine and are sent only to the
  provider endpoints the user themselves configured.
- Page content is only sent off-device if a search or LLM call is triggered
  by a flagged claim — the classifier itself runs fully client-side, so
  routine browsing text never leaves the browser.

## 7. Testing strategy

- Classifier: offline evaluation against a held-out split of the training
  data (precision/recall on check-worthiness), plus a unit test for the
  browser-side inference wrapper (given fixed sentences, returns scores in a
  stable range).
- Provider adapters: unit tests against mocked HTTP responses for both
  success and error paths.
- Background worker: integration test for the message-passing chain
  (content script -> background -> side panel) using fixture sentences.
- Content scripts: manual QA on a handful of real news article pages and a
  YouTube video with captions enabled, checking segmentation, highlighting,
  and incremental re-scan on scroll.

## 8. Out of scope for v1 (explicitly deferred)

- Source-credibility annotations (AllSides/Ad Fontes/MBFC-style outlet
  ratings) — a separate, simpler sub-project layered on later.
- Video platforms other than YouTube.
- Brave's built-in AI as an `LLMProvider` — no confirmed extension-facing API
  as of this writing; revisit if Brave publishes one.
- Multi-language sentence segmentation/classification (v1 assumes English).

## 9. Component breakdown for implementation

Each of the following is spec'd as a standalone, agent-ready prompt in
`docs/prompts/`, so each can be built independently against the interfaces
defined above:

1. `01-classifier-training.md` — offline training + export pipeline
2. `02-extension-scaffold.md` — Manifest V3 project skeleton, build tooling
3. `03-content-script-articles.md` — article/text extraction + highlighting
4. `04-content-script-video.md` — YouTube transcript/caption extraction
5. `05-background-service-worker.md` — orchestration, state, badge, rate limiting
6. `06-side-panel-ui.md` — the feed UI + toggle
7. `07-options-settings-ui.md` — settings page, key storage, provider selection
8. `08-provider-adapters.md` — SearchProvider/LLMProvider interfaces + concrete adapters
