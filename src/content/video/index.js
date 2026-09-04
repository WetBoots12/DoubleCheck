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
  };

  let autoCheck = true;
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
    if (batch.length) {
      chrome.runtime.sendMessage({ type: MSG.SENTENCES, sentences: batch }).catch(() => {});
    }
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
    off: 'Turn on subtitles (CC) to detect claims in this video.',
    none: 'No captions on this video. If it has a transcript, open it (…more, then Show transcript).',
  };
  let currentHint = null;

  function renderMarkers() {
    const el = overlay();
    const hintText = HINT_TEXT[currentHint];
    if (isAdShowing() || (!markers.size && !hintText)) {
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
        markers.set(c.id, { ts: prev?.ts ?? now(), text: c.text });
      }
      renderMarkers();
      reportPosition(ordered(), currentId);
    } else if (msg.type === MSG.FOCUS_SENTENCE) {
      seekTo(msg.claimId);
    } else if (msg.type === MSG.NAV_CLAIM) {
      navigate(msg.direction);
    } else if (msg.type === MSG.SCAN_CONFIG) {
      autoCheck = msg.autoCheck && msg.scanAllowed !== false;
      if (!autoCheck) overlay().classList.remove('visible');
      reportCaptionState();
    }
  });

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
  let lastUrl = location.href;
  function onPageChanged() {
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
      .catch(() => {});
    // The new URL may fall under a different rule; ask again.
    chrome.runtime
      .sendMessage({ type: MSG.GET_STATE })
      .then((res) => { autoCheck = (res?.autoCheck ?? true) && res?.scanAllowed !== false; })
      .catch(() => {});
  }

  // Reading cues must not depend on the settings round trip succeeding; a sleeping
  // service worker can reject it, which used to stop the video script permanently.
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      onPageChanged();
    }
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
    reportCaptionState();
  }, 1000);

  chrome.runtime
    .sendMessage({ type: MSG.GET_STATE })
    .then((res) => {
      autoCheck = (res?.autoCheck ?? true) && res?.scanAllowed !== false;
    })
    .catch(() => {}); // default (on) already applied
})();
