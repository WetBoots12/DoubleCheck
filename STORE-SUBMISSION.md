# Chrome Web Store submission notes

What a reviewer will ask, and the answers, drawn from the code rather than from
intention. Everything here is checkable against the repository.

## The short version

There is no backend and no developer-operated server. The extension collects
nothing and its author receives nothing. Scanning, scoring and highlighting run
entirely on the user's machine against a model bundled in the package.

That is not the same as handling no data. The store's User Data Policy covers
collection, use **and transfer**. When the user presses a button, a sentence from
the page they are reading is transferred to a third-party service. That must be
disclosed. It does not have to be apologised for.

## What leaves the machine, and when

Nothing is sent automatically. Every row below happens only on a button press.

| Destination | What is sent | Which button |
|---|---|---|
| en.wikipedia.org | the claim sentence | Add background |
| serpapi.com | the claim sentence | Check sources (key required) |
| api.search.brave.com | the claim sentence | Check sources (key required) |
| factchecktools.googleapis.com | the claim sentence | Check sources (key required) |
| api.openalex.org | the claim sentence | Check sources, academic mode |
| api.anthropic.com | the claim and the search results | Check with AI (key required) |
| api.openai.com | the claim and the search results | Check with AI (key required) |
| the top two result pages | nothing is sent; the page is fetched, cookies omitted | Check sources |
| a local server the user names | the claim and the search results | Check with AI, if configured |
| the user's own search engine | a query shaped from the claim | Search in browser |

## Data disclosure form

Tick **Website content**. A sentence taken from the page the user is reading is
website content, and it is transferred to third parties at the user's direction.

Do not tick personally identifiable information, health information, financial
information, authentication information, personal communications, location, or
web history. None of those is read, stored or sent. Pages likely to contain them
are refused outright: see `src/shared/privacy.js` for the built-in rules covering
banking, health, mail and account domains, local addresses, and any page showing
a password or card field.

Certifications: all three are yes. The data is not sold, is not used or
transferred for any purpose unrelated to the single purpose, and is not used or
transferred to determine creditworthiness or for lending.

## Privacy policy

Required, because the extension transfers website content. A policy needs to say,
at minimum: what is sent, to whom, when, that the author receives none of it,
where API keys live, and what is stored locally.

Points it must cover, all verifiable in the code:

- API keys are held in `chrome.storage.local` and are sent only to the service
  they belong to. There is no server to send them to otherwise.
- Answers from providers are cached in `chrome.storage.local` for one day, so a
  second look at the same claim spends no further call. The cache keys are hashed.
  The user can turn caching off and can clear it from the options page.
- Nothing from an incognito tab is cached.
- Per-tab state lives in `chrome.storage.session` and is gone when the browser
  closes.

## Single purpose

One purpose: flag sentences on a page that state checkable facts, and help the
reader check them.

Everything is in service of that. The search providers find sources for a flagged
sentence. The AI summarises those sources and takes a position on each one. The
browser search hands the sentence to the reader's own search engine. None of them
is a separate product bolted on.

Describe it as a fact-checking aid throughout the listing, never as an AI
assistant, or the AI providers start to look like a second purpose.

## Permission justifications

**storage.** Holds the user's own settings, their never-scan and always-scan
lists, their API keys, and a one-day cache of provider answers so that pressing
the same button twice does not spend the user's quota twice. Per-tab state uses
session storage so it is discarded when the browser closes.

**sidePanel.** The flagged sentences are listed in a side panel next to the page,
which is where the reader acts on them. The panel is the extension's entire user
interface: without it there is nothing to read and no button to press.

**contextMenus.** The classifier misses claims. A single menu item, shown only
when text is selected, lets the reader send a sentence the classifier skipped
through the same path as a flagged one. It appears on selection only and adds
nothing else to the menu.

**search.** The "Search in browser" button hands the claim to whichever search
engine the reader already uses, in a new tab. It needs no API key and costs the
reader nothing, which is why it is the first option offered. `chrome.search` is
the only way to honour a default search engine an extension cannot read.

**Host permission, `<all_urls>`.** Two reasons, and the first is not optional.

The extension reads the article the user is reading in order to score its
sentences locally, and the user does not click anything to start that; they just
read. `activeTab` grants access only after a user gesture, so it cannot do this
job at all.

Second, when the reader presses Check sources, the extension fetches the top two
results' own pages so it can quote the paragraph that actually addresses the
claim rather than a search engine's 150-character snippet, which usually cuts off
the number the claim turns on. Those addresses are chosen by the search provider
at run time and cannot be listed in advance.

Pages that look private are never read. That refusal is enforced in the worker,
in the content script, and again when sentences arrive; the rules are in
`src/shared/privacy.js` and every case is unit-tested.

## Description wording

The current description says the extension "flags check-worthy claims on pages
and videos in real time and cross-references them with search results".

The flagging is real time. The cross-referencing is not: nothing is searched until
the reader presses a button, which is a deliberate promise the extension makes
about cost and privacy. A reviewer who installs it and waits for automatic
cross-referencing has been told something not quite true, so the sentence should
separate the two.

Suggested: "Flags check-worthy claims on pages and videos as you read, entirely on
your own machine, then looks up the ones you choose."

## Still outstanding before submission

- **Icons.** There are none. The dashboard will not accept a submission without a
  128 by 128 icon, and the manifest needs 16, 32, 48 and 128 so the browser has
  something to show in the toolbar and the install dialog.
- **Packaging.** Zipping the working folder would ship about 21 MB of ClaimBuster
  training data and debate transcripts from `classifier/train/raw`, plus the
  developer pages in `tools/` and every `.test.mjs` file. Only `manifest.json`,
  `src/`, `classifier/inference/`, `classifier/model/` and the icons belong in the
  package.
