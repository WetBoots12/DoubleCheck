# Double Check privacy policy

**Effective date: 26 September 2026**

Double Check is a browser extension that highlights sentences worth checking on the
pages you read and the videos you watch, and helps you look them up when you choose
to. This policy explains what the extension does with information, in plain terms.

## The short version

- **There is no Double Check server.** The author does not receive, collect, store or
  see anything you read, check, type or configure. There are no accounts, no ads, no
  analytics and no tracking.
- **Reading and scoring happen on your device.** Page text is scored by a model
  bundled with the extension and is not sent anywhere while you read.
- **Text leaves your device only when you press a button,** and only to the service
  that button uses, which is one you chose.
- **Nothing is sold, shared for advertising, or used for anything other than the
  extension's single purpose:** helping you check claims.

## What is processed on your device

While you browse, the extension reads the text of the page (or a YouTube video's
captions and transcript) and scores each sentence locally for whether it looks like a
checkable claim. This happens entirely inside your browser.

Some pages are never read at all:

- pages that look private: banking, payments, health portals, email and messaging,
  government accounts, password managers, cloud documents, login, checkout and
  account pages, and local or private network addresses;
- any page showing a password or card field, whatever its address;
- sites you set to "Never" under "Scan this site", or list under "Never scan these
  sites" in Settings.

You can switch scanning off entirely with the "Scan pages" switch.

## What is stored, where, and for how long

Everything the extension stores stays in your browser's own extension storage on your
computer. None of it is synced to an account or sent to the author.

| What | Where | How long |
|---|---|---|
| Your settings, including any API keys you enter | `chrome.storage.local` | Until you change them or remove the extension. Keys are stored as you enter them (not encrypted) and are sent only to the service they belong to. |
| Remembered answers: search results, fact-check results, AI summaries and short excerpts of source pages, together with the claim text they answer | `chrome.storage.local` | They expire after 24 hours and are deleted when the extension next starts or writes to the cache (at most every ten minutes). You can turn this off, which deletes them, or clear them at any time in Settings. |
| Your works cited list: titles, addresses, authors and dates of sources you chose to keep or cite | `chrome.storage.local` | Until you remove entries or clear the list. |
| The claims found on each open tab | `chrome.storage.session` | Until the tab closes or the browser closes. |
| Your theme choice (System, Light or Dark) | the extension's own `localStorage` | Until you change it. |

**Incognito:** if you allow the extension in incognito windows, nothing from an
incognito tab is added to the remembered answers or the works cited list.

## When information leaves your device

Only when you press a button, and only to the service named below. Each of those
services has its own privacy policy and terms, which apply to what you send it.

| When you press | What is sent | To |
|---|---|---|
| **Add background** (the default, no key needed) | The claim, or its key words | Wikipedia (Wikimedia Foundation) |
| **Check sources** (with your own key) | The claim, or a shortened search query | The search service you chose: SerpAPI or Brave Search |
| **Check sources**, with the optional fact-check lookup on | The claim, or its key words | Google Fact Check Tools |
| **Check sources**, with academic mode on | The claim's key words | OpenAlex |
| **Add background** or **Check sources**, with "Read the top results' pages" on (the default) | Nothing is sent: the top one or two result pages are fetched, without cookies or login details, so the paragraph that bears on the claim can be read | The websites of those results |
| **Check with AI**, **Summarize with AI** | The claim and the search results found for it | The AI service you chose: Anthropic, OpenAI, a model on your own computer, or Chrome's built-in model (which runs on your device) |
| **Cite this source**, **Cite all sources** | Nothing is sent: the source's page is fetched, without cookies, to read its author, title and date | The website of that source |
| **Complete with AI** (for an incomplete citation) | The source's details and a short extract of its page, and possibly one search for the source's title | The AI service you chose, and your search service if you set one up |
| **Search in browser** | A search query made from the claim | Your own search engine, opened in a new tab |
| **Buy me a coffee** | Nothing: an ordinary link | buymeacoffee.com opens in a new tab |

Nothing in the table happens on its own.

Two things happen without a button press, and neither sends anything to anyone new:

- **YouTube transcripts.** With "Open a YouTube video's transcript automatically" on
  (the default), the extension opens YouTube's own transcript panel on a video that
  has one, exactly as if you had clicked "Show transcript". YouTube then loads the
  transcript from its own servers, as it would for you. The extension sends nothing.
  You can switch this off in Settings.
- **Chrome's built-in AI.** If you choose Chrome's built-in model, Chrome itself may
  download and manage that model. The extension sends it nothing outside your device;
  the model runs locally.

## What the extension never does

- It never sends page text, claims or anything else to the author or to any server
  the author runs. There is none.
- It never reads your browsing history, bookmarks or cookies.
- It checks whether a page has a password or card field only so that it can skip that
  page. It never reads what is typed into any field.
- It never sells or transfers data to anyone for advertising, credit or any purpose
  other than what you asked for.
- It never uses your data to build a profile of you.

## Permissions, and why they are needed

- **Access to the pages you visit (`<all_urls>`):** to read the page you are on and
  score its sentences locally as you read, and to fetch a search result's page when
  you press Check sources or Cite.
- **storage:** your settings, the remembered answers, your works cited list and the
  claims on open tabs, all on your device.
- **sidePanel:** the side panel is where claims are listed.
- **contextMenus:** the "Double-check the highlighted text" item in the right-click
  menu, shown only when text is selected.
- **search:** "Search in browser" hands a query to your own default search engine.

## Limited Use

The use of information received from Chrome APIs adheres to the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq),
including the Limited Use requirements.

## Children

Double Check is not directed at children under 13 and does not knowingly collect
information from anyone, of any age.

## Changes

If this policy changes, the new version will be published at this address with a new
effective date. A change that affects what leaves your device will also be described
in the extension's release notes.

## Contact

Questions about this policy: [github.com/WetBoots12/DoubleCheck/issues](https://github.com/WetBoots12/DoubleCheck/issues).
