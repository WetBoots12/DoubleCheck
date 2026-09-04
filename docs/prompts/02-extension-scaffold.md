# Agent prompt: Extension scaffold (Manifest V3 project skeleton)

Copy everything below into a fresh agent session to build this component.

---

I'm building a Chromium browser extension that fact-checks content in real
time (full design in `docs/architecture.md` at the repo root — read it before
starting). This task is the foundational scaffold that every other component
(content scripts, background worker, side panel, options page, provider
adapters) will plug into.

## What to build

1. A Manifest V3 extension project skeleton with:
   - `manifest.json` declaring: a background service worker, a side panel
     (`chrome.sidePanel` API), an options page (`options_page`, opened as a
     full tab, not an embedded popup), content script injection points for
     both regular pages and YouTube, the `storage` permission, `activeTab`,
     and host permissions scoped as narrowly as reasonably possible for a
     "runs on any page" extension.
   - The extension icon wired up with badge support
     (`chrome.action.setBadgeText`/`setBadgeBackgroundColor`) — an empty
     placeholder implementation is fine here, later components will set real
     values.
2. Build tooling: pick a reasonably standard, low-ceremony setup (e.g. plain
   TypeScript + esbuild/Vite, whichever you judge simplest to maintain) that
   compiles the extension into a `dist/` (or similar) folder loadable via
   Chrome's "load unpacked" developer mode. Document the build/watch/load
   commands in a top-level `README.md`.
3. Placeholder files for each of the other components so the project
   structure is obvious and other agents can drop their work in without
   restructuring:
   - `src/background/` (service worker entry point)
   - `src/content/article/` and `src/content/video/` (content script entry
     points)
   - `src/sidepanel/` (side panel UI entry point)
   - `src/options/` (options page entry point)
   - `src/providers/` (search/LLM adapter interfaces — just the TypeScript
     interfaces/types for now, per section 3.7 of the architecture doc; the
     concrete adapters are a separate task)
   - `classifier/inference/` — leave this alone if it already exists from
     the classifier sub-project; otherwise create an empty placeholder folder
   Each entry point can just log that it loaded — no real logic yet, this
   task is purely the skeleton + wiring.
4. Message-passing scaffolding: a typed helper (in `src/shared/messages.ts`
   or similar) for background <-> content script <-> side panel
   communication, since every other component depends on a consistent
   message shape rather than each inventing its own.
5. A basic test runner setup (whatever pairs naturally with your build
   tooling choice) with one smoke test proving the background worker loads
   without throwing.

## Out of scope

- Real classifier integration, real content extraction, real search/LLM
  calls, real UI — all of that belongs to the other component tasks listed
  in `docs/architecture.md` section 9. Keep this scaffold thin.

## Deliverables

- A loadable, unpacked Manifest V3 extension that does nothing user-visible
  yet but proves the pieces are wired together (background worker starts,
  side panel opens, options page opens as a tab, content scripts inject and
  log on both a regular page and youtube.com).
- Top-level `README.md` with setup/build/load-unpacked instructions.

Ask me before picking a UI framework (React/Svelte/vanilla) for the side
panel and options page if you think it materially affects how the other
component tasks should be written — otherwise vanilla TypeScript + small
DOM helpers is a safe default given how small each UI is.
