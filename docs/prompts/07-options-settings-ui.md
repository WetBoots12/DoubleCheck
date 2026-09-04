# Agent prompt: Options / settings page

Copy everything below into a fresh agent session to build this component.

---

I'm building a Chromium browser extension that fact-checks content in real
time (full design in `docs/architecture.md` at the repo root — read it
before starting, especially sections 3.6 and 6). The extension scaffold
(Manifest V3 project, message-passing helpers, placeholder folders) should
already exist at the repo root — build inside `src/options/`, registered as
the manifest's `options_page` so Chromium opens it as a normal full browser
tab (not an embedded popup) when the user clicks "options" or is prompted to
configure something.

This is the **settings surface**: where the user pastes their own API keys
and configures how the extension behaves. There is no backend server for
this project — everything here is stored locally via `chrome.storage.local`,
which persists across browser restarts, and keys are only ever sent to the
provider endpoints the user themselves selects.

## What to build

1. **API key fields**: inputs for a search API key and an (optional) LLM API
   key, saved to `chrome.storage.local`. Mask the key inputs like a password
   field. Include a brief inline note that keys are stored locally on-device
   and never sent anywhere except the provider the user selects.
2. **Provider selection**: dropdowns/selectors for which `SearchProvider`
   and which `LLMProvider` to use, sourced from the adapter registry defined
   in `docs/prompts/08-provider-adapters.md`. Include the browser's built-in
   AI as an `LLMProvider` option only when `LLMProvider.isAvailable()` (or
   equivalent feature-detection the adapter exposes) reports it's actually
   present — don't show an option that will just fail on most machines/
   browsers.
3. **Threshold control**: a slider or numeric input for the check-worthiness
   threshold (how confident the classifier must be before a sentence gets
   flagged), with a sensible default and a short explanation of what
   raising/lowering it does (fewer/more claims flagged).
4. **Auto-check toggle**: the global on/off switch for automatic checking —
   this is the same setting the side panel also displays/toggles
   (`docs/prompts/06-side-panel-ui.md`); make sure whichever storage key/
   message pattern you use here is documented clearly enough for that
   component to read and write it consistently.
5. **Validation feedback**: on save, do a lightweight check that a pasted
   key is at least well-formed for the selected provider (e.g. non-empty,
   matches an expected prefix/length if the provider has one) and show a
   clear error rather than silently saving something broken. A full "test
   this key against the live API" call is a nice-to-have, not required.
6. **Persistence**: all settings read/write through `chrome.storage.local`
   (not `sessionStorage`, not an in-memory-only store, and not an actual
   HTTP cache) so they survive browser restarts.

## Out of scope

- Building the actual `SearchProvider`/`LLMProvider` implementations — this
  page only lets the user select and configure them; see
  `docs/prompts/08-provider-adapters.md`.
- Any hosted/external website — this is a bundled extension page that opens
  as a local tab, not something deployed anywhere.

## Deliverables

- `src/options/` implementation.
- A short README note listing the exact `chrome.storage.local` keys used for
  each setting (API keys, provider selection, threshold, auto-check toggle),
  since the background worker and side panel components both need to read
  some of these and must agree on the key names/shapes.

Ask me if the provider adapter registry (`docs/prompts/08-provider-adapters.md`)
isn't built yet when you start this — hardcode a small placeholder list of
provider names/ids matching what that spec describes, clearly marked as
temporary, so wiring in the real registry later is a small change.
