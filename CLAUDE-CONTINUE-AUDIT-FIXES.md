# Continue the Chrome extension audit repairs

Work in `C:\Users\johns\OneDrive\Desktop\FactCheck Browser extension`.

The user authorized fixing the supplied audit and reporting back when complete.
Codex implemented a substantial repair batch, then wrapped up as its five-hour
usage allowance approached exhaustion. Continue from the working tree; do not
restart the audit from scratch or overwrite the existing changes.

Read these first:

1. Applicable `AGENTS.md` guidance, if any.
2. `docs/audit-original-2026-09-26.md` — the user's original audit.
3. `docs/audit-repair-report.md` — per-finding changes, test evidence and limitations.
4. `git status --short` and the current diff, then affected code and tests.

All fixes are uncommitted. HEAD was `9ab6d0a` when this handoff was written; verify
current state rather than assuming it is unchanged. An unrelated untracked
`qr-code-coffee.png` appeared during this work: preserve it. Do not reset, clean,
commit, publish or remove user work. The old baseline was 591 passing tests; the
latest full `npm test` run was **619 passed, 0 failed, 0 skipped**. A final edit to
options.html only clarified cache-retention prose. No dependencies/build tools were
added. Run tests with the existing Node runner; preserve the no-build extension.

## What is done

Production changes address H1, M1–M10, L1–L7, plus the compatible performance
improvements. The repair report details them. New regression tests cover source
URL guards, timeout/body handling, malformed HTML, incognito citation cache writes,
settings races, AI tab ownership, timestamp forwarding, cache expiry/clear races,
publisher persistence, navigation/privacy timing, highlight batching, and panel
routing/keyboard/storage handling. `src/sidepanel/panel.test.mjs` is in `npm test`.
The panel harness was updated for the window-scoped API calls.

## What remains

1. Review the whole diff, particularly integration points in the worker, panel,
   options saves, cache lifecycle and content-script navigation. Validate the new
   worker settings cache and event invalidation under real storage events; current
   worker tests mostly use stubs without storage.onChanged. Add targeted regressions
   only for actual gaps or problems you discover. Repair any confirmed defect.
2. Complete real Chrome validation. Codex's browser automation failed at startup
   with `failed to write kernel assets ... path specified ... (os error 3)`; none
   of the following has been verified in a loaded extension:
   - Load unpacked and inspect worker/content-script/panel errors.
   - Check a claim, click Wikipedia footnotes/TOC anchors, and verify results and
     working highlights survive. Check real SPA routes, query changes and reloads.
   - With the panel closed, right-click a selection and confirm it opens.
   - Open panels in two windows, switch tabs, and confirm each window's panel and
     actions stay attached to the correct tab.
   - With built-in AI available, start a summary, switch away and back, then test
     closing/reopening the panel and restarting the worker during a request.
   - On YouTube, ingest a transcript and confirm markers seek to transcript times;
     verify captions/rescans after navigation and delayed policy replies.
   - Open options, change a site rule in the panel, then save an unrelated option;
     ensure the rule survives. Confirm disabling caching clears stored answers.
   - Verify Enter on buttons/links and arrows on selects retain native behavior.
   - Exercise stress-page mutation flood, rescan, mixed inline text highlights,
     light/dark appearance and a narrow panel.
   Use isolated test data. Do not call paid providers or send real private content.
   If browser access is unavailable, explicitly retain these as NOT RUN; do not
   invent results or equate DOM doubles with real Chrome.
3. Review the original audit's remaining suspicions (session quota with many tabs,
   hidden password fields) without treating them as proven bugs. The recovery race
   was addressed by awaiting startup before dispatching messages.
4. Run the full suite after any production changes, plus syntax and diff checks.
   Update the repair report with observed results and report to the user.

## Preserve these safety and product choices

- Source fetching rejects redirects BEFORE following them; checking response.url
  after following would not prevent a private-network request. Hostname validation
  cannot prevent public names resolving to private IPs: this remains a documented
  limitation, not a solved DNS isolation guarantee.
- Local model endpoints remain available: the source-page URL guard must not be
  applied indiscriminately to explicitly configured local AI provider requests.
- Fact-check overrides require identical normalized claim text. Do not replace this
  with an arbitrary lexical threshold that can mistake a different subject/date or
  negation for the same claim. Paraphrases remain in the list for the reader.
- Cache entries expire at 24 hours; physical cleanup happens on worker startup or
  cache writes, delayed while Chrome is closed. Keep user-facing promises accurate.
- Keep real query/hash application routing distinct from ordinary anchor jumps;
  ignoring all query strings would preserve stale claims across actual pages.
- Preserve incognito and site-block behavior across every citation/cache path.

The desired deliverable is finished, reviewed fixes with passing tests and an honest
list of browser checks completed versus unavailable, not another speculative audit.
