# Testing and stress plan

## Automated

```bash
npm test
```

Covers the scorer (tokenizing, features, heuristic ranking and bounds), throughput
and degenerate input, and the AI response parser. Two tests skip until a model is
trained: the Python-to-JavaScript parity check and the trained-model throughput
check. Both start running automatically once `classifier/model/model.json` exists.

Not covered by automation, and worth knowing: the background worker, the provider
adapters against live APIs, and both content scripts. Those need the manual passes
below, because they depend on real pages and real browser lifecycle behavior.

## Stress fixture

Open `tools/stress-page.html` in the browser with the extension loaded. It carries
claim-shaped sentences in both `<p>` and `data-testid` divs, plus chatter that
should *not* be flagged, plus navigation and player chrome that should never be
scanned at all.

| Button | What it exercises | What should happen |
|---|---|---|
| Add 50 paragraphs | Incremental re-scan | Badge climbs, new highlights appear, no duplicates |
| Flood | 20 mutations/sec for 10s | Debouncing holds, page stays responsive, badge settles |
| Fake SPA navigation | `pushState` handling | Claims reset to zero, then repopulate from new content |
| Replace all content | In-place DOM swap | New content scanned, stale highlights gone |

Things to watch for on that page:

- The sentence built from a link, a bold phrase and an emphasis must highlight as
  one claim. It only does if matching spans multiple text nodes.
- The page must yield claims at all. Its `<html>` class deliberately contains
  "menu" and "nav", which once caused every paragraph on Wikipedia to be excluded.

- Nothing from the nav, header, footer, aside, or the fake video menu should ever
  be flagged, even though several contain claim-shaped sentences with numbers.
- The chatter sentences should score below the threshold while the factual ones
  clear it. If everything is flagged, the threshold is too low, or the heuristic
  fallback is still in use.
- The badge count should match the number of entries in the panel.

## Manual passes

**Articles.** Visit a few structurally different sites: a `<p>`-based blog, a
`data-testid`-based site such as Reuters, and something infinite-scrolling. Check
that extraction finds the body, that highlights land on the right sentences, and
that scrolling adds claims without re-adding old ones.

**Navigation.** Within one tab: article, back, forward, click through to another
article, then a hard reload. Claims should reset at each navigation and repopulate.
Then open a second tab, navigate it, and confirm the panel for the first tab is not
disturbed.

**Video.** A YouTube video with uploader captions and one with auto-generated
captions, since auto-captions often lack punctuation and exercise the length-based
flush instead. Confirm markers carry sensible timestamps and that switching videos
clears them. `tools/youtube-caption-probe.js` reports what the content script sees
without needing the extension loaded, which isolates caption reading from the rest
of the pipeline. Live streams are untested and may need their own handling.

Three further video checks. First, open the transcript from the video's
description (…more, then Show transcript): the panel banner should switch to
"Reading captions and transcript" with a sentence count that climbs, and claims
should appear with timestamps taken from the transcript. That count is the
diagnostic for the whole video path: a rising count with no claims means the
threshold is the reason, a count stuck at zero means nothing is being read. The
caption probe now also reports transcript segment counts and whether the page
enforces Trusted Types, which YouTube does and which makes any innerHTML
assignment throw, so the video script must never use one.

Then the two checks that follow. With captions switched off, a hint should appear both
in the on-page overlay and as a banner at the top of the panel, and both should
clear the moment captions are turned on; on a video that has no caption track at
all, the hint should say so instead. That second case rests on the state and
visibility of the player's subtitles button, which is a best-effort heuristic, so
confirm it on a real captionless video rather than trusting it. Then play a
captioned video at 2x: claims should still arrive as whole sentences. The
caption container is observed for changes, with the one-second poll as fallback,
because at that speed a cue can appear and vanish between polls.

**Quota discipline.** This is the one worth being careful about, since mistakes here
cost real money. Confirm that loading a page dense with claims fires zero search
calls, that "Check sources" fires exactly one, that "Summarize with AI" fires none,
and that double-clicking a button does not double-fire. Watch the provider's usage
dashboard rather than trusting the UI.

**Failure paths.** Wrong key, no key, provider rate limit, aeroplane mode, and a
local model endpoint that is not running. Each should produce a readable per-claim
error and leave the rest of the queue working.

**Themes.** Both light and dark, since a rule-ordering bug once made the panel
white-on-white in dark mode only.
