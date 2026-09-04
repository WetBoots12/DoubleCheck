# FactCheck Browser Extension — docs

- [`architecture.md`](architecture.md) — the full design spec: pipeline,
  components, data flow, error handling, security, testing, and what's
  explicitly out of scope for v1.
- [`prompts/`](prompts/) — one self-contained, agent-ready prompt per
  component. Copy a prompt's contents into a fresh agent session to build
  that piece.

## Suggested build order

1. `prompts/01-classifier-training.md` — the classifier is the least
   dependent on everything else and other components code against its
   interface, so build/validate it first.
2. `prompts/02-extension-scaffold.md` — everything else plugs into this.
3. `prompts/08-provider-adapters.md` and `prompts/03-content-script-articles.md`
   / `prompts/04-content-script-video.md` can be built in parallel once the
   scaffold exists — none of them depend on each other.
4. `prompts/05-background-service-worker.md` — depends on the classifier's
   interface, the provider interfaces, and the scaffold's message-passing
   helper (can be stubbed against documented interfaces if built before
   the real classifier/adapters land — each prompt says how).
5. `prompts/06-side-panel-ui.md` and `prompts/07-options-settings-ui.md` —
   depend on the background worker's message shape and the provider
   registry respectively; build last, or in parallel with the background
   worker if you're comfortable coordinating on the message shape ahead of
   time.

## Deferred (not part of v1)

See `architecture.md` section 8 — source-credibility annotations
(AllSides/Ad Fontes/MBFC-style outlet ratings), non-YouTube video platforms,
and Brave's built-in AI are intentionally out of scope for now.
