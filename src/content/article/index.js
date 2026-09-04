// Article/text mode: extract visible prose, segment into sentences, send to the
// background worker, and highlight whatever comes back flagged.
// Content scripts can't use ES imports, so the message constants are inlined.

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

  const SKIP = /^(nav|header|footer|aside|script|style|noscript|button|form|figcaption)$/i;

  function visibleParagraphs(root) {
    const out = [];
    for (const p of root.querySelectorAll('p, li, blockquote, h1, h2, h3')) {
      if (p.closest('nav, header, footer, aside')) continue;
      if (SKIP.test(p.tagName)) continue;
      if (p.closest('.fc-highlight')) continue;
      const text = p.innerText?.trim();
      if (text && text.length > 40) out.push(text);
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

  chrome.runtime.sendMessage({ type: MSG.GET_STATE }).then((res) => {
    autoCheck = res?.autoCheck ?? true;
    if (!autoCheck) return;
    collect();
    new MutationObserver(debouncedCollect).observe(document.body, {
      childList: true,
      subtree: true,
    });
  }).catch(() => {});
})();
