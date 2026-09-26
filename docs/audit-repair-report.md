# Audit repair report — 2026-09-26

Implementation batch complete, reviewed, and validated in real Chrome where the
environment allowed. All changes remain uncommitted in the existing working tree.
No production provider calls were made.

## Second pass: review and real-Chrome validation

Final state: `npm test` — **628 passed, 0 failed, 0 skipped** (about 10.6 s). Changed
JavaScript passes `node --check`; `git diff --check` is clean apart from Git's LF/CRLF
advisory.

### How Chrome was driven

Chrome 153 (stable, the installed build) in a throwaway profile under the session
scratch directory, controlled over `--remote-debugging-pipe`. Branded Chrome ignores
`--load-extension` since version 137, so the unpacked folder was loaded with the
DevTools `Extensions.loadUnpacked` command (`--enable-unsafe-extension-debugging`).
Test pages were served from 127.0.0.1, added to the test profile's always-scan list.
Every request the service worker made was intercepted: Wikipedia answers were mocked
and anything else was refused, so no provider, paid or free, was contacted from the
worker. The side panel was opened from an extension page with a simulated user
activation; the context menu was exercised with a real native right-click.

### Defects found in review and fixed

| Problem | Evidence | Fix |
| --- | --- | --- |
| **Regression from the first batch:** `tabs.onUpdated` treated any `status: 'loading'` without a URL as a reload and wiped the tab. | Observed in Chrome 153: `history.replaceState` to the same URL and an iframe navigating after load both fire exactly that event. Every claim, including checked results, was wiped while the page kept its highlights, and the content script never rescanned. | Only a changed URL resets from `onUpdated`. Reloads are recognised by a per-document id each content script instance sends with `GET_STATE`; a back-forward-cache restore (`pageshow` with `persisted`) takes a new id and unwraps its old highlights. Worker and navigation regressions added; the three worker tests that simulated a reload with a bare status event now simulate a new document. |
| Wikipedia footnote markers broke sentence segmentation (pre-existing). | Observed in Chrome: `quarter.[1] Economists said…` became a claim beginning `1] Economists`, shown in the panel and sent as a search query; `sharply.[citation needed] Prices` was not split at all. | `segment.js` rejoins pieces ICU cut after `[` and splits after terminal punctuation followed by marker groups. Sentences stay contiguous substrings, so highlighting is unaffected (verified in Chrome across `<sup><a>[1]</a></sup>` nodes). |
| Caption banner missing from a panel opened after the video loaded (pre-existing). | Observed on YouTube: the video script reports its caption state only on change, so a panel opened afterwards never showed "Subtitles are off" or its "Open the transcript" button. | The worker remembers the last caption state per tab in session storage, returns it with `PANEL_READY`, and clears it on navigation and tab removal. Verified in Chrome. |
| Mutation triage rebuilt `document.body.textContent` on every mutation batch. | Code review: O(page) string work per batch, the flood case. | Triage reuses the last scan's size, as before the first batch. |
| Tags the bounded HTML token pattern skipped (over 4 KB, e.g. data-URI images) leaked into excerpts as text. | Regression test. | Leftover tags are stripped with a linear `<[^<>]*>` pass. |
| Every cache write read the whole of `chrome.storage.local` to sweep expired entries. | Code review: about six full reads per check. | Writes sweep at most every ten minutes; worker startup still sweeps. Expired entries are never served in between. Retention wording in README, store notes and options updated. |
| Panel updates were built for background tabs and discarded by every panel. | Code review. | `pushPanel` skips tabs Chrome reports as inactive. |

### Browser checks: completed

| Check | Result in Chrome 153 |
| --- | --- |
| Load unpacked; worker, content-script and panel errors | Loaded; the guide opened on install; no exceptions or console errors in any run. |
| Check a claim, then footnote and TOC anchor clicks | Claims, the checked result and highlights survive (7/7 spans, 0 stale). |
| Same-URL `replaceState`; iframe load and re-navigation after load | Claims and highlights survive (after the fix above). |
| SPA route (`pushState` with new content), query-only change, reload | Tab resets and re-flags; every claim highlighted, 0 stale spans. |
| Back navigation to a previous page | Re-flagged with highlights (Chrome did a full load; bfcache restore itself was not exercised). |
| Right-click selection with the panel closed | Real native menu click: the panel opened and the selection became a user claim. |
| Two windows, each with a panel | Each panel shows its own window's active tab; a new tab in one window moves only that panel; a check pressed in window B lands only on tab B. |
| On-device AI: switch tabs mid-summary | With `LanguageModel` stubbed inside the real panel (the real model reported `downloadable`, and was not downloaded), the summary lands on the original tab. |
| On-device AI: close and reopen the panel mid-summary | Claim stays summarizing while closed; reopening frees it and restores its buttons. |
| Worker stopped, then used | The next check works; publisher exclusions (canonical and wire credit) persist. |
| Options page open, thumbs-down in panel, then options Save | The site rule survives; the changed threshold is saved. |
| Disable caching and save | Stored answers go from 9 to 0. |
| Keyboard in the panel | Enter on a focused claim button activates it without stepping; ArrowDown on the citation select changes its value; arrows with nothing focused step claims. |
| Stress page | 0 highlights in excluded regions; Add 50 paragraphs: no duplicate claims; 10 s mutation flood: worst frame round-trip 15 ms, badge matches non-faint claims; Rescan and fake SPA navigation: 0 stale spans; multi-node claim highlighted. |
| Light and dark themes, 300 px panel | Both legible, no horizontal overflow. |
| YouTube: panel banner and "Open the transcript" | With subtitles off, a panel opened afterwards shows the banner and button; pressing it expands YouTube's transcript panel. |

### Browser checks: NOT RUN

- **YouTube transcript ingestion, live caption reading, and marker seeking.** YouTube
  would not start playback or populate the transcript (endless spinner) for the
  signed-out automated profile, so no captions or transcript segments existed to read.
  The timestamp forwarding (M8) is covered by the worker payload test only. Needs a
  human check in a normal profile: open a captioned video's transcript, confirm claims
  carry the transcript's times, and click one to confirm the video seeks there.
- **Real Gemini Nano.** Availability was `downloadable`; downloading it was not
  attempted. The routing was verified with a stubbed model in the real panel.
- **Back-forward cache restore.** The back navigation tested was a full load; the
  `pageshow` path is covered by the navigation test only.
- **Enter on a source link in the panel** was not exercised (the claim was folded by
  the previous step); the fix excludes links from the shortcut handler, and links are
  native.

### Remaining observations (not fixed)

- "Replace all content" on the stress page (an in-place swap with no URL change) leaves
  the old claims in the panel, and they are not marked "not on page". Pre-existing; the
  highlights themselves are removed. A follow-up could report claims whose spans have
  disappeared as unlocated.
- Source pages that redirect (http to https, DOI links) are not read, by design
  (`redirect: 'error'`); their snippets are used instead.
- Audit suspicions, still unproven: session-storage quota with many long infinite-feed
  tabs (each tab keeps at most 3,000 remembered sentences; a failed save degrades to
  in-memory state rather than breaking), and hidden login-form password fields marking
  an article private. Neither was reproduced; the second is a deliberate privacy bias.

### Also added

A "Buy me a coffee" link (https://buymeacoffee.com/generousmango) in the side panel
footer, at the end of the guide, and in Credits, plus README and store-notes mentions.
It is an ordinary link that opens a new tab and unlocks nothing. The 4.2 MB QR image
was left out of the package; `qr-code-coffee.png` is untouched in the repository root.

## Validation (first batch)

- Initial baseline: `npm test` — 591 passed, 0 failed, 0 skipped.
- Final full run: `npm test` — **619 passed, 0 failed, 0 skipped**, about 10.6 seconds.
- Changed JavaScript files passed `node --check`; changed files had no unexpected
  control bytes. `git diff --check` passed (Git printed only an LF/CRLF advisory).
- Worker, navigation and panel integration tests use Chrome API/DOM doubles.
- Real browser automation could not initialize: `failed to write kernel assets:
  The system cannot find the path specified. (os error 3)`.
- The options-page cache description was clarified after the final test run;
  this final edit changes HTML prose only.

## Repairs

| Audit ID | Change | Evidence / remaining check |
| --- | --- | --- |
| H1 | Ordinary fragment changes retain claims; real navigation clears highlight spans and serializes worker resets. Hash routes beginning `#/` or `#!` remain navigations. Query changes still reset intentionally. | Article VM and worker regressions; actual SPA/Chrome checks pending. |
| M1 | Separate source-URL guard rejects local/private hosts and credential-bearing URLs. Source fetches use `redirect: error` and omit cookies. Citation retention uses the same guard. Citation material rejects URLs outside the claim results before fetching. | Stub-fetch and citation regressions. DNS caveat below. |
| M2 | Forward-only, bounded HTML tokenization replaces unbounded paired-tag regexes; extraction caps input at 400,000 characters. Page responses enforce a streaming byte cap. | Malformed HTML flood tests and existing extraction suite. |
| M3 | Citation handlers use tab-aware settings that disable persistent caching in incognito; missing tabs also disable it. | Both citation paths tested for absence of `fccache:` entries. |
| M4 | Options submits only changed fields. Extension documents forward saves to the worker; one queue owns settings writes and atomic site-rule updates. | Stale-options and concurrent-save tests. |
| M5 | On-device requests carry original tab/window, request token and panel ownership. Replies use the original tab and reject obsolete tokens. | Switch-tab worker regression; actual on-device model check pending. |
| M6 | Provider JSON requests abort after 20 seconds for GET or 90 seconds for POST, including body reads, and report a readable error. | Body-timeout and recovery regression. |
| M7 | Only the same normalized claim text can let a published fact-check override evidence; conflicting applicable ratings produce mixed. Other reviews remain listed. | Unrelated/different-date/negation/changed-subject and conflicting-rating tests. |
| M8 | Worker includes claim timestamps in highlight messages; video markers prefer that timestamp. | Worker payload test; actual YouTube seek check pending. |
| M9 | Expiry sweep at startup and before writes; clearing invalidates pending cache writes. Disabling caching clears stored records. Retention disclosures distinguish expiry from physical deletion. | Expiry/orphan cleanup and in-flight-clear tests. |
| M10 | Publisher exclusions persist in session storage and clear on navigation/removal. | Worker-restart search-query regression. |
| L1 | Cached-result note now describes search caching without promising every subsequent request is free. | Copy reviewed. |
| L2 | Navigation shortcuts ignore buttons, links, selects and editable controls. | Actual panel code with DOM doubles; browser focus check pending. |
| L3 | Panel requests carry their window ID; received updates are filtered to that window's active tab. AI runs only in the originating window. | Panel and worker routing tests; two real windows pending. |
| L4 | Context menu opens the panel synchronously inside the click event, before awaits. | Synchronous-call test; actual Chrome gesture check pending. |
| L5 | Content senders cannot issue privileged panel/options messages; extension document URLs and extension IDs are checked. Sentence batches are bounded and validated. | Privileged-message rejection regression. |
| L6 | Article and video reads start disabled pending permission. Article mutation callbacks check navigation before touching text. Late policy replies are scoped to the requested URL. | Article delayed-policy and immediate-navigation tests; video browser check pending. |
| L7 | Testing, architecture, cache retention and user-facing cache documentation updated. | Manual documentation review. |

## Performance changes

- One flattened text index per highlight batch; ranges wrapped in reverse order.
- Unchanged readable paragraph text and ancestor exclusions cached locally; caches
  reset on rescans/navigation. Mutation triage uses `textContent`, avoiding layout.
- Source metadata is extracted from the same fetched HTML and reused for citations.
- Worker settings cached with storage-change invalidation; panel ignores unrelated
  storage writes.
- Startup recovery is awaited before incoming messages can modify state, addressing
  the audit's suspected hydration/recovery race.

## Limits and deliberate choices

- URL checks cannot resolve the final network address of a public hostname. DNS
  rebinding/private DNS resolution remains a defense-in-depth concern; do not claim
  complete private-network isolation. IPv6 literal hosts are conservatively refused.
- Redirecting source pages keep their existing snippets rather than follow an
  uninspectable redirect. The user can still open the normal source link.
- Exact normalized fact-check matching intentionally favors avoiding false verdicts;
  paraphrased reviews stay visible but do not override the thermometer.
- Expired records cannot be physically deleted while Chrome is closed; the docs now
  state when deletion runs. No new alarm permission was added.
- Session-storage quota stress and hidden login-modal false positives remain audit
  suspicions, not confirmed fixes. No broad classifier retraining or store submission
  work was undertaken.

See `CLAUDE-CONTINUE-AUDIT-FIXES.md` at the repository root for the remaining review
and browser-validation task. The original supplied audit is preserved beside this
report as `audit-original-2026-09-26.md`.
