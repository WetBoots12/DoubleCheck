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
      position: absolute; right: 16px; bottom: 64px; z-index: 2147483000;
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
    none: 'This video has no captions, so no claims can be detected.',
  };
  let currentHint = null;

  function renderMarkers() {
    const el = overlay();
    const hintText = HINT_TEXT[currentHint];
    if (!markers.size && !hintText) {
      el.classList.remove('visible');
      return;
    }
    el.classList.add('visible');
    el.innerHTML = '';
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
      row.innerHTML = `<span class="time">${fmt(m.ts)}</span>`;
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
    const btn = document.querySelector('.ytp-subtitles-button');
    // No usable button means there is no caption track to turn on.
    if (!btn || btn.getAttribute('aria-disabled') === 'true' || !btn.offsetParent) return 'none';
    return btn.getAttribute('aria-pressed') === 'false' ? 'off' : null;
  }

  let lastHint; // undefined until first reported, so the first tick clears any stale banner

  function reportCaptionState() {
    const state = autoCheck ? captionState() : null;
    if (state === lastHint) return;
    lastHint = state;
    currentHint = state;
    renderMarkers();
    chrome.runtime.sendMessage({ type: MSG.CAPTION_HINT, hint: state }).catch(() => {});
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
      autoCheck = msg.autoCheck;
      if (!autoCheck) overlay().classList.remove('visible');
      reportCaptionState();
    }
  });

  // YouTube navigates between videos without reloading the document, so reset the
  // caption buffer and markers whenever the watch URL changes.
  let lastUrl = location.href;
  function onPageChanged() {
    buffer = '';
    lastCue = '';
    sent.clear();
    markers.clear();
    currentId = null;
    lastHint = undefined;
    renderMarkers();
    chrome.runtime
      .sendMessage({ type: MSG.PAGE_CHANGED, url: location.href })
      .catch(() => {});
  }

  // Reading cues must not depend on the settings round trip succeeding; a sleeping
  // service worker can reject it, which used to stop the video script permanently.
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      onPageChanged();
    }
    if (autoCheck) readCues();
    reportCaptionState();
  }, 1000);

  chrome.runtime
    .sendMessage({ type: MSG.GET_STATE })
    .then((res) => {
      autoCheck = res?.autoCheck ?? true;
    })
    .catch(() => {}); // default (on) already applied
})();
