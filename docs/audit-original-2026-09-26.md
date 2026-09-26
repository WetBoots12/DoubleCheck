I've already mapped the hot paths, so I'll add a performance section to the report. First I'll take a few quick measurements (scratch only, no repo changes) so the suggestions are ranked by evidence rather than guesswork.

# FactCheck Sidebar: bug audit

I found 1 High, 10 Medium and 7 Low actionable findings. I didn't change any code or tests. Every experiment ran from temporary files that I deleted, and `git status` shows only your existing edit to `BUG-AUDIT-PROMPT.md`.

**Baseline:** `npm test` gives **591 pass, 0 fail, 0 skipped**, run on `master` at `df0edcd`.

## High

### H1. Any same-page URL change wipes the tab's claims and leaves highlights that no longer work
- **Location:** `src/content/article/index.js:492-515` (`onPageChanged`) and `:533-539` (URL poll); `src/background/index.js:889-891` (`PAGE_CHANGED`) and `:117-124` (`resetTab`); the highlight filter at `article/index.js:258`.
- **Status:** Confirmed. I observed the trigger in the existing vm test harness; the effect on the page's DOM is traced from the code.
- **Trigger and impact:**
  - The URL poll compares the full `location.href`, which includes the `#fragment`. So a click on a Wikipedia footnote (`#cite_note-5`) or table of contents link, or a site's `replaceState` removing tracking parameters, counts as a new page.
  - The worker then clears the tab: flagged claims and any checked results, fact-checks and AI summaries are all gone.
  - `onPageChanged` never calls `clearHighlights()`, so the old `<span class="fc-highlight">` elements stay in the page with IDs that no longer exist.
  - The page is re-read and the same sentences come back under new IDs. They can't be highlighted, because `textNodesIn` skips text inside existing highlights, so every one is reported as "not on page".
  - Clicking an old highlight, or stepping with Alt+Shift+N, points at claims that no longer exist.
- **Evidence:** After `navigateTo(url + '#cite_note-5')`, the harness recorded `[{"type":"pageChanged","url":"…#cite_note-5"}]`.
- **Suggested fix:**
  - Compare URLs without the fragment on both sides: the content script poll and `tabs.onUpdated`.
  - Have `onPageChanged` call `clearHighlights()` before clearing `sent`.
  - Optionally, treat a query-only `replaceState` as the same page.
- **Regression test:** Can run under the current setup. Extend `navigation.test.mjs` so that a fragment-only change produces no `pageChanged`, and add a unit test that `onPageChanged` removes the highlight spans.
- **Chrome Web Store impact:** None identified.

## Medium

### M1. Fetching a result's own page can reach local and private-network addresses, and the local-address guard does nothing
- **Location:**
  - `src/providers/index.js:205-234` (`fetchPageHtml` checks only the URL scheme and follows redirects).
  - Callers: `readSources` at `background/index.js:531`, `pageMetadata` at `:506`, and `CITE_MATERIAL` at `:1092`.
  - `src/providers/wikirefs.js:109,125-129` accepts any http(s) citation URL.
  - `background/index.js:767` checks `evaluateUrl(url, { privateSitesRule: false })`, but `privacy.js:143` returns "allowed" before the local-address check at `:145` ever runs.
- **Status:** Confirmed from the code. I also ran `evaluateUrl` directly: `http://192.168.1.1/admin`, `http://localhost:8080` and `http://intranet/` all come back `blocked:false` under the flag that guard passes.
- **Trigger and impact:**
  - Anyone can edit a Wikipedia citation to point at `http://192.168.1.1/...`. Search results can also redirect to a private address.
  - Pressing Add background (the default provider, with reading sources on by default) makes the user's browser send a GET request into their LAN, without cookies.
  - The text excerpt from that local page then goes into the AI prompt (Anthropic, OpenAI or a local server) and can land in the works cited list.
- **Suggested fix:** In `fetchPageHtml`, reject hosts that `isLocalHost` would flag. Use `redirect: 'manual'`, or check `res.url` after redirects. Fix the `keepCitedSources` guard to call the local-address check directly.
- **Regression test:** Can run under the current setup. With a stub `fetch`, a result at `http://10.0.0.1/` should never be fetched and never be stored.
- **Chrome Web Store impact:** Weakens the "Host permission" justification in `STORE-SUBMISSION.md`, which says pages are fetched only because a search provider chose them.

### M2. Reading a fetched page takes quadratic time, so one bad page can freeze the whole service worker
- **Location:** `src/shared/extract.js:17` (`CHROME_TAGS`), `:22` (`BLOCK`), `:76-79`. Input is capped at 2 MB (`PAGE_MAX_BYTES`).
- **Status:** Confirmed by measurement.
  - Unclosed `<nav>` tags: 98 KB took 364 ms, 195 KB took 1.45 s, 391 KB took 7.4 s.
  - Unclosed `<p>` tags: 313 KB took 2.3 s.
  - Extrapolating to the 2 MB cap gives roughly 3 minutes of blocking work.
- **Trigger and impact:** A top-2 result (for example a Wikipedia citation anyone can add) serves HTML full of unclosed tags. The single worker thread blocks, so every button, `GET_STATE` and panel update stalls. `dates.js:130-151` already fixed this exact class of problem (bounded patterns plus a 200 KB slice), but `extract.js` never got the same treatment.
- **Suggested fix:** Slice the input (for example to 400 KB). Replace the lazy `[\s\S]*?<\/\1>` patterns with a linear scan: `indexOf` for the closing tag starting from the opening tag, skipping ahead when it isn't found.
- **Regression test:** Can run under the current setup. Assert that 400 KB of `'<nav>'` repeated parses in under 200 ms.
- **Chrome Web Store impact:** None identified.

### M3. Incognito: the citation paths write to the disk cache
- **Location:** `background/index.js:1006-1010` (`CITE_SOURCES`) and `:1075-1108` (`CITE_MATERIAL`). Both use raw `getSettings()`; only `requestCheck` (`:367-369`) turns caching off for incognito tabs.
- **Status:** Confirmed by experiment. Citing from an incognito tab wrote `meta|["https://apnews.com/a"]` to `chrome.storage.local`. `CITE_MATERIAL` also stores `pagetext` and `citesearch` entries, where the search entry holds the page's title.
- **Impact:** The URLs and titles of pages researched in incognito stay on disk for a day or longer (see M9). This contradicts `STORE-SUBMISSION.md:63`, "Nothing from an incognito tab is cached."
- **Suggested fix:** One helper, `settingsForTab(tabId)`, that forces `cacheResults:false` for incognito tabs, used by every handler that calls `remember`.
- **Regression test:** Can run under the current setup. Add to `citation.test.mjs`: after an incognito cite, there are no `fccache:` keys. The existing incognito test only checks the sources list.
- **Chrome Web Store impact:** The privacy statement becomes inaccurate, which is a User Data Policy disclosure mismatch.

### M4. Saving the options page silently undoes thumbs-up/down rules set in the side panel
- **Location:** `src/options/options.js:166-200` writes back its `blockedDomains` and `allowedDomains` text boxes as they were when the page loaded. The save queue in `messages.js:460` only serializes saves within one JavaScript context, even though the comment at `:450-459` says it fixes the options-page/side-panel conflict.
- **Status:** Confirmed by experiment. After a thumbs-down, the blocked list was `['myclinic-notes.example']`; after pressing Save on an already-open options page, it was `[]`.
- **Impact:** A never-scan rule the user just set is silently dropped, and that site gets scanned again. This is a privacy regression.
- **Suggested fix:** Listen for `storage.onChanged` on the options page and refresh the lists. Better still, save only the fields the user actually edited.
- **Regression test:** Can run under the current setup, as the experiment did with a stub `chrome.storage`.
- **Chrome Web Store impact:** None identified.

### M5. An on-device AI summary is applied to whichever tab is active when it finishes; the original claim stays stuck on "Asking the AI…"
- **Location:** `background/index.js:946-960` (`LLM_RESULT` looks up the tab with `activeTabId()`), `:414-430`, and `panel.js:867-895`.
- **Status:** Confirmed by experiment. After a tab switch, the original claim had `summarizing = true` and `analysis = null`.
- **Impact:** Gemini Nano writes at reading speed, so switching tabs while it works is normal. The summary is thrown away, and that claim shows no buttons until the panel is reopened.
- **Suggested fix:** Include `tabId` in `LLM_REQUEST`, echo it back in `LLM_RESULT`, and use it instead of the active tab.
- **Regression test:** Can run under the current worker harness.
- **Chrome Web Store impact:** None identified.

### M6. Provider calls have no timeout, so three hung calls stall checks on every tab
- **Location:** `src/providers/index.js:29-40` (`fetchJson` has no abort signal); the queue is shared across tabs with 3 slots (`background/index.js:81`).
- **Status:** Confirmed that the queue starves: with 3 never-settling jobs in the queue, a job for another tab never ran (`pending: 1, running: 3`). That a provider can hang (a slow local model, a stalled network) is inference.
- **Impact:** Claims sit on "checking…" until Chrome kills the worker.
- **Suggested fix:** An `AbortController` timeout in `fetchJson`, for example 20 s for search and 90 s for AI, mapped to a readable per-claim error.
- **Regression test:** Can run under the current setup, with fake timers.
- **Chrome Web Store impact:** None identified.

### M7. A published fact-check about a different claim decides the verdict
- **Location:** `src/shared/evidence.js:247-257` (the first fact-check with a recognisable rating overrides everything, with no check that it's about the same claim). The fallback in `providers/index.js:428-432` retries with 8 keywords, which makes loose matches more likely.
- **Status:** Confirmed by experiment. A claim about 3.5 percent unemployment, with a relevant BLS source and an unrelated "False" fact-check about vaccines, gave `verdict: not_supported, position: 8`, displayed as "Not supported by sources."
- **Impact:** The thermometer reads as a truth verdict for the wrong claim, which goes against product invariant #4 (scores are research signals, not truth verdicts).
- **Suggested fix:** Require the fact-check's own `claim` text to overlap the user's claim (`relevance(claim, f.claim) >= 0.3`, say) before it can set the verdict. Otherwise just list it.
- **Regression test:** Can run under the current setup.
- **Chrome Web Store impact:** None identified.

### M8. Video markers jump to the moment a claim was flagged, not when it was said
- **Location:** `background/index.js:276-283` (`pushHighlights` sends `id, text, status, band` but not `ts`); `video/index.js:326-333` (falls back to `now()`); `seekTo` at `:267-274`.
- **Status:** Confirmed by experiment. The stored claim had `ts: 1234`, but the highlight message had no `ts`.
- **Impact:** Claims read from the transcript all get the current playback time, so clicking a marker, pressing next/previous, or focusing a claim from the panel seeks to the wrong place. `docs/testing.md` promises timestamps taken from the transcript.
- **Suggested fix:** Include `ts` in the `pushHighlights` payload, and prefer it in the video script.
- **Regression test:** Can run under the current worker harness.
- **Chrome Web Store impact:** None identified.

### M9. Cached answers stay on disk well past the stated one day
- **Location:** `src/shared/cache.js`. Expired entries are only deleted when that exact entry is read again (`:253-256`) or when more than 200 entries push it out. Nothing sweeps them.
- **Status:** Confirmed by experiment. After a simulated 30 days, the entry was still in storage along with the claim text.
- **Impact:** Claim text, AI summaries and page excerpts can persist indefinitely. The README and `STORE-SUBMISSION.md:60` both say one day.
- **Suggested fix:** Sweep expired entries on worker startup and before each write to the index.
- **Regression test:** Can run under the current setup.
- **Chrome Web Store impact:** The disclosed retention period is inaccurate.

### M10. The wire-service exclusion is lost whenever the service worker restarts
- **Location:** `background/index.js:471` (`publishers` is an in-memory `Map`); `article/index.js:188-196` only re-reports when the list changes.
- **Status:** Confirmed from the code. Chrome suspends the worker after about 30 s idle, which is routine while someone reads.
- **Impact:**
  - After a restart, the page's canonical site, Open Graph site and wire service are no longer excluded from the search. A Reuters copy of the article can then come back as "corroboration" of itself.
  - The search cache key includes the exclusion list, so a claim marked "No call will be made" before the restart spends a paid call afterwards.
- **Suggested fix:** Keep `publishers` in `storage.session`, next to the private-tab markers.
- **Regression test:** Can run under the current harness: simulate a restart by re-importing the module.
- **Chrome Web Store impact:** None identified.

## Low

- **L1. The "No call will be made" note can be wrong** (`panel.js:443-448`, `index.js:567-579`). It only checks the search cache, but it sits next to Check with AI, which can still make a paid AI call. It also ignores uncached fact-check lookups. Confirmed from the code. Fix: word it as "no search call", or check every cache key the press would use.
- **L2. The panel's keyboard handler takes over Enter and the arrow keys everywhere except text fields** (`panel.js:924-931`). Enter on a focused button or source link steps to the next claim instead of activating it, and the arrow keys can't change the citation-style dropdown. Confirmed from the code; the effect needs a browser to observe. Fix: also exclude `button, a, select, [contenteditable]`.
- **L3. Side panels open in two windows show each other's claims** (`index.js:236-239` resolves "active tab in the current window"; `panel.js:933-948` renders every broadcast; `LLM_REQUEST` would run in both panels). Likely; browser-only. Fix: each panel records its own window ID and ignores messages for other windows' tabs.
- **L4. The right-click menu probably can't open the panel** (`index.js:691,719`). `sidePanel.open` runs after several `await`s, which likely loses the user gesture Chrome requires. The claim is still added, but nothing visibly happens. Browser-only. Fix: call `sidePanel.open` synchronously at the top of the `onClicked` handler.
- **L5. The worker never checks who sent a message** (`index.js:774`). Content scripts can send the panel-only messages: `SITE_RULE`, `CLEAR_SOURCES`, `CHECK_CLAIM` (spends quota), and `LLM_RESULT` (injects a summary). Web pages can't reach these, so this only matters if a renderer is compromised; it's defence in depth. Fix: reject those message types when `sender.tab` is set.
- **L6. The page can be read before the privacy answer arrives** (`article/index.js:36,562-573`). The mutation observer can trigger `collect()` before the first `GET_STATE` reply, and after an SPA navigation before the 1 s poll notices it. The worker still refuses to score or store the sentences, so nothing is sent anywhere, but the "the page is usually never read" promise is weaker than documented.
- **L7. Documentation is out of date.**
  - `docs/architecture.md` §3.3/§4 describe an automatic search per flagged claim; the code only searches on a button press.
  - §5's "disabled icon on restricted pages" isn't implemented.
  - `docs/testing.md` says the worker and content scripts have no automated tests, and that two tests skip. Both are wrong now.
  - Turning caching off doesn't empty it, although `cache.js:290-293` says it does.
  - Missing icons and the manifest description are already listed under "Still outstanding" in `STORE-SUBMISSION.md`.

**Suspicions I couldn't prove:**
- `recoverStale` calls `cache.clear()` at worker startup, which could race with the first message and lose a save.
- `storage.session` could hit its 10 MB quota with many long infinite-scroll tabs (3,000 remembered sentences per tab).
- A hidden login-modal password field anywhere in the page marks the whole article as private.

**Reviewed, nothing actionable:**
- Rendering in the panel and options pages: every `innerHTML` sink only receives values the worker controls, and links go through `httpUrl`.
- Searches only happen on a button press.
- API keys are sent only to their own providers.
- The manifest's content scripts are classic scripts and none of them use `import`.
- The minimum Chrome version (116) covers every API used.
- The regular expressions in `dates.js` and `metadata.js` are bounded.

## Speed improvements (your mid-audit question)

I measured first. The classifier is not a bottleneck: parsing the model takes 3 ms and scoring 200 sentences takes 5.4 ms. The real costs are on the page's own main thread and in the network. None of these changes loses any functionality:

1. **Match all of a batch's claims in one pass** (`article/index.js:291-320`). For every claim, `highlight()` recomputes `contentRoot()`, re-walks every text node and rebuilds the page text character by character. Measured: 20 claims on a 200 KB page took **298 ms of pure string work**, before counting DOM layout. Instead, build the node list and flattened text once per `CLAIM_STATUS` message, find every claim's position, then wrap them from the end of the document backwards. This is the biggest scroll-jank win.
2. **Don't re-read paragraphs that haven't changed** (`visibleParagraphs`, `:124-142`). Every scan re-runs `innerText` on each paragraph (which forces layout), checks the 40-selector exclusion list on every ancestor, and runs a subtree `querySelector` per element. Two cheap changes:
   - A `WeakMap` from element to last text read, so unchanged blocks are skipped.
   - A per-scan cache of which ancestors are excluded.
3. **No layout in the mutation callback** (`:564-569`). `inExcludedRegion` reads `innerText` on every mutation batch. Use `textContent` length there; triage only needs a rough size.
4. **Fetch each result page once, not twice.** `readSources` and `pageMetadata` fetch the same top-2 pages separately. With `autoCitationData` on, those pages are downloaded twice, and "Cite this source" re-downloads a page the check already read, with a timeout of up to 6 s. Compute `metadataFromHtml` inside `readSources` and store it under the `meta` key, so citing a top-2 result becomes instant and free.
5. **Keep settings in memory in the worker.** `getSettings()` does a storage read on nearly every message. Cache it and refresh on `storage.onChanged`.
6. **Filter the panel's storage listener** (`panel.js:1027`). It fires on every `storage.session` write, meaning every tab-state save. Check `area === 'local' && changes.fc_settings` first.
7. **Bounded parsing in `extract.js`** (M2): fixing the freeze also speeds up ordinary pages.

## Summary

| ID | Severity | Title | Status |
|---|---|---|---|
| H1 | High | Same-page URL change wipes claims and leaves broken highlights | Confirmed |
| M1 | Medium | Result pages fetched from private-network addresses; local guard does nothing | Confirmed |
| M2 | Medium | Quadratic page reading freezes the worker | Measured |
| M3 | Medium | Incognito citations written to the disk cache | Confirmed |
| M4 | Medium | Options Save erases rules set from the panel | Confirmed |
| M5 | Medium | On-device AI result goes to the wrong tab; claim stuck | Confirmed |
| M6 | Medium | No provider timeout; all tabs' checks stall | Confirmed |
| M7 | Medium | Unrelated fact-check sets the verdict | Confirmed |
| M8 | Medium | Video markers use flag time, not when it was said | Confirmed |
| M9 | Medium | Cache kept far past one day | Confirmed |
| M10 | Medium | Wire-service exclusion lost on worker restart | Confirmed (code) |
| L1–L7 | Low | Note wording, keyboard, multi-window, panel open, sender checks, early read, docs | Mixed |

## Checks that still need a real Chrome run

Load it via `chrome://extensions` → Developer mode → Load unpacked. Watch the service worker's console through the "service worker" link on the extension card, and the page's content-script errors in the page's DevTools.

1. **H1:** On a Wikipedia article, check a claim, then click a footnote. Expected: the claims, results and highlights all survive.
2. **L4:** Right-click a selection → Fact-check the highlighted text with the panel closed. Expected: the panel opens.
3. **L3:** Open side panels in two windows and switch tabs in each. Expected: each panel only shows its own window.
4. **M5:** With built-in AI selected, press Check with AI and switch tabs straight away, then switch back. Expected: the summary is there.
5. **M8:** On YouTube, open the transcript and click an overlay marker. Expected: it seeks to that line.
6. **Worker restart:** On `chrome://serviceworker-internals`, press Stop, then press Check sources. Expected: it works, and the wire-service exclusion still applies.
7. **L2:** Tab to Check sources and press Enter. Expected: the button activates.

## Limitations

- No real Chrome profile was loaded, so every browser-only item is unverified.
- No live provider calls were made.
- The Web Store impacts are based on reading the code, not on an actual review.

If you want, I can turn this into a shareable page, or start fixing the findings, beginning with H1 and M1–M4.