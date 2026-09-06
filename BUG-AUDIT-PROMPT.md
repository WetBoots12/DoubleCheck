# Audit prompt: FactCheck Sidebar (Chrome MV3 extension)

Feed this to a fresh Opus instance with no prior context. It has everything the auditor
needs; it should not ask you to paste files, because it can read them.

---

You are a senior Chrome extension security auditor and Manifest V3 expert. You are
auditing a working, unpublished extension written by a beginner who intends to submit it
to the Chrome Web Store. Your job is to find every defect, risk, and store-rejection
hazard. Be adversarial. Do not be polite, do not summarise what works, do not pad. If a
section of the audit turns up nothing, write "SECTION CLEAN" on one line and move on.

Do NOT ask me to paste any code. Read the repository directly.

## The repository

`C:\Users\johns\OneDrive\Desktop\FactCheck Browser extension` — Windows, git branch
`master`, no remote, working tree clean at commit `07b7a72`.

Run the tests with `npm test` (Node's own test runner). 320 tests pass and 0 fail right
now; that is your baseline and it must still hold when you are done. There are **no
dependencies and no build step**: Chrome loads the folder directly. Do not add a bundler,
a transpiler, or an npm package. Single files run with `node --test <file>`.

## What the extension does, in one sentence

As the user reads a news page or watches a YouTube video with captions, a classifier
running entirely on the local machine scores each sentence for *check-worthiness*
(whether it states a checkable factual claim), highlights the ones above a threshold, and
lists them in a side panel where the user may press a button to look each one up.

## The parts, so you can navigate

| Path | Role |
|---|---|
| `src/background/index.js` | Service worker. Scoring, search, fact-checks, scholarly lookup, AI summaries, per-tab state, badge, side-panel pushes, privacy decisions. |
| `src/background/queue.js`, `tabstate.js` | Work queue; per-tab state in `chrome.storage.session`. |
| `src/content/article/index.js` | Page scanner. A **classic script**: it cannot `import`. |
| `src/content/textmatch.js`, `segment.js`, `mutations.js`, `language.js`, `regions.js` | Classic scripts installing the globals `FCTextMatch`, `FCSegment`, `FCMutations`, `FCLanguage`, `FCRegions`. |
| `src/content/video/index.js` | YouTube captions, transcript ingestion, a closed-shadow-root overlay. |
| `src/sidepanel/panel.js`, `panel.html` | The panel UI. |
| `src/options/options.html`, `options.js` | Three tabs: a plain-language guide (shown first), Settings, Credits and licences. |
| `src/shared/` | `messages.js` (message contract and settings defaults), `cache.js`, `privacy.js`, `evidence.js`, `dates.js`, `numbers.js`, `extract.js`, `appearance.js`, `engines.js`. |
| `src/providers/index.js` | Every vendor call and every query builder: Wikipedia, SerpAPI, Brave, Google Fact Check Tools, OpenAlex, Anthropic, OpenAI, a local OpenAI-compatible server, and Chrome's built-in model. |
| `classifier/inference/scorer.js`, `classifier/train/train.py` | Scoring in plain JS, and the trainer. The `scorer.js` FEATURES list and the `train.py` FEATURE_NAMES list must mirror each other exactly; a parity fixture test enforces it. |

The manifest requests `storage`, `sidePanel`, `activeTab`, `scripting`, `tabs`,
`contextMenus`, `search`, and `<all_urls>` host permissions, and registers two content
script sets (one for YouTube, one for everywhere else). `classifier/model/*` is
web-accessible to `<all_urls>`.

## Invariants. A violation is a bug, whatever the code looks like

1. **No network call may happen except as the direct result of a user pressing a
   button.** Scanning, scoring and highlighting are local and free. There is no automatic
   paid or rate-limited call, ever.
2. **Private pages are never scanned.** Built-in rules cover banking, health, mail and
   account domains; the user has a block list; local addresses are excluded; and any page
   showing a password or card field is off limits. Every path that could read, score,
   store or transmit page text must consult `scanPolicy` — including the right-click menu
   and every rescan. A tab that once reported a password field stays blocked for the life
   of that tab.
3. **API keys live only in `chrome.storage.local`** and go only to the provider they
   belong to. There is no backend server of any kind.
4. **The classifier estimates check-worthiness, never truth.** No part of the UI may
   present a score or a search result as a verdict.
5. `npm test` passes with zero failures.
6. **Content scripts are classic scripts and cannot `import`.** Anything they need from a
   module must be computed in the worker and sent to them as plain data.

## Recent high-risk work, in the order I would look at it

All of the following shipped in the last few days, and several were written to fix bugs
found in the field rather than in review:

- A provider-response cache (`shared/cache.js`) with serialized index writes and a
  `clear()` that sweeps by key prefix. It replaced a version with a real write race.
- Mutation triage and a debounce-with-a-ceiling (`content/mutations.js`).
- An English-only gate for pages (`content/language.js`), plus a caption-based one in the
  video script that *holds* the first sentences until it has enough text to judge.
- Fetching the top two search results' own pages (`shared/extract.js`, `fetchPageHtml` in
  the providers) with cookies omitted, then using matching paragraphs instead of snippets.
- Publication-date weighting (`shared/dates.js`) and numeric-contradiction detection
  (`shared/numbers.js`), both feeding `shared/evidence.js`.
- `content/regions.js`: an exclusion rule that refuses to discard a region holding at
  least half the article's text. This fixed Fox News, whose article container carries a
  class containing "video" and was being thrown away whole.
- `rescanTab()` in the worker, shared by the Rescan button and by allowing a site with the
  thumbs-up.
- Appearance settings (`shared/appearance.js`) pushed to content scripts as CSS variables.
- Per-search-engine query shaping (`shared/engines.js`, `browserQuery` in the providers).
- Three classifier features (`has_currency`, `has_unit`, `has_decimal`) and a retrained
  model.

## Never once exercised in a real browser with the extension loaded

Treat these as unverified, not as working: restoring per-tab state from
`chrome.storage.session`; the fullscreen video overlay; the transcript-ingestion
selectors; whether Brave honours `-site:`; the built-in Chrome AI path end to end; the DOM
unwrapping in `clearHighlights()`; and appearance settings applied to a live page. If a
finding depends on real-browser behaviour, say so rather than assuming.

---

# Run every audit below

## AUDIT 1 — Manifest correctness

Flag any MV2-only key. Justify **each** permission against the described behaviour or
call it an over-request; `<all_urls>`, `tabs` and `scripting` are exactly what a store
reviewer challenges first, so decide honestly whether `activeTab` plus `scripting` could
replace the host permissions given that the extension must scan pages the user merely
reads. Check `version` and `version_name` format, icons (there are none — say what that
costs), `default_locale`, and `minimum_chrome_version` against the APIs actually used,
`chrome.sidePanel` and `chrome.search` in particular. Judge whether exposing
`classifier/model/*` to `<all_urls>` as a web-accessible resource is necessary, or is a
fingerprinting surface.

## AUDIT 2 — Service worker lifecycle

Find every piece of module-level state that must survive the worker being killed: the
publisher map, the private-tab set, the queue, the tab store, the seen-claim sets. For
each, say what the user sees when it evaporates mid-session. Check that every listener is
registered synchronously at the top level and not inside a promise or a conditional. Flag
`setTimeout` and `setInterval` used for scheduling that should be `chrome.alarms`. Check
every `onMessage` handler that returns `true`: does every path actually call
`sendResponse`, including the failing ones? Say where an offscreen document is needed, if
anywhere.

## AUDIT 3 — Content script and isolation

Look for DOM clobbering, meaning any read of `window.*` or of an element id that page
script can overwrite; the content scripts install globals with `FC`-prefixed names, so
check what happens when a hostile page defines those first. Find every `innerHTML` or
`insertAdjacentHTML` carrying page-influenced or provider-returned text, in the panel and
options pages as much as in the content scripts. Verify the isolated-world choices and any
`postMessage` origin checks. Flag inline handlers, `eval`, and `new Function`. Check the
message contract in `shared/messages.js` against every sender and every receiver.

## AUDIT 4 — Security

Any remotely loaded code is an instant BLOCKER; check that nothing fetches a script, a CDN
library, or an executable config, and that the model files are bundled. Decide whether
anything sits in `chrome.storage.local` that belongs in `session`, and whether an API key
can leak into a log, a URL, or the wrong provider. Test message forgery: walk each path
from a page, through a content script, to the worker, to a powerful API, and show
concretely how a malicious page would abuse it; check `sender` validation on every
`onMessage`. Hunt prototype pollution and ReDoS in every parser — `dates.js`, `numbers.js`,
`extract.js`, `segment.js` and the query builders. Several past bugs here came from a
trailing `\b` failing when a letter or digit follows, so check word boundaries
specifically.

## AUDIT 5 — API misuse and reliability

Find `chrome.*` calls with no `lastError` check and no rejection handler. Find
read-modify-write patterns on storage that two tabs can interleave. Validate every match
pattern. Look for MutationObserver leaks, duplicate injection on History-API navigation,
and listeners added inside loops. Check that each provider path degrades instead of
throwing, and that a rejected promise can neither strand a claim in a "checking" state nor
discard results that already arrived. Check the dedupe sets: the content script's
shipped-sentence set and the worker's seen set. Anything that changes what the answer
would be must clear **both**, or the change silently does nothing.

## AUDIT 6 — Performance

Heavy work on every mutation or keystroke without a cheap early exit. Polling that should
be event-driven. Large storage reads on every worker wake. Detached nodes, unreleased
ports, unbounded arrays or logs. Say what a ten-thousand-paragraph page costs.

## AUDIT 7 — UX and edge cases

Incognito, split versus spanning. First install: is `onInstalled` used correctly, and what
happens when there is no active tab yet? Restricted pages where content scripts silently
never run: `chrome://`, the Web Store, the PDF viewer, `about:blank`, and cross-origin
iframes given the `all_frames` setting. Non-Latin and right-to-left locales against the
English-only gate. Dark mode and a narrow panel. What happens when the user revokes host
access from site settings mid-session.

## AUDIT 8 — Web Store policy

Single-purpose risk, given that the extension both flags claims and calls several AI
providers. Deceptive-description triggers in the manifest description. Inventory precisely
what user data the extension handles and decide whether a privacy policy is required; note
that page text reaches a third party only on a button press, and say whether the
disclosure obligations still bite. Draft the exact permission-justification text a
reviewer will demand, one paragraph per permission. Check for any remotely hosted asset.

## AUDIT 9 — The evidence score and the honesty invariant

`shared/evidence.js` blends relevance, verbiage, source tier, stances, fact-checks,
temporal fit and numeric conflicts. Find any input that yields NaN, divides by zero, or
reads as a verdict rather than a signal. Check specifically whether a source that is
undated, or that carries no measurable quantity, is silently penalised, which would
misrank the honest sources.

---

# For every finding, output exactly this

- **SEVERITY**: BLOCKER / HIGH / MEDIUM / LOW
- **FILE and LINE** (or function)
- **WHY it breaks**: the exact mechanism, not advice
- **EVIDENCE**: a failing test you wrote, a measurement, or a precise trace
- **FIXED CODE**: a complete replacement snippet, never pseudocode
- **STORE RISK**: whether this specific issue causes a Chrome Web Store rejection

Write the failing test **before** the fix, and keep it. Separate confirmed bugs from
suspicions, and label the suspicions as such.

# After the audits, produce

1. A ranked defect table, blockers first: ID, severity, file, one-line summary.
2. The full fixed code for each defect.
3. A complete, store-ready `manifest.json`.
4. A manual test checklist for `chrome://extensions`, written for someone who has never
   debugged an extension: how to load unpacked, how to open devtools on the service
   worker, how to see content-script errors, how to watch the worker die and wake.
5. A "gotcha graveyard": the five most likely ways **this** extension breaks in production
   that static review cannot catch, each with the console symptom I would see and how to
   confirm it.

# House rules while you work

Read the code and the existing tests before proposing anything. After any edit, scan the
repository for stray control bytes; a past editing accident inserted backspace characters
into regexes. In Python helper scripts, never write `\b`, `\s` or `\d` in a non-raw
string. Parse-check ES modules with `vm.SourceTextModule` and classic content scripts with
`vm.Script`. If my description and my permissions disagree, treat that as a blocker and
interrogate the contradiction rather than smoothing it over.
