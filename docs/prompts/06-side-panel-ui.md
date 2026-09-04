# Agent prompt: Side panel UI

Copy everything below into a fresh agent session to build this component.

---

I'm building a Chromium browser extension that fact-checks content in real
time (full design in `docs/architecture.md` at the repo root — read it
before starting, especially sections 3.4 and 4). The extension scaffold
(Manifest V3 project, message-passing helpers, placeholder folders) should
already exist at the repo root — build inside `src/sidepanel/` using
Chrome's `chrome.sidePanel` API, which the scaffold should already have
registered in the manifest.

This is the **side panel UI**: the running feed of flagged claims for
whatever tab the user currently has active, driven entirely by messages from
the background service worker (`docs/prompts/05-background-service-worker.md`
owns producing those messages — build against the message shape it defines,
coordinating on the exact shape if it's ambiguous).

## What to build

1. **Claim feed**: a scrollable list, most-recent-first, of flagged claims
   for the active tab. Each entry shows: the claim's sentence text, its
   current status (pending / checked / error), search results (title,
   source name, link) once available, and the LLM cross-reference summary
   if one was produced (omit that section entirely, don't show an empty
   placeholder, if no LLM provider is configured).
2. **Live updates**: the panel should update in place as the background
   worker pushes new claims or status changes for the active tab — no
   manual refresh needed. Switching the active tab should swap the feed to
   that tab's claims.
3. **Auto-check toggle**: a visible on/off switch for auto-checking,
   reflecting and updating the same setting the options page manages
   (`docs/prompts/07-options-settings-ui.md`) — read/write it via
   `chrome.storage.local` (or via a message to the background worker if
   that's cleaner given how it ends up implemented; coordinate on whichever
   the background worker component settled on) so both surfaces stay in
   sync.
4. **Bidirectional highlight linking**: clicking a feed entry sends a
   message telling the content script to scroll to and briefly emphasize
   that sentence on the page; receiving a "user clicked this highlight on
   the page" message should scroll the feed to and briefly emphasize that
   entry. (The content script side of this is already specified in
   `docs/prompts/03-content-script-articles.md` and
   `docs/prompts/04-content-script-video.md`.)
5. **Empty/no-key states**: if there are no flagged claims yet, show a
   brief explanatory empty state. If claims exist but no search API key is
   configured, show a prompt (with a link/button that opens the options
   page) instead of blank results.
6. **Video claims**: for claims that came from a video content script and
   carry a timestamp, show the timestamp and (if feasible) a
   "jump to this moment" action.

## Out of scope

- Any actual scoring, searching, or LLM calls — this is a pure display/
  interaction layer over messages the background worker sends.
- The options/settings page itself — that's
  `docs/prompts/07-options-settings-ui.md`; only the auto-check toggle is
  shared between the two surfaces.

## Deliverables

- `src/sidepanel/` implementation.
- A short manual test note describing how you verified live updates (e.g.
  triggering fake background worker messages) since a side panel is hard to
  fully unit test.

Ask me if the background worker's message shape for claim updates isn't
finalized/available yet — build against your best-documented guess based on
`docs/architecture.md` section 4 and note the assumption clearly so it's
easy to reconcile later.
