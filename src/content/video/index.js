// Video mode (YouTube): read caption cues as they render, group them into sentences,
// and show flagged claims as timestamped markers near the player. No audio processing —
// if a video has no captions, this script does nothing.

(() => {
  const MSG = {
    SENTENCES: 'sentences',
    HIGHLIGHT_CLICKED: 'highlightClicked',
    GET_STATE: 'getState',
    PAGE_CHANGED: 'pageChanged',
    SCAN_CONFIG: 'scanConfig',
    CLAIM_STATUS: 'claimStatus',
    FOCUS_SENTENCE: 'focusSentence',
    NAV_CLAIM: 'navClaim',
    NAV_STATE: 'navState',
    CAPTION_HINT: 'captionHint',
    PAGE_LANGUAGE: 'pageLanguage',
    OPEN_TRANSCRIPT: 'openTranscript',
    RESCAN: 'rescan',
    PAGE_META: 'pageMeta',
  };

  let autoCheck = false;
  // Names this document for the worker, so a reload is told apart from events that
  // merely look like one; see the article script. Not crypto.randomUUID, which
  // needs a secure context.
  const docId = Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
  // Some viewers want the panel and a clean player. The claims are still found and
  // still listed; only the markers over the video go away.
  let showOverlay = true;

  // --- language ---------------------------------------------------------------
  // The classifier reads English only, and a video's captions are often in a
  // different language from the page around them, so document.documentElement.lang
  // is the wrong signal here: on YouTube it is the language of the interface, not
  // of what is being said. The captions themselves are the evidence.
  //
  // Judging needs a sample, so the first sentences are held rather than shipped,
  // and released or dropped once there is enough to decide. If a video simply never
  // produces enough caption text, the hold is released anyway: the bias is towards
  // scanning, as it is for articles.
  const LANG_HOLD_MS = 20000;
  let english = null;          // null = not yet decided
  let held = [];               // batches waiting on the verdict
  let heldWords = 0;
  let heldSince = 0;
  let languageReported = false;

  function releaseHeld() {
    const batch = held.flat();
    held = [];
    heldWords = 0;
    heldSince = 0;
    if (batch.length) {
      chrome.runtime.sendMessage({ type: MSG.SENTENCES, sentences: batch }).catch(() => {});
    }
  }

  function dropHeld() {
    held = [];
    heldWords = 0;
    heldSince = 0;
  }

  // Called with each new batch, and from the tick so a quiet video still resolves.
  function decideLanguage(force = false) {
    if (english !== null) return;
    const text = held.flat().map((s) => s.text).join(' ');
    const enough = heldWords >= FCLanguage.MIN_WORDS;
    if (!enough && !force) return;

    const verdict = enough ? FCLanguage.detect(null, text) : { english: true };
    english = verdict.english;
    if (english) {
      releaseHeld();
      return;
    }
    dropHeld();
    if (!languageReported) {
      languageReported = true;
      chrome.runtime
        .sendMessage({ type: MSG.PAGE_LANGUAGE, language: verdict.language })
        .catch(() => {});
    }
  }

  let buffer = '';
  let bufferStart = 0;
  let lastCue = '';
  const sent = new Set();
  const markers = new Map(); // claimId -> { ts, text }

  const video = () => document.querySelector('video');
  const now = () => video()?.currentTime || 0;

  function fmt(t) {
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  // Captions YouTube already renders for the user; grouped into sentences by
  // punctuation, or flushed on a pause in speech.
  function readCues() {
    if (checkVideoNavigation() || !autoCheck) return;
    const seg = document.querySelectorAll('.ytp-caption-segment');
    if (!seg.length) return;
    const text = [...seg].map((s) => s.textContent).join(' ').replace(/\s+/g, ' ').trim();
    if (!text || text === lastCue) return;
    lastCue = text;

    if (!buffer) bufferStart = now();
    buffer = `${buffer} ${text}`.replace(/\s+/g, ' ').trim();

    // Flush complete sentences out of the rolling buffer. Uses the same segmenter
    // as the article script, so honorifics and abbreviations do not split cues.
    const parts = FCSegment.splitSentences(buffer);
    if (parts.length > 1) {
      const complete = parts.slice(0, -1);
      buffer = parts[parts.length - 1];
      ship(complete, bufferStart);
      bufferStart = now();
    } else if (buffer.split(/\s+/).length > 45) {
      // Auto-captions often lack punctuation — flush on length so it doesn't grow forever.
      ship([buffer], bufferStart);
      buffer = '';
      bufferStart = now();
    }
  }

  function ship(sentences, ts) {
    const batch = [];
    for (const s of sentences) {
      const t = s.trim();
      const k = t.toLowerCase();
      if (t.length < 30 || sent.has(k)) continue;
      sent.add(k);
      batch.push({ id: `v${sent.size}_${Date.now().toString(36)}`, text: t, ts });
    }
    if (!batch.length) return;

    if (english === false) return; // captions are not in a language we can read
    if (english === null) {
      held.push(batch);
      heldWords += batch.reduce((n, s) => n + s.text.split(/\s+/).length, 0);
      if (!heldSince) heldSince = Date.now();
      decideLanguage();
      return;
    }
    chrome.runtime.sendMessage({ type: MSG.SENTENCES, sentences: batch }).catch(() => {});
  }

  // --- overlay --------------------------------------------------------------
  // Rendered inside a closed shadow root, so host-page CSS cannot restyle it and
  // the page cannot reach into it. Attached inside the player rather than to
  // document.body, because in fullscreen everything outside the fullscreen element
  // is hidden. YouTube rebuilds the player on in-page navigation, so the host is
  // re-attached whenever it is found detached.

  const OVERLAY_CSS = `
    :host { all: initial; }
    .box {
      position: absolute; left: 16px; bottom: 64px; z-index: 2147483000;
      max-width: 320px; font: 12px/1.4 system-ui, sans-serif;
      background: rgba(20, 20, 20, 0.92); color: #f2f2f2;
      border-radius: 8px; padding: 8px 10px; display: none;
    }
    .box.visible { display: block; }
    .marker { padding: 4px 0; border-top: 1px solid rgba(255, 255, 255, 0.12); cursor: pointer; }
    .marker:first-child { border-top: none; }
    .time { color: #c8963e; margin-right: 6px; }
    .hint { color: #c8963e; padding: 2px 0 6px; }
  `;

  let overlayHost = null;
  let overlayBox = null;

  // YouTube puts the skip button in the player's bottom-right corner during ads.
  // The overlay lives bottom-left for that reason, and hides outright while an ad
  // plays so nothing of ours can sit between the viewer and that button.
  const isAdShowing = () =>
    Boolean(document.getElementById('movie_player')?.classList.contains('ad-showing'));
  let lastAdShowing = false;

  function overlay() {
    if (overlayHost?.isConnected) return overlayBox;

    if (!overlayHost) {
      overlayHost = document.createElement('div');
      overlayHost.id = 'fc-video-overlay-host';
      const root = overlayHost.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = OVERLAY_CSS;
      overlayBox = document.createElement('div');
      overlayBox.className = 'box';
      root.append(style, overlayBox);
    }

    const player = document.getElementById('movie_player');
    if (player) {
      player.appendChild(overlayHost);
      overlayBox.style.position = 'absolute';
      overlayBox.style.bottom = '64px'; // clear of the control bar
    } else {
      document.body.appendChild(overlayHost);
      overlayBox.style.position = 'fixed';
      overlayBox.style.bottom = '16px';
    }
    return overlayBox;
  }

  // Why nothing is being detected, when that has a cause the viewer can fix.
  const HINT_TEXT = {
    off: 'Turn on subtitles (CC), or press "Open the transcript" in the side panel.',
    none: 'No captions playing. Press "Open the transcript" in the side panel to read this video.',
  };
  let currentHint = null;

  function renderMarkers() {
    const el = overlay();
    const hintText = HINT_TEXT[currentHint];
    if (!showOverlay || isAdShowing() || (!markers.size && !hintText)) {
      el.classList.remove('visible');
      return;
    }
    el.classList.add('visible');
    el.replaceChildren(); // not innerHTML: YouTube enforces Trusted Types, which makes it throw
    if (hintText) {
      const h = document.createElement('div');
      h.className = 'hint';
      h.textContent = hintText;
      el.appendChild(h);
    }
    const recent = [...markers.entries()].slice(-4);
    for (const [id, m] of recent) {
      const row = document.createElement('div');
      row.className = 'marker';
      const time = document.createElement('span');
      time.className = 'time';
      time.textContent = fmt(m.ts);
      row.appendChild(time);
      row.appendChild(document.createTextNode(m.text.slice(0, 90) + (m.text.length > 90 ? '…' : '')));
      row.addEventListener('click', () => {
        const v = video();
        if (v) v.currentTime = m.ts;
        chrome.runtime.sendMessage({ type: MSG.HIGHLIGHT_CLICKED, claimId: id }).catch(() => {});
      });
      el.appendChild(row);
    }
  }

  // Stepping through video claims means seeking the player, ordered by timestamp
  // rather than by when each claim was found.
  let currentId = null;

  function ordered() {
    return [...markers.entries()].sort((a, b) => a[1].ts - b[1].ts);
  }

  function reportPosition(list, id) {
    const index = list.findIndex(([mid]) => mid === id);
    chrome.runtime
      .sendMessage({
        type: MSG.NAV_STATE,
        claimId: id,
        index: index === -1 ? 0 : index + 1,
        total: list.length,
      })
      .catch(() => {});
  }

  function seekTo(claimId) {
    const m = markers.get(claimId);
    const v = video();
    if (!m || !v) return;
    v.currentTime = m.ts;
    currentId = claimId;
    reportPosition(ordered(), claimId);
  }

  function navigate(direction) {
    const list = ordered();
    if (!list.length) {
      reportPosition(list, null);
      return;
    }
    const at = list.findIndex(([id]) => id === currentId);
    const next = at === -1
      ? (direction === 'prev' ? list.length - 1 : 0)
      : (direction === 'prev'
        ? (at - 1 + list.length) % list.length
        : (at + 1) % list.length);
    seekTo(list[next][0]);
  }

  // --- caption availability ---------------------------------------------------
  // With captions off, .ytp-caption-segment never appears and this script sits
  // idle, which looks like a fault. Say why instead, on the page and in the panel.
  // Reported only when the state changes, so the panel is not messaged every tick.
  // Playback is deliberately not required: a banner that vanished on every pause
  // and returned on every resume would be more distracting than helpful.

  function captionState() {
    if (!location.pathname.startsWith('/watch') || !video()) return null;
    // An open transcript panel is a source in its own right, captions on or off.
    if (document.querySelector('ytd-transcript-segment-renderer')) return 'reading';
    const btn = document.querySelector('.ytp-subtitles-button');
    // No usable button means there is no caption track to turn on.
    if (!btn || btn.getAttribute('aria-disabled') === 'true' || !btn.offsetParent) return 'none';
    return btn.getAttribute('aria-pressed') === 'false' ? 'off' : 'reading';
  }

  // Reported when the state changes, and while reading, when the scanned count
  // changes, so the panel can show that sentences are arriving even if none has
  // cleared the threshold yet. That distinguishes "nothing read" from "read,
  // nothing flagged", which otherwise look identical.
  let lastReport = '';

  function reportCaptionState() {
    const state = autoCheck ? captionState() : null;
    const scanned = sent.size;
    const key = `${state}:${state === 'reading' ? scanned : ''}`;
    if (key === lastReport) return;
    lastReport = key;
    currentHint = state;
    renderMarkers();
    chrome.runtime.sendMessage({ type: MSG.CAPTION_HINT, hint: state, scanned }).catch(() => {});
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === MSG.CLAIM_STATUS) {
      for (const c of msg.claims) {
        const prev = markers.get(c.id);
        markers.set(c.id, { ts: Number.isFinite(c.ts) ? c.ts : prev?.ts ?? now(), text: c.text });
      }
      renderMarkers();
      reportPosition(ordered(), currentId);
    } else if (msg.type === MSG.FOCUS_SENTENCE) {
      seekTo(msg.claimId);
    } else if (msg.type === MSG.NAV_CLAIM) {
      navigate(msg.direction);
    } else if (msg.type === MSG.RESCAN) {
      // Everything this script remembers about the video, so a changed threshold
      // is applied to captions and transcript alike rather than only to whatever
      // is said next.
      sent.clear();
      markers.clear();
      buffer = '';
      lastCue = '';
      currentId = null;
      lastReport = '';
      lastTranscriptCount = 0;
      english = null;
      languageReported = false;
      dropHeld();
      renderMarkers();
      readCues();
      ingestTranscript(true);
      reportCaptionState();
    } else if (msg.type === MSG.OPEN_TRANSCRIPT) {
      openTranscript();
    } else if (msg.type === MSG.SCAN_CONFIG) {
      if (msg.appearance) {
        showOverlay = msg.appearance.showVideoOverlay !== false;
        autoTranscript = msg.appearance.autoTranscript !== false;
      }
      autoCheck = msg.autoCheck && msg.scanAllowed !== false;
      // Reaching here after a language block means the user pressed the thumbs-up
      // for this site. Their yes outranks our reading of the captions.
      if (msg.scanAllowed !== false && languageReported) {
        english = true;
        languageReported = false;
        releaseHeld();
      }
      if (!autoCheck) overlay().classList.remove('visible');
      reportCaptionState();
    }
  });

  // Opening YouTube's own transcript, on request.
  //
  // Reading a video whose captions are off would ideally mean fetching the caption
  // track directly. The track URL is in the watch page and can be read from it, but
  // the endpoint it points at answers 200 with an empty body without a token the
  // player mints, so that route does not work. Tested, not assumed.
  //
  // What does work is the transcript YouTube already offers, which this script
  // reads whenever it is open. So rather than asking the viewer to find it under
  // "…more", the panel offers a button and this opens it for them. It is their own
  // page and their own click, one step further along.
  const TRANSCRIPT_BUTTONS = [
    'ytd-video-description-transcript-section-renderer button',
    'button[aria-label*="transcript" i]',
    'ytd-menu-service-item-renderer[aria-label*="transcript" i]',
  ];
  const EXPANDERS = ['tp-yt-paper-button#expand', '#description-inline-expander #expand'];

  function clickFirst(selectors) {
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el) {
        el.click();
        return true;
      }
    }
    return false;
  }

  // Opening it without being asked, when the reader has that setting on.
  //
  // Once per video, and only when the video offers a transcript of its own: the
  // description's transcript section is YouTube saying so, and without it there is
  // nothing to open. A reader who closes the panel has answered for that video, so
  // it is not reopened. Nothing here reads anything the page may not read: it waits
  // for the same permission every other read needs, and a moment after each video
  // loads, since YouTube keeps the previous video's description briefly in place.
  let autoTranscript = true;
  let transcriptTriedFor = null;
  let watchSince = Date.now();
  const AUTO_TRANSCRIPT_SETTLE_MS = 2500;

  function transcriptPanelOpen() {
    return Boolean(document.querySelector(
      'ytd-transcript-segment-renderer, '
      + '[target-id="engagement-panel-searchable-transcript"][visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"]',
    ));
  }

  function maybeOpenTranscript() {
    if (!autoTranscript || !autoCheck || !location.pathname.startsWith('/watch')) return;
    const id = new URLSearchParams(location.search).get('v');
    if (!id || transcriptTriedFor === id) return;
    if (Date.now() - watchSince < AUTO_TRANSCRIPT_SETTLE_MS) return;
    if (transcriptPanelOpen()) {
      transcriptTriedFor = id; // already open, by the reader or by YouTube
      return;
    }
    if (!document.querySelector('ytd-video-description-transcript-section-renderer button')) return;
    transcriptTriedFor = id;
    openTranscript();
  }

  function openTranscript() {
    if (document.querySelector('ytd-transcript-segment-renderer')) {
      ingestTranscript(true); // already open: just read it again
      return;
    }
    if (clickFirst(TRANSCRIPT_BUTTONS)) {
      setTimeout(() => ingestTranscript(true), 900);
      return;
    }
    // The control lives inside the collapsed description on most layouts.
    clickFirst(EXPANDERS);
    setTimeout(() => {
      clickFirst(TRANSCRIPT_BUTTONS);
      setTimeout(() => {
        attachTranscriptObserver();
        ingestTranscript(true);
        reportCaptionState();
      }, 900);
    }, 400);
  }

  // --- transcript panel -------------------------------------------------------
  // When the viewer opens YouTube's transcript, its segments are already in the
  // page: timestamped, and punctuated for uploader captions. Reading them covers
  // the whole video at once, and reacting the moment the panel appears is what
  // makes opening it feel like it did something.

  let transcriptObserver = null;
  let observedTranscript = null;
  let lastTranscriptCount = 0;
  let transcriptTimer = null;

  function parseTimestamp(text) {
    const parts = (text || '').trim().split(':').map(Number);
    if (!parts.length || parts.some(Number.isNaN)) return 0;
    return parts.reduce((acc, n) => acc * 60 + n, 0);
  }

  function ingestTranscript(force = false) {
    if (checkVideoNavigation() || !autoCheck) return;
    const nodes = document.querySelectorAll('ytd-transcript-segment-renderer');
    if (!nodes.length) return;
    if (!force && nodes.length === lastTranscriptCount) return;
    lastTranscriptCount = nodes.length;

    // Segments are cue-sized fragments. Group them until one ends a sentence, or
    // by length for auto-transcripts that carry no punctuation at all.
    let group = [];
    let words = 0;
    const flush = () => {
      if (!group.length) return;
      ship(FCSegment.splitSentences(group.map((g) => g.text).join(' ')), group[0].ts);
      group = [];
      words = 0;
    };
    for (const node of nodes) {
      const text = (node.querySelector('.segment-text')?.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      group.push({ text, ts: parseTimestamp(node.querySelector('.segment-timestamp')?.textContent) });
      words += text.split(' ').length;
      if (/[.!?]["')\]]?$/.test(text) || words >= 40) flush();
    }
    if (words >= 8) flush();
  }

  function attachTranscriptObserver() {
    const panel = document.querySelector('ytd-transcript-renderer, ytd-transcript-search-panel-renderer');
    if (!panel) return;
    if (panel === observedTranscript && panel.isConnected) return;
    detachTranscriptObserver();
    transcriptObserver = new MutationObserver(() => {
      // The panel renders in bursts; ingest once they settle.
      clearTimeout(transcriptTimer);
      transcriptTimer = setTimeout(() => { if (autoCheck) ingestTranscript(true); }, 250);
    });
    transcriptObserver.observe(panel, { childList: true, subtree: true });
    observedTranscript = panel;
    if (autoCheck) ingestTranscript(true);
  }

  function detachTranscriptObserver() {
    transcriptObserver?.disconnect();
    transcriptObserver = null;
    observedTranscript = null;
    clearTimeout(transcriptTimer);
  }

  // --- caption observer -------------------------------------------------------
  // At 1.5x or 2x playback a cue can appear and vanish between one-second polls,
  // losing claims or fragmenting sentences. Observing the caption container reacts
  // to each change as it happens; the poll stays as the fallback. The container
  // only exists while captions are on, and YouTube rebuilds it on navigation, so
  // attachment is re-checked every tick and re-done whenever it is found detached.

  let cueObserver = null;
  let observedContainer = null;

  function attachCaptionObserver() {
    const container = document.querySelector('.ytp-caption-window-container');
    if (!container) return;
    if (container === observedContainer && container.isConnected) return;
    detachCaptionObserver();
    cueObserver = new MutationObserver(() => {
      if (autoCheck) readCues();
    });
    cueObserver.observe(container, { childList: true, subtree: true, characterData: true });
    observedContainer = container;
  }

  function detachCaptionObserver() {
    cueObserver?.disconnect();
    cueObserver = null;
    observedContainer = null;
  }

  // YouTube navigates between videos without reloading the document, so reset the
  // caption buffer and markers whenever the watch URL changes.
  let lastUrl = location.href.split('#')[0];
  function onPageChanged() {
    autoCheck = false;
    watchSince = Date.now();
    english = null;
    languageReported = false;
    dropHeld();
    buffer = '';
    lastCue = '';
    sent.clear();
    markers.clear();
    currentId = null;
    lastReport = '';
    lastTranscriptCount = 0;
    detachCaptionObserver();
    detachTranscriptObserver();
    renderMarkers();
    chrome.runtime
      .sendMessage({ type: MSG.PAGE_CHANGED, url: location.href })
      .then(() => askVideoPolicy())
      .catch(() => {});
  }

  function askVideoPolicy(attempt = 0) {
    const url = location.href.split('#')[0];
    chrome.runtime.sendMessage({ type: MSG.GET_STATE, docId }).then((res) => {
      if (url !== location.href.split('#')[0]) return;
      if (!res) throw new Error('no policy answer');
      autoCheck = Boolean(res.autoCheck) && res.scanAllowed === true;
      if (res.appearance) {
        showOverlay = res.appearance.showVideoOverlay !== false;
        autoTranscript = res.appearance.autoTranscript !== false;
      }
    }).catch(() => { if (attempt < 1) setTimeout(() => askVideoPolicy(attempt + 1), 400); });
  }

  function checkVideoNavigation() {
    const next = location.href.split('#')[0];
    if (next === lastUrl) return false;
    lastUrl = next;
    onPageChanged();
    return true;
  }

  // Polling backs up the caption observers; permission is required before reading.
  setInterval(() => {
    checkVideoNavigation();
    // Redraw when an ad starts or ends, so the overlay leaves and returns with it.
    const ad = isAdShowing();
    if (ad !== lastAdShowing) {
      lastAdShowing = ad;
      renderMarkers();
    }
    attachCaptionObserver();
    attachTranscriptObserver();
    if (autoCheck) {
      readCues(); // fallback in case a mutation was coalesced away
      ingestTranscript(); // cheap when the count is unchanged
    }
    maybeOpenTranscript();
    // A video with very few captions would otherwise hold its first sentences for
    // ever waiting for a sample that never arrives.
    if (english === null && heldSince && Date.now() - heldSince >= LANG_HOLD_MS) {
      decideLanguage(true);
    }
    reportCaptionState();
  }, 1000);

  askVideoPolicy();
})();
