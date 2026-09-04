# Agent prompt: Provider adapter layer (search + LLM)

Copy everything below into a fresh agent session to build this component.

---

I'm building a Chromium browser extension that fact-checks content in real
time (full design in `docs/architecture.md` at the repo root — read it
before starting, especially sections 2, 3.7, and 6). The extension scaffold
(Manifest V3 project, message-passing helpers, placeholder folders) should
already exist at the repo root — build inside `src/providers/`, extending
whatever interface stubs already exist there rather than replacing them
wholesale (check first; reconcile if they conflict with what's below).

This component is the **pluggable boundary** between the extension and
whatever search/LLM vendor the user picks in the options page
(`docs/prompts/07-options-settings-ui.md`). The rest of the extension
(background worker, side panel, options page) only ever talks to these
interfaces — never to a specific vendor's SDK directly.

## What to build

1. **Interfaces** (TypeScript):
   ```ts
   interface SearchResult {
     title: string;
     url: string;
     source: string;      // domain or publisher name
     snippet?: string;
   }

   interface SearchProvider {
     id: string;
     label: string;       // shown in the options page dropdown
     search(query: string, apiKey: string): Promise<SearchResult[]>;
   }

   interface LLMProvider {
     id: string;
     label: string;
     isAvailable(): Promise<boolean>; // for built-in-browser-AI: feature detection
     crossReference(claim: string, results: SearchResult[], apiKey?: string): Promise<string>;
   }
   ```
   Treat this as a starting point, not gospel — if you find a detail that
   doesn't work once you're implementing a real adapter (e.g. a provider
   needs an extra param), adjust it and clearly note the change, since other
   components code against this shape.
2. **Concrete `SearchProvider`**: one adapter for a generic REST search API
   (pick one you can actually get a free/trial key for while testing — e.g.
   Bing Web Search or SerpAPI-shaped — and document exactly which one and
   its request/response mapping into `SearchResult`).
3. **Concrete `LLMProvider` — user-supplied key**: one adapter for an
   Anthropic- or OpenAI-style chat completions API, taking the claim and
   search results and returning a short (2-4 sentence) synthesis of what the
   sources say relative to the claim. Keep the prompt template simple and
   include it inline in the code (not hidden in a config file) so it's easy
   to review and adjust.
4. **Concrete `LLMProvider` — built-in browser AI**: an adapter for Chrome's
   on-device Prompt API (Gemini Nano / `window.ai` or its current successor
   API — check what's actually shipping in stable/current Chrome at
   implementation time, APIs here have moved around) with `isAvailable()`
   correctly feature-detecting whether it's present, and requiring no API
   key. If the currently available API differs meaningfully from what's
   described here, implement against what's actually there and document the
   discrepancy rather than guessing.
5. **A small registry**: a lookup exporting all available providers by id,
   which the options page uses to populate its dropdowns and the background
   worker uses to resolve the user's selected provider at call time.
6. **Error handling contract**: all adapters should throw/reject with a
   small typed error (e.g. distinguishing "no/invalid key",
   "rate limited", "network error", "unknown") rather than raw fetch
   errors, since the background worker needs to show a sensible per-claim
   error state rather than a generic failure.
7. **Unit tests**: for each concrete adapter, mock the HTTP layer and test
   both a success path (mapping a realistic API response into
   `SearchResult[]`/a summary string) and at least one error path (bad key,
   rate limit) mapping into the typed error contract.

## Out of scope

- Deciding which provider the user has selected, or reading API keys from
  storage — that's the background worker's job
  (`docs/prompts/05-background-service-worker.md`); adapters just take
  whatever key/query they're called with.
- Any UI.

## Deliverables

- `src/providers/` implementation: interfaces, the three concrete adapters
  described above, the registry, and unit tests.
- A README noting exactly which search API and which user-supplied LLM API
  you targeted (name, docs link, auth scheme) and what Chrome's built-in AI
  API surface looked like at the time you implemented against it, since that
  API is still evolving and this may need revisiting.

Ask me before spending real money on a paid API tier while testing — use
free tiers/trial keys, and flag it if a provider doesn't offer one, so we
can pick a different one rather than you incurring cost.
