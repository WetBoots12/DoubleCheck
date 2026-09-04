# Agent prompt: Background service worker (orchestration)

Copy everything below into a fresh agent session to build this component.

---

I'm building a Chromium browser extension that fact-checks content in real
time (full design in `docs/architecture.md` at the repo root — read it
before starting, especially sections 3.3, 4, and 5). The extension scaffold
(Manifest V3 project, message-passing helpers, placeholder folders) should
already exist at the repo root — build inside `src/background/` and use the
existing shared message types.

This is the **orchestrator**: a Manifest V3 background service worker
(JavaScript/TypeScript — this must run as a browser extension service
worker, not an actual Python process) that ties the classifier, content
scripts, provider adapters, and side panel together. Think of it as a small
pipeline script: it receives sentences, scores them, decides what to do with
flagged ones, and reports results onward.

## What to build

1. **Message routing**: receive batched sentences from either content script
   variant (article or video — see `docs/prompts/03-content-script-articles.md`
   and `docs/prompts/04-content-script-video.md`), keyed by tab ID.
2. **Classifier integration**: call the classifier's inference wrapper
   (`scoreClaimWorthiness(sentences)` from
   `docs/prompts/01-classifier-training.md`) on incoming sentences. If the
   classifier module isn't available yet when you build this (it may be
   built in parallel), code against its documented interface and stub it
   behind a clearly marked placeholder so swapping in the real module later
   is a one-line change.
3. **Threshold + toggle logic**: read the user's auto-check on/off setting
   and check-worthiness threshold from `chrome.storage.local` (the options
   page component owns writing these settings — see
   `docs/prompts/07-options-settings-ui.md` — but you own reading and
   reacting to them, including live updates if the user changes them
   mid-session). If auto-check is off, tell content scripts not to bother
   scanning at all rather than scoring and discarding.
4. **Per-tab state**: maintain, per tab, the list of flagged claims found so
   far and their current status (pending/checked/error) and results, so
   reopening the side panel for a tab shows what's already been found
   instead of starting empty. This can be in-memory (service workers are
   ephemeral, so state resets on worker restart/browser restart — that's
   acceptable; don't over-engineer persistence here).
5. **Provider adapter calls**: for each flagged sentence, call
   `SearchProvider.search(sentence)` (interface defined in
   `docs/prompts/08-provider-adapters.md`), then if an LLM provider is
   configured, call `LLMProvider.crossReference(sentence, results)`. Code
   against the documented interfaces; if the adapters aren't built yet,
   stub them clearly the same way as the classifier.
6. **Rate limiting/backoff**: apply a simple limit (e.g. max N in-flight
   search/LLM calls at once, plus basic exponential backoff on repeated
   errors from one provider) so a text-heavy page doesn't immediately blow
   through the user's API quota.
7. **Badge updates**: set the toolbar badge
   (`chrome.action.setBadgeText`/`setBadgeBackgroundColor`) to the count of
   flagged claims for the currently active tab, updating as new ones are
   found and clearing/resetting on navigation to a new page.
8. **Push to side panel**: whenever a claim's status changes, send an update
   to the side panel if it's open for that tab (see
   `docs/prompts/06-side-panel-ui.md` for the message shape it expects).

## Out of scope

- Any actual UI — this component only orchestrates and messages.
- Building the classifier or provider adapters themselves — integrate
  against their interfaces (stub if not yet available, as described above).

## Deliverables

- `src/background/` implementation.
- Integration test(s) covering the message-passing chain: a fake content
  script message comes in, gets scored (mock the classifier), a flagged
  claim triggers a mocked search call, and a side-panel-bound message goes
  out with the expected shape.
- A short note in this component's README on how you stubbed any
  not-yet-available dependency (classifier and/or adapters), so whoever
  wires in the real implementation later knows exactly what to swap.

Ask me if the auto-check toggle or threshold setting isn't available yet
from the options page component when you build this — decide on a
reasonable default (auto-check on, a moderate threshold) and note the
assumption rather than blocking on it.
