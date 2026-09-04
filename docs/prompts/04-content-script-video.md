# Agent prompt: Content script — video mode (YouTube)

Copy everything below into a fresh agent session to build this component.

---

I'm building a Chromium browser extension that fact-checks content in real
time (full design in `docs/architecture.md` at the repo root — read it
before starting, especially sections 3.2 and 4). The extension scaffold
(Manifest V3 project, message-passing helpers, placeholder folders) should
already exist at the repo root — build inside `src/content/video/` and
extend the shared message types rather than inventing a new structure.

This task is the **video content script for YouTube**: instead of reading
page text, it gets the video's spoken content from captions/transcript so
claims can be checked without processing audio directly.

## What to build

1. **Caption/transcript source**: get the text of what's being said in the
   video using what YouTube already exposes in the page — either the
   transcript panel's data (if accessible from the page/DOM) or the caption
   cue text rendered during playback. Pick whichever is more reliable to
   read from the page without needing a network request to an unofficial
   API, and document why in this component's README. If neither is
   reliably available for a given video (captions disabled by the
   uploader), the content script should simply do nothing on that video
   rather than erroring.
2. **Grouping into sentences**: captions typically arrive as short,
   fragment-sized cues tied to timestamps. Group consecutive cues into full
   sentences (using punctuation and/or a timing gap heuristic) before
   sending them onward — the classifier expects sentence-shaped input, not
   caption fragments.
3. **Timestamp tracking**: keep each grouped sentence's approximate
   start/end timestamp, since (unlike article text) there's no fixed DOM
   position to highlight — the side panel will need the timestamp to let
   the user jump to that moment in the video (a "seek to" affordance is a
   nice-to-have if it's cheap to add here; not required if it complicates
   scope).
4. **Live vs. pre-recorded handling**: for a pre-recorded video, you can
   pull the whole transcript up front if available and stream sentences to
   the background worker progressively (don't dump the entire video's
   transcript as one giant batch — pace it, e.g. as captions actually play,
   or in a few chunks). For a live stream, process caption cues as they
   arrive in real time. Handle both if reasonably feasible; if not, live
   streams can be explicitly out of scope — say so in the README rather than
   silently mishandling them.
5. **Messaging**: same shared message-passing helper and flagged-claim
   response handling as the article content script (see
   `docs/prompts/03-content-script-articles.md` for the pattern) — reuse
   rather than duplicate that logic where it's genuinely shared (e.g. the
   auto-check toggle check).
6. **Highlighting equivalent**: since there's no static text to wrap, show
   flagged claims as an overlay or marker near the video player tied to the
   claim's timestamp, rather than trying to highlight caption text that's
   only rendered transiently.

## Out of scope

- Any video platform other than YouTube for v1.
- Audio transcription (e.g. running speech-to-text yourself) — only use
  captions/transcripts YouTube already provides. If a video has no
  captions at all, skip it.
- Actually calling the classifier, search API, or LLM — same boundary as
  the article content script; this only extracts and displays.

## Deliverables

- `src/content/video/` implementation wired into the existing manifest's
  content script matches for `youtube.com`/`youtu.be`.
- A short manual test note describing which videos you tested against
  (include at least one with auto-generated captions and one with
  uploader-provided captions if you can find both), and how live streams
  were handled or why they were scoped out.

Ask me if YouTube's transcript/caption data turns out to be hard to read
reliably from the page (e.g. requires enabling the transcript panel via a
click, or the DOM structure is unstable) — I'd rather hear about that
tradeoff than have you silently ship something fragile.
