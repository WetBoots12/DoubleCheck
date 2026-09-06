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
    NAV_CLAIM: 'navClaim',
    NAV_STATE: 'navState',
    UNLOCATED: 'unlocated',
    PAGE_PRIVATE: 'pagePrivate',
    PAGE_LANGUAGE: 'pageLanguage',
    PAGE_SOURCES: 'pageSources',
    RESCAN: 'rescan',
    PAGE_META: 'pageMeta',
  };

  // How the highlights look. Computed by the worker, which can import the shared
  // module; this script only applies what it is given. Every value has a fallback in
  // highlight.css, so a page rendered before this arrives still looks right.
  function applyAppearance(look) {
    if (!look) return;
    const root = document.documentElement;
    for (const [name, value] of Object.entries(look.vars || {})) {
      root.style.setProperty(name, value);
    }
    if (look.style) root.setAttribute('data-fc-style', look.style);
  }

  let autoCheck = true;
  let scanAllowed = true; // the worker's verdict on this page's URL
  let privateFieldsReported = false;
  let languageReported = false;
  // Set when the user presses the thumbs-up on this site: their explicit yes
  // outranks our guess about the language.
  let languageOverride = false;
  const sent = new Set(); // sentence keys already shipped to the worker

  // A password or card field marks a private page whatever its domain: login
  // screens and checkouts on sites that are otherwise fine to scan.
  function hasPrivateFields() {
    return Boolean(document.querySelector('input[type="password"], input[autocomplete^="cc-"]'));
  }
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
    'nav', 'header', 'footer', 'aside', 'form', 'dialog',
    '[role="menu"]', '[role="menubar"]', '[role="dialog"]', '[aria-modal="true"]',
    '[role="banner"]', '[role="complementary"]', '[role="contentinfo"]', '[role="navigation"]',
    // Newsletter boxes, paywalls, cookie notices, recommendation rails, share bars:
    // sentence-shaped text that is not the article. Matched below the content root
    // only, so a site-wide class cannot exclude a whole page.
    '[class*="newsletter"]', '[id*="newsletter"]',
    '[class*="subscri"]', '[class*="signup"]', '[class*="sign-up"]',
    '[class*="promo"]', '[class*="paywall"]', '[class*="cookie"]', '[class*="consent"]',
    '[class*="advert"]', '[class*="sponsor"]',
    '[class*="sidebar"]', '[class*="footer"]', '[class*="related"]', '[class*="recommend"]',
    '[class*="share"]', '[class*="social"]', '[class*="breadcrumb"]', '[class*="toolbar"]',
    '[class*="comments"]', '[id*="comments"]',
    '[class*="player"]', '[class*="Player"]',
    '[class*="video"]', '[class*="Video"]',
    '[class*="menu"]', '[class*="Menu"]',
    '[class*="nav"]', '[class*="Nav"]',
    '[aria-hidden="true"]',
  ].join(', ');

  // closest() walks all the way to <html>, and site-wide classes routinely contain
  // these substrings — Wikipedia's <html> carries "vector-feature-main-menu-pinned",
  // whose "menu" matched and excluded every paragraph on the page. Only consider
  // ancestors below the content root, and never the document's own root elements.
  // Measured once per scan: the exclusion rules are relative to how much of the
  // article a region holds, and asking every ancestor for its own text length would
  // walk the same subtrees hundreds of times.
  let rootChars = 0;

  function inExcludedRegion(el, root) {
    for (let node = el; node && node !== root; node = node.parentElement) {
      if (node === document.body || node === document.documentElement) break;
      // A class name is weak evidence. Fox News wraps stories in
      // <article class="article-wrap has-video">, and "has-video" matched the player
      // rule, so every paragraph of every story with a video in it was discarded.
      // A region holding most of the article is the article, whatever it calls
      // itself; only a small region is really furniture. See content/regions.js.
      if (node.matches(EXCLUDE) && FCRegions.isSideRegion(node.innerText?.length, rootChars)) {
        return true;
      }
    }
    return false;
  }

  function visibleParagraphs(root) {
    const out = [];
    const seen = new Set();
    rootChars = root.innerText?.length || 0;
    for (const el of root.querySelectorAll(BLOCK)) {
      if (inExcludedRegion(el, root)) continue;
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

  // Shared with the video script; see src/content/segment.js.
  // Who actually wrote this page.
  //
  // An article read on a news portal was frequently written by a wire service, and
  // the wire's own copy of it is not independent corroboration: quoting Reuters back
  // at a Reuters story that a portal republished is circular. Excluding only the
  // domain in the address bar misses that entirely.
  //
  // Three signals, all of them things publishers put on the page themselves:
  // the canonical link, the Open Graph URL, and the credit line wire services
  // require in the opening paragraph.
  const WIRE_CREDITS = [
    [/\(Reuters\)|\bReuters\b\s*[—-]/i, 'reuters.com'],
    [/\(AP\)|\bAssociated Press\b/i, 'apnews.com'],
    [/\(AFP\)|\bAgence France-Presse\b/i, 'afp.com'],
    [/\(Bloomberg\)/i, 'bloomberg.com'],
    [/\(PA Media\)|\bPress Association\b/i, 'pamediagroup.com'],
  ];

  function hostOf(url) {
    try {
      return new URL(url, location.href).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      return '';
    }
  }

  function publisherDomains(root) {
    const found = new Set();
    const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href');
    const ogUrl = document.querySelector('meta[property="og:url"]')?.getAttribute('content');
    for (const candidate of [canonical, ogUrl]) {
      const host = candidate ? hostOf(candidate) : '';
      if (host && host !== location.hostname.replace(/^www\./, '')) found.add(host);
    }

    // The credit line, which is only trusted near the top of the article.
    const opening = (root?.innerText || '').slice(0, 600);
    for (const [pattern, domain] of WIRE_CREDITS) {
      if (pattern.test(opening)) found.add(domain);
    }
    return [...found];
  }

  let reportedPublishers = '';

  function reportPublishers(root) {
    const domains = publisherDomains(root);
    const key = domains.join(',');
    if (key === reportedPublishers) return;
    reportedPublishers = key;
    chrome.runtime.sendMessage({ type: MSG.PAGE_SOURCES, domains }).catch(() => {});
  }

  function segment(text) {
    return FCSegment.splitSentences(text, 30);
  }

  function collect() {
    if (!autoCheck || !scanAllowed) return;
    if (hasPrivateFields()) {
      scanAllowed = false;
      if (!privateFieldsReported) {
        privateFieldsReported = true;
        chrome.runtime.sendMessage({ type: MSG.PAGE_PRIVATE, reason: 'fields' }).catch(() => {});
      }
      return;
    }
    const root = contentRoot();

    // The classifier's vocabulary is English. On a French or German page it does
    // not fail, it scores erratically, so say so and stay out of the way. The
    // check leans towards scanning: see content/language.js.
    if (!languageOverride) {
      const verdict = FCLanguage.detect(
        document.documentElement.getAttribute('lang'),
        (root.innerText || '').slice(0, 4000),
      );
      if (!verdict.english) {
        scanAllowed = false;
        if (!languageReported) {
          languageReported = true;
          chrome.runtime
            .sendMessage({ type: MSG.PAGE_LANGUAGE, language: verdict.language })
            .catch(() => {});
        }
        return;
      }
    }

    reportPublishers(root);

    const batch = [];
    for (const para of visibleParagraphs(root)) {
      for (const s of segment(para)) {
        // Calls to action and legal lines survive the container rules on some sites.
        if (FCSegment.isBoilerplate(s)) continue;
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

  function textNodesIn(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
        if (node.parentElement?.closest('script, style, .fc-highlight')) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    let node;
    while ((node = walker.nextNode())) nodes.push(node);
    return nodes;
  }

  function makeSpan(claim) {
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
    return span;
  }

  // A sentence often crosses several text nodes, because links and bold phrases
  // split it. Wrapping the whole span at once throws in that case, which used to
  // silently drop the claim; wrap each node's portion separately instead.
  function highlight(claim) {
    const existing = document.querySelectorAll(`[data-fc-id="${claim.id}"]`);
    if (existing.length) {
      for (const el of existing) el.dataset.fcStatus = claim.status;
      return true;
    }

    const nodes = textNodesIn(contentRoot());
    const plan = FCTextMatch.buildMatchPlan(nodes.map((n) => n.nodeValue), claim.text);
    if (!plan) return false;

    // Back to front, so wrapping one node cannot shift offsets in an earlier one.
    let wrapped = 0;
    for (const part of [...plan].reverse()) {
      const node = nodes[part.nodeIndex];
      if (!node || part.end > node.nodeValue.length) continue;
      const range = document.createRange();
      range.setStart(node, part.start);
      range.setEnd(node, part.end);
      try {
        range.surroundContents(makeSpan(claim));
        wrapped++;
      } catch {
        // A node detached or changed under us; the remaining parts still stand.
      }
    }

    if (wrapped) highlighted.add(claim.id);
    return wrapped > 0;
  }

  // --- find-bar navigation --------------------------------------------------
  // Ordered by position in the document, not by when each claim was discovered,
  // so stepping through them reads top to bottom the way Ctrl+F does.

  let currentId = null;

  // One claim can own several spans now, so keep only the first span of each claim.
  // That first span is also the one to scroll to.
  function orderedHighlights() {
    const seen = new Set();
    const out = [];
    for (const el of document.querySelectorAll('.fc-highlight')) {
      const id = el.dataset.fcId;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(el);
    }
    return out;
  }

  function spansOf(claimId) {
    return document.querySelectorAll(`.fc-highlight[data-fc-id="${claimId}"]`);
  }

  function reportPosition(list, el) {
    chrome.runtime
      .sendMessage({
        type: MSG.NAV_STATE,
        claimId: el ? el.dataset.fcId : null,
        index: el ? list.indexOf(el) + 1 : 0,
        total: list.length,
      })
      .catch(() => {});
  }

  function setCurrent(el, list = orderedHighlights()) {
    for (const other of document.querySelectorAll('.fc-current')) {
      other.classList.remove('fc-current');
    }
    if (!el) {
      currentId = null;
      reportPosition(list, null);
      return;
    }
    currentId = el.dataset.fcId;
    // Every span belonging to this claim lights up, not only the first fragment.
    for (const span of spansOf(currentId)) span.classList.add('fc-current');
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    reportPosition(list, el);
  }

  function navigate(direction) {
    const list = orderedHighlights();
    if (!list.length) {
      setCurrent(null, list);
      return;
    }
    const at = list.findIndex((el) => el.dataset.fcId === currentId);
    let next;
    if (at === -1) {
      next = direction === 'prev' ? list.length - 1 : 0;
    } else {
      // Wraps at both ends, again matching find-in-page behavior.
      next = direction === 'prev'
        ? (at - 1 + list.length) % list.length
        : (at + 1) % list.length;
    }
    setCurrent(list[next], list);
  }

  function focus(claimId) {
    const list = orderedHighlights();
    const el = list.find((n) => n.dataset.fcId === claimId);
    if (el) setCurrent(el, list);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    // How the page describes itself, for a citation the reader asked to keep.
    //
    // The head is where a publisher declares its author, its real title and its own
    // name, and reading it from the live document beats parsing fetched HTML because
    // this is what the page actually rendered. Bounded, and only the head: the body
    // is the article, and the article is not wanted here.
    if (msg.type === MSG.PAGE_META) {
      sendResponse({
        head: (document.head?.outerHTML || '').slice(0, 200000),
        title: document.title || '',
        url: location.href,
      });
      return true;
    }

    if (msg.type === MSG.CLAIM_STATUS) {
      // Report which claims could not be placed, so the panel can say so instead of
      // leaving the user hunting for a highlight that was never drawn.
      const missing = msg.claims.filter((c) => !highlight(c)).map((c) => c.id);
      if (missing.length) {
        chrome.runtime.sendMessage({ type: MSG.UNLOCATED, ids: missing }).catch(() => {});
      }
      // A newly drawn highlight changes the total shown in the find bar.
      reportPosition(orderedHighlights(), document.querySelector('.fc-current'));
    } else if (msg.type === MSG.FOCUS_SENTENCE) focus(msg.claimId);
    else if (msg.type === MSG.NAV_CLAIM) navigate(msg.direction);
    else if (msg.type === MSG.RESCAN) rescan();
    else if (msg.type === MSG.SCAN_CONFIG) {
      applyAppearance(msg.appearance);
      autoCheck = msg.autoCheck;
      if (msg.scanAllowed !== undefined) {
        scanAllowed = msg.scanAllowed;
        if (scanAllowed) {
          privateFieldsReported = false;
          // Reaching here after a language block means the user asked for this site
          // to be scanned. Take them at their word for as long as the page lasts.
          if (languageReported) languageOverride = true;
          languageReported = false;
        }
      }
      if (autoCheck && scanAllowed) collect();
    }
  });

  // --- lifecycle ------------------------------------------------------------

  // Wait for the page to settle, but never wait forever: a live blog or a ticker
  // mutates without pause, and a plain debounce would then never scan at all.
  const debouncedCollect = FCMutations.createScheduler(collect, {
    quietMs: 800,
    maxWaitMs: 5000,
  });

  // Same document, new page: reset local state so the new page is scanned from
  // scratch, and tell the worker to drop the old page's claims.
  // Reading the page again from scratch, for when the settings changed under it.
  //
  // The highlights have to come out of the DOM first. They are real spans wrapped
  // around parts of text nodes, and leaving them there would both show claims that
  // no longer pass the threshold and split the text so the same sentences could not
  // be matched again. Unwrapping and normalizing puts the page back as it was.
  function clearHighlights() {
    for (const span of document.querySelectorAll('.fc-highlight')) {
      const parent = span.parentNode;
      if (!parent) continue;
      span.replaceWith(...span.childNodes);
      parent.normalize(); // re-join the text nodes the wrapping split
    }
    highlighted.clear();
    currentId = null;
  }

  function rescan() {
    clearHighlights();
    sent.clear();
    privateFieldsReported = false;
    languageReported = false;
    reportedPublishers = '';
    // languageOverride is not reset: the user pressing the thumbs-up on this site
    // is a decision about the site, not about this particular scan.
    chrome.runtime
      .sendMessage({ type: MSG.GET_STATE })
      .then((res) => {
        autoCheck = res?.autoCheck ?? autoCheck;
        scanAllowed = res?.scanAllowed !== false;
        applyAppearance(res?.appearance);
        collect();
      })
      // A sleeping worker must not stop a rescan, but it must not turn a "no" into
      // a "yes" either: without an answer, whatever was decided before stands.
      .catch(() => { if (scanAllowed) collect(); });
  }

  function onPageChanged() {
    sent.clear();
    highlighted.clear();
    currentId = null;
    privateFieldsReported = false;
    languageReported = false;
    languageOverride = false;
    reportedPublishers = '';

    // The verdict belonged to the old address. Until the worker has judged the new
    // one this page has no permission, so it is not read: a reader who clicks from
    // an article straight into their billing page, which is one history.pushState
    // and no document load, must not have that page read while the answer is still
    // in flight. The worker refuses anything sent from a blocked page in any case,
    // but refusing here means the page is never read at all, which is what the
    // guide promises and what the first-load path already does.
    scanAllowed = false;

    chrome.runtime
      .sendMessage({ type: MSG.PAGE_CHANGED, url: location.href })
      .catch(() => {});
    askPolicy();
    setTimeout(() => { if (scanAllowed) collect(); }, 900); // let the new view render first
  }

  // Ask whether this address may be read, and read it if the answer is yes. Retried
  // once: the answer is now the only thing that permits any reading, so losing it to
  // a worker that was asleep when the message arrived would silence the page.
  function askPolicy(attempt = 0) {
    chrome.runtime
      .sendMessage({ type: MSG.GET_STATE })
      .then((res) => {
        if (!res) throw new Error('no answer');
        autoCheck = res.autoCheck ?? autoCheck;
        scanAllowed = res.scanAllowed !== false;
        applyAppearance(res.appearance);
        if (scanAllowed && autoCheck) collect();
      })
      .catch(() => { if (attempt < 1) setTimeout(() => askPolicy(attempt + 1), 400); });
  }

  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      onPageChanged();
    }
  }, 1000);

  // Ask whether this page may be read at all, and wait a moment for the answer.
  //
  // Two failures to avoid at once. Gating scanning on this round trip permanently
  // killed the extension on a page whenever a sleeping service worker rejected it.
  // Ignoring the round trip entirely meant a never-scan page was read locally first
  // and refused afterwards. So: a short wait for the answer, then scan regardless.
  // The worker refuses anything from a blocked page in any case, and the wait means
  // that on a bank or a medical portal the page is usually never read at all.
  const POLICY_WAIT_MS = 1200;
  let firstScan = null;

  function firstCollect() {
    if (firstScan) return;
    firstScan = true;
    collect();
  }
  // Scanning is the expensive half, so a mutation only schedules one when it
  // actually brought reading material with it. The observer stays on document.body
  // rather than narrowing to contentRoot(): the pages that mutate hardest are
  // infinite feeds that append whole articles as siblings of the one being read,
  // and an observer scoped to the current article would go quiet exactly there.
  setTimeout(firstCollect, POLICY_WAIT_MS); // no answer in time: read it anyway

  new MutationObserver((records) => {
    const worth = FCMutations.worthScanning(records, {
      isExcluded: (node) => inExcludedRegion(node, document.body),
      isOurs: (node) => node.classList?.contains('fc-highlight') || Boolean(node.closest?.('.fc-highlight')),
    });
    if (worth) debouncedCollect();
  }).observe(document.body, {
    childList: true,
    subtree: true,
  });
  chrome.runtime
    .sendMessage({ type: MSG.GET_STATE })
    .then((res) => {
      autoCheck = res?.autoCheck ?? true;
      scanAllowed = res?.scanAllowed !== false;
      applyAppearance(res?.appearance);
      if (!scanAllowed) {
        firstScan = true; // a "no" arrived first: never read this page
        return;
      }
      if (autoCheck) firstCollect();
    })
    .catch(() => {}); // the timeout above still runs the first scan
})();
