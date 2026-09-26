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
| buymeacoffee.com | nothing; an ordinary link opens the page in a new tab | Buy me a coffee (a donation link that unlocks nothing) |

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
- Provider answers in `chrome.storage.local` expire after 24 hours. Expired records
  are deleted at worker startup and at cache writes (at most every ten minutes);
  deletion is delayed while Chrome is closed. Matching cached requests are reused. The cache keys are hashed
  (the stored values are not encrypted). Turning caching off clears the cache;
  the options page also has a clear button.
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

The manifest description (123 characters; the limit is 132) separates the two
halves honestly: the flagging happens as you read, the looking-up only when you ask.

> Spots claims worth double-checking as you read or watch, entirely on your device,
> then finds sources for the ones you pick.

### Store listing: detailed description

Paste this into the dashboard's description field.

```text
Double Check highlights the sentences on a page, or in a YouTube video's captions,
that state something checkable: figures, dates, named claims. Then it helps you
look them up, but only when you ask.

HOW IT WORKS
- A small language model scores every sentence entirely on your own device. Nothing
  is sent anywhere while you read.
- Claims worth checking are marked on the page and listed in a side panel.
- Press a button to look one up: Wikipedia works with no account, or add your own
  SerpAPI or Brave Search key for full web results. Published fact-checks (Google
  Fact Check Tools) and peer-reviewed papers (OpenAlex) are optional.
- Optional AI summaries use your own Anthropic or OpenAI key, Chrome's built-in AI,
  or a model running on your own computer.
- "Search in browser" hands any claim to your usual search engine, no key needed.
- An evidence meter shows how much credible coverage a claim has, and every input
  behind it is listed.
- Cite any source in MLA, APA, Chicago or Harvard and keep a works cited list you
  can export to Word.

PRIVACY
- No account, no ads, no tracking, and no server of ours: your settings, keys and
  history stay in your browser.
- Page text leaves your device only when you press a button, and only to the
  service you chose. Banking, health, email and account pages, and any page with a
  password or card field, are never scanned.

PLEASE READ: DISCLAIMER AND LIABILITY
Nothing Double Check shows you is a statement of fact. A flagged sentence is not a
false one, search results are not verification, and AI summaries can be confidently
wrong. The evidence meter measures coverage, not truth. Always read the sources and
judge for yourself.

Double Check is provided "as is", without warranty of any kind. Its author accepts no
liability for what you find with it, what you conclude from it, decisions you make
on the basis of it, or any loss arising from its use. Third-party services you
connect are governed by their own terms and pricing.

Free and open source (MIT licence). The claim detector is trained on the ClaimBuster
dataset (CC BY 4.0), credited in the extension.
```

## Still outstanding before submission

- **Privacy policy.** Written: `PRIVACY.md`, with the repository's issues page as
  the contact. Publish it at a public address (a GitHub page will do) and paste
  that address into the dashboard's privacy policy field.

## Listing assets

- **Icon:** a bookworm in a bowtie, in `src/icons/` at 16, 32, 48 and 128 pixels and
  named in the manifest. The sources are `docs/icon/bookworm.svg` (32 px and up) and
  `docs/icon/bookworm-16.svg` (drawn separately for the toolbar size).
- **Small promo tile:** `docs/store/promo-tile-440x280.png`, the icon beside the name
  and the manifest's one-line description. The store requires this size.
- **Screenshots:** `docs/store/`, four at 1280 by 800, in the order to upload them.
  They show the real extension; the article, its publication and the search results
  are fictional, and the search and AI answers were mocked in a test browser, so no
  real outlet or person is quoted.

## Building the package

Run `npm run package`. It writes `dist/double-check-<version>.zip` from an explicit
list (the manifest, `LICENSE`, `ATTRIBUTION.md`, `src/` without its tests, the
three classifier files and the model) and checks that every file the manifest, the
pages and the scripts refer to is inside it. Upload that zip, never a zip of the
working folder, which would carry 25 MB of training data, the developer pages, the
docs and every test file.
