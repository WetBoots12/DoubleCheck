// Article/text mode: extract visible prose, segment into sentences, send to the
// background worker, and highlight whatever comes back flagged.
// Content scripts can't use ES imports, so the message constants are inlined.

(() => {
  const MSG = {
    SENTENCES: 'sentences',
    HIGHLIGHT_CLICKED: 'highlightClicked',
    GET_STATE: 'getState',
    PAGE_CHANGED: 'pageChanged',
    SCAN_CONFIG: 'scanConfig',
    CLAIM_STATUS: 'claimStatus',
    FOCUS_SENTENCE: 'focusSentence',
  };

  let autoCheck = true;
  const sent = new Set(); // sentence keys already shipped to the worker
  const highlighted = new Set(); // claim ids already drawn

  function key(text) {
    return text.trim().toLowerCase();
  }

  // Largest cluster of paragraph text wins — good enough without a readability lib.
  function contentRoot() {
    const candidates = document.querySelectorAll('article, main, [role="main"], .post, .article-body');
    let best = null;
    let bestLen = 0;
    for (const el of candidates) {
      const len = el.innerText?.length || 0;
      if (len > bestLen) {
        best = el;
        bestLen = len;
      }
    }
    return bestLen > 500 ? best : document.body;
  }

  // Many news sites (Reuters among them) put article paragraphs in divs with a
  // data-testid rather than in <p>, so matching only <p> missed the entire body.
  // Instead, take any block-level element that has no block-level child — the leaf
  // blocks that actually hold prose.
  const BLOCK = 'p, li, blockquote, h1, h2, h3, div, section, article, [data-testid]';

  // Chrome, player chrome, and dialogs produce long strings that look like text but
  // are controls ("Auto480p1080p720p", font pickers, menus).
  const EXCLUDE = [
    'nav', 'header', 'footer', 'aside', 'form',
    '[role="menu"]', '[role="menubar"]', '[role="dialog"]',
    '[class*="player"]', '[class*="Player"]',
    '[class*="video"]', '[class*="Video"]',
    '[class*="menu"]', '[class*="Menu"]',
    '[class*="nav"]', '[class*="Nav"]',
    '[aria-hidden="true"]',
  ].join(', ');

  function visibleParagraphs(root) {
    const out = [];
    const seen = new Set();
    for (const el of root.querySelectorAll(BLOCK)) {
      if (el.closest(EXCLUDE)) continue;
      if (el.closest('.fc-highlight')) continue;
      if (el.querySelector(BLOCK)) continue; // not a leaf block
      if (!el.offsetParent && el.tagName !== 'BODY') continue; // not rendered
      const text = el.innerText?.trim();
      if (!text || text.length <= 40) continue;
      if (text.split(/\s+/).length < 8) continue; // control labels, not prose
      const k = text.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(text);
    }
    return out;
  }

  function segment(text) {
    return text
      .replace(/\s+/g, ' ')
      .split(/(?<=[.!?])\s+(?=[A-Z"'(])/)
      .map((s) => s.trim())
      .filter((s) => s.length > 30);
  }

  function collect() {
    if (!autoCheck) return;
    const root = contentRoot();
    const batch = [];
    for (const para of visibleParagraphs(root)) {
      for (const s of segment(para)) {
        const k = key(s);
        if (sent.has(k)) continue;
        sent.add(k);
        batch.push({ id: `c${sent.size}_${Date.now().toString(36)}`, text: s });
      }
    }
    if (batch.length) {
      chrome.runtime.sendMessage({ type: MSG.SENTENCES, sentences: batch }).catch(() => {});
    }
  }

  // --- highlighting ---------------------------------------------------------

  function highlight(claim) {
    const existing = document.querySelector(`[data-fc-id="${claim.id}"]`);
    if (existing) {
      existing.dataset.fcStatus = claim.status;
      return;
    }
    if (highlighted.has(claim.id)) return;

    const needle = claim.text.trim();
    const walker = document.createTreeWalker(contentRoot(), NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || node.nodeValue.length < 30) return NodeFilter.FILTER_REJECT;
        if (node.parentElement?.closest('.fc-highlight, script, style')) return NodeFilter.FILTER_REJECT;
        return node.nodeValue.includes(needle) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });

    const node = walker.nextNode();
    if (!node) return;

    const idx = node.nodeValue.indexOf(needle);
    const range = document.createRange();
    range.setStart(node, idx);
    range.setEnd(node, idx + needle.length);

    const span = document.createElement('span');
    span.className = 'fc-highlight';
    span.dataset.fcId = claim.id;
    span.dataset.fcStatus = claim.status;
    span.title = 'FactCheck: click to open this claim in the side panel';
    span.addEventListener('click', () => {
      chrome.runtime
        .sendMessage({ type: MSG.HIGHLIGHT_CLICKED, claimId: claim.id })
        .catch(() => {});
    });

    try {
      range.surroundContents(span);
      highlighted.add(claim.id);
    } catch {
      // Range crossed element boundaries — skip rather than restructure the page.
    }
  }

  function focus(claimId) {
    const el = document.querySelector(`[data-fc-id="${claimId}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('fc-focused');
    setTimeout(() => el.classList.remove('fc-focused'), 1600);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === MSG.CLAIM_STATUS) msg.claims.forEach(highlight);
    else if (msg.type === MSG.FOCUS_SENTENCE) focus(msg.claimId);
    else if (msg.type === MSG.SCAN_CONFIG) {
      autoCheck = msg.autoCheck;
      if (autoCheck) collect();
    }
  });

  // --- lifecycle ------------------------------------------------------------

  let timer = null;
  const debouncedCollect = () => {
    clearTimeout(timer);
    timer = setTimeout(collect, 800);
  };

  // Same document, new page: reset local state so the new page is scanned from
  // scratch, and tell the worker to drop the old page's claims.
  function onPageChanged() {
    sent.clear();
    highlighted.clear();
    chrome.runtime
      .sendMessage({ type: MSG.PAGE_CHANGED, url: location.href })
      .catch(() => {});
    setTimeout(collect, 900); // let the new view render first
  }

  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      onPageChanged();
    }
  }, 1000);

  // Scanning must not depend on this round trip succeeding. A Manifest V3 service
  // worker that is asleep or mid-restart can reject it, and gating setup on the
  // reply used to kill scanning on the page silently and permanently.
  new MutationObserver(debouncedCollect).observe(document.body, {
    childList: true,
    subtree: true,
  });
  collect();

  chrome.runtime
    .sendMessage({ type: MSG.GET_STATE })
    .then((res) => {
      autoCheck = res?.autoCheck ?? true;
      if (autoCheck) collect();
    })
    .catch(() => {}); // default (on) already applied
})();
