# Agent prompt: Content script — article/text mode

Copy everything below into a fresh agent session to build this component.

---

I'm building a Chromium browser extension that fact-checks content in real
time (full design in `docs/architecture.md` at the repo root — read it
before starting, especially sections 3.2 and 4). The extension scaffold
(Manifest V3 project, message-passing helpers, placeholder folders) should
already exist at the repo root — build inside `src/content/article/` and
extend the shared message types rather than inventing a new structure.

This task is the **default content script**: it runs on ordinary web pages
(news articles, blog posts, forum threads — anything that isn't a video
player) and turns visible page text into sentences for the classifier to
score, then draws highlights on whatever the background worker flags back.

## What to build

1. **Text extraction**: identify the main readable content of the page
   (skip nav bars, ads, comments sections where reasonably detectable) and
   pull its visible text. Don't aim for perfect readability-mode parsing —
   a reasonable heuristic (e.g. largest cluster of `<p>` text, or an
   existing lightweight readability approach) is fine.
2. **Sentence segmentation**: split extracted text into sentences suitable
   for the classifier (`docs/prompts/01-classifier-training.md` defines its
   input shape as an array of sentence strings).
3. **Incremental re-scan**: watch for DOM changes (infinite scroll,
   SPA-style navigation without full reload) using a `MutationObserver` or
   similar, and only send *new* sentences to the background worker rather
   than re-sending the whole page each time. Debounce so a burst of DOM
   changes doesn't flood messages.
4. **Messaging**: send batches of new sentences to the background worker via
   the shared message-passing helper, and listen for the worker's response
   telling you which sentences were flagged (with a claim ID and status:
   pending/checked/error).
5. **Inline highlighting**: for each flagged sentence, wrap the matching
   text node(s) in a `<span>` with an injected CSS class reflecting its
   status (pending = subtle, checked-with-results = distinct color,
   error = another distinct color). Must not break the page's existing
   layout/scripts — only wrap text nodes, don't restructure surrounding
   elements. Clicking a highlighted span should send a message asking the
   side panel to scroll to/focus that claim's entry.
6. **Respect the auto-check toggle**: if the background worker reports
   auto-check is off, the content script should not bother extracting/
   scoring at all (check the setting once per page load and again if it
   changes mid-session via a message from the background worker).

## Out of scope

- Video/YouTube handling — that's `docs/prompts/04-content-script-video.md`.
- Actually calling the classifier, search API, or LLM — this content script
  only extracts text and renders highlights; the background worker owns
  scoring and fetching results.
- Perfect readability parsing — approximate is fine, this isn't a
  read-it-later app.

## Deliverables

- `src/content/article/` implementation wired into the existing manifest's
  content script matches (exclude youtube.com, that's the other content
  script's territory).
- A short manual test note in the component's README describing which real
  sites you verified extraction/highlighting on (pick 3-5 varied news/blog
  sites) and any layout issues you ran into and how you handled them.

Ask me if you find the page's text is behind heavy client-side rendering that
makes extraction unreliable on a specific site you're testing against —
don't silently ship a version that only works on simple static pages if that
wasn't the intent.
