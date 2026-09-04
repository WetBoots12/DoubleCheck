// Video mode (YouTube): read caption cues as they render, group them into sentences,
// and show flagged claims as timestamped markers near the player. No audio processing —
// if a video has no captions, this script does nothing.

(() => {
  const MSG = {
    SENTENCES: 'sentences',
    HIGHLIGHT_CLICKED: 'highlightClicked',
    GET_STATE: 'getState',
    SCAN_CONFIG: 'scanConfig',
    CLAIM_STATUS: 'claimStatus',
    FOCUS_SENTENCE: 'focusSentence',
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

    // Flush complete sentences out of the rolling buffer.
    const parts = buffer.split(/(?<=[.!?])\s+/);
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

  function overlay() {
    let el = document.getElementById('fc-video-overlay');
    if (!el) {
      el = document.createElement('div');
      el.id = 'fc-video-overlay';
      document.body.appendChild(el);
    }
    return el;
  }

  function renderMarkers() {
    const el = overlay();
    if (!markers.size) {
      el.classList.remove('fc-visible');
      return;
    }
    el.classList.add('fc-visible');
    el.innerHTML = '';
    const recent = [...markers.entries()].slice(-4);
    for (const [id, m] of recent) {
      const row = document.createElement('div');
      row.className = 'fc-marker';
      row.innerHTML = `<span class="fc-time">${fmt(m.ts)}</span>`;
      row.appendChild(document.createTextNode(m.text.slice(0, 90) + (m.text.length > 90 ? '…' : '')));
      row.addEventListener('click', () => {
        const v = video();
        if (v) v.currentTime = m.ts;
        chrome.runtime.sendMessage({ type: MSG.HIGHLIGHT_CLICKED, claimId: id }).catch(() => {});
      });
      el.appendChild(row);
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === MSG.CLAIM_STATUS) {
      for (const c of msg.claims) {
        const prev = markers.get(c.id);
        markers.set(c.id, { ts: prev?.ts ?? now(), text: c.text });
      }
      renderMarkers();
    } else if (msg.type === MSG.FOCUS_SENTENCE) {
      const m = markers.get(msg.claimId);
      const v = video();
      if (m && v) v.currentTime = m.ts;
    } else if (msg.type === MSG.SCAN_CONFIG) {
      autoCheck = msg.autoCheck;
      if (!autoCheck) overlay().classList.remove('fc-visible');
    }
  });

  chrome.runtime
    .sendMessage({ type: MSG.GET_STATE })
    .then((res) => {
      autoCheck = res?.autoCheck ?? true;
      setInterval(() => {
        if (autoCheck) readCues();
      }, 1000);
    })
    .catch(() => {});
})();
