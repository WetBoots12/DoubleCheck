# Claude prompt: audit and bug-test this Chrome extension

You are an experienced Chromium Manifest V3 engineer performing a skeptical, evidence-driven bug audit of this repository. The goal is to find reproducible defects and important untested failure modes in the Chrome extension, especially bugs that could cause incorrect behavior, privacy leaks, quota/API calls, crashes, or Chrome Web Store problems.

## Repository and guardrails

- You are already in the repository root. Read the checked-in files directly; do not ask me to paste code.
- Start by reading `README.md`, `docs/architecture.md`, `docs/testing.md`, `manifest.json`, `package.json`, and any applicable `AGENTS.md` files. Treat source code and tests as authoritative when prose disagrees; call out stale documentation.
- Inspect the current git status before doing anything. Preserve existing user changes.
- This project has no build step. Its automated tests use Node's built-in test runner; run `npm test` to establish the current baseline. Do not assume a test count, branch name, commit, manifest permission, or clean working tree from an older audit prompt.
- Do not install dependencies or add a bundler. Do not access real user accounts, submit store listings, use paid APIs, or send page content to external services during the audit.
- Audit and report first. Do not modify production code or tests unless I explicitly ask you to implement fixes. You may use temporary, isolated experiments if needed, and must remove your own temporary artifacts afterward.
- Never claim browser behavior was tested unless you actually loaded the extension in Chrome and observed it. Mark such checks `NOT RUN — browser required` when no real browser run is available.

## Product behavior and invariants to verify

Use the repository's current implementation and documentation to confirm the product contract. At a minimum, examine these intended properties:

1. Page/video scanning and classifier scoring happen locally. Network access to search, fact-check, scholarly, or AI providers must be caused by a deliberate user action. Verify every path rather than relying on comments or UI labels.
2. Privacy policy is enforced consistently before page text is read, retained, scored, or sent, including rescans, context-menu claims, video/transcript paths, and changes to site permissions/settings. Check private or sensitive pages, password/card fields, local addresses, user block lists, and incognito behavior against the actual implementation.
3. API keys stay in local extension storage and are sent only to the selected provider. Page text and cached claim data must follow the project's disclosed behavior.
4. Scores and evidence are signals for research, not truth verdicts. Check calculations, labels, malformed/partial provider data, and UI states.
5. The Manifest V3 service worker can be suspended and restarted without losing state required for correctness or privacy.
6. Content scripts are classic scripts if the manifest loads them as classic scripts; do not assume they can use ES module imports.
7. A provider failure, malformed response, timeout, or tab navigation should not strand claims, corrupt other tabs, or break the rest of the UI.

Treat these as audit questions, not assumptions that the current code has these properties. Verify each against current code and tests.

## Audit workflow

1. Establish the baseline with `npm test`; record the exact command and result. If it fails, report pre-existing failures separately and do not attribute them to your audit.
2. Map the implementation from `manifest.json` through the background worker, content scripts, side panel, options UI, shared modules, providers, and model. Read relevant tests alongside the code. Search for dangerous sinks and boundaries such as `innerHTML`, URL construction, `fetch`, message listeners, storage writes, timers, dynamic code, and DOM observers.
3. Trace the important user flows end to end: initial scan, incremental/SPA scan, rescan, context-menu claim, manual source check, AI summary, transcript/caption ingestion, tab switching, worker restart, and provider failure. Pay special attention to sender validation and message payload validation at the worker boundary.
4. For each likely bug, identify the exact trigger, affected code path, user-visible impact, and a minimal reproduction. Prefer a focused automated regression test using the existing Node test conventions when a behavior can be tested without Chrome. Do not add tests or code to the repository unless authorized.
5. Inspect the extension packaging and permissions against the code that actually uses them. Identify unnecessary permissions, overly broad host access, missing icons/locales/metadata, unsafe web-accessible resources, and minimum Chrome version/API mismatches. Explain actual functional or store-review impact; do not call something a rejection risk without a reason.
6. Review privacy and security boundaries: page-originated input, content-script-to-worker messages, externally influenced provider data, HTML rendering, API-key handling, URL/query construction, regex and parser robustness, storage contents/retention, and network request credentials/redirects/timeouts.
7. Review reliability and performance: async message replies, rejected promises, `chrome.runtime.lastError` or API rejection handling, read-modify-write races, queue/deduplication state, observer cleanup, repeated injection/listeners, unbounded work/storage, and expensive work on mutation-heavy or very large pages.
8. Finish with a concise manual Chrome checklist for critical behavior that static tests cannot establish. Include how to load unpacked, inspect service-worker errors, inspect page content-script errors, and exercise navigation/worker restart only if those steps are relevant to this codebase.
9. Re-run `npm test` only if you created an authorized change. Otherwise, report the baseline result and do not imply the repository was modified.

## Areas to inspect

Cover the applicable items below, and add code-specific areas you discover:

- Manifest validity, permissions and host permissions, match/exclude patterns, content-script world/timing/frame scope, service-worker module configuration, web-accessible resources, CSP, and Chrome API version support.
- Service-worker lifecycle, top-level listener registration, state persistence, tab isolation, navigation races, tab removal, side-panel routing, and worker wake-up paths.
- Content-script extraction and highlighting: excluded/private regions, sentence segmentation across nodes, mutation triage/debounce, SPA/history navigation, duplicate claims, highlight cleanup, hostile page DOM/global interference, and video captions/transcripts.
- Every runtime/tab message sender and receiver: supported message types, input validation, `sender` checks, tab identity, and privacy checks before privileged operations.
- HTML/text/URL handling in the panel and options pages; provider and page text must not become executable markup or unsafe navigation.
- Provider request construction, key routing, quota discipline, caches and invalidation, timeout/abort behavior, fallback behavior, response parsing, and partial failures.
- Classifier feature parity with training, malformed/degenerate input handling, threshold boundaries, and performance on long or numerous sentences.
- Evidence/date/numeric logic for non-finite values, missing data, contradictory quantities, boundary conditions, and misleading display language.
- Accessibility and practical UI edge cases: narrow side panel, light/dark appearance, empty/loading/error states, keyboard behavior, restricted browser pages, unsupported languages, incognito, and revoked host permissions.
- Web Store single-purpose/privacy disclosures and remotely hosted code/assets, based on the exact current implementation and manifest.

## Reporting format

Report only actionable findings. Sort by severity: Critical, High, Medium, Low. For each finding include:

- **ID and severity**
- **Title**
- **Location:** file and line/function
- **Status:** confirmed, likely (explain missing proof), or browser-only/unverified
- **Trigger and impact:** concrete steps and what breaks or data/API boundary is affected
- **Evidence:** exact code path, test result, trace, or minimal reproduction; distinguish observed evidence from inference
- **Suggested fix:** specific and proportionate; include a small code sketch only when it clarifies the repair
- **Regression test:** what test should capture the bug and whether it can run under the current test setup
- **Chrome Web Store impact:** specific policy/review consequence, or `None identified`

Do not pad the report with generic best practices, unsupported speculation, or “clean” sections. If an important area has no findings, say briefly that it was reviewed and no actionable defect was confirmed. Keep suspicions separate from confirmed defects. Do not invent line numbers or evidence.

Conclude with:

1. A ranked summary table of findings.
2. The exact baseline test command and result, including any existing failures.
3. Browser-only checks that still need a human/real Chrome run, each with clear steps and expected behavior.
4. Any audit limitations, such as unavailable network credentials or inability to load a real Chrome profile.

Start with the repository state and baseline. Then proceed with the audit.
