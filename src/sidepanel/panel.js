import { MSG, STATUS, getSettings } from '../shared/messages.js';
import { getLlmProvider } from '../providers/index.js';
import { ratingTone } from '../shared/evidence.js';

const feed = document.getElementById('feed');
const toggle = document.getElementById('autocheck');
const findbar = document.getElementById('findbar');
const counter = document.getElementById('counter');
const prevBtn = document.getElementById('prev');
const nextBtn = document.getElementById('next');
const banner = document.getElementById('banner');
const siteRow = document.getElementById('site');
const siteName = document.getElementById('siteName');
const siteAllow = document.getElementById('siteAllow');
const siteBlock = document.getElementById('siteBlock');

// The video script explains an idle state that has a cause the viewer can fix.
const CAPTION_HINTS = {
  off: 'Turn on YouTube subtitles (the CC button) so claims in this video can be detected.',
  none: 'No captions on this video. If it has a transcript, open it (…more, then Show transcript) and it will be read.',
};
// The banner has two sources: the page's privacy status, which wins when the page
// is blocked, and the video script's caption state. Both belong to one tab and are
// dropped the moment the panel switches to another.
let bannerTabId = null;
let pageStatus = null;
let captionMsg = null;

// Only the languages a reader is likely to meet; anything else is named by its code.
const LANGUAGE_NAMES = {
  ar: 'Arabic', bn: 'Bengali', cs: 'Czech', da: 'Danish', de: 'German', el: 'Greek',
  es: 'Spanish', fa: 'Persian', fi: 'Finnish', fr: 'French', he: 'Hebrew', hi: 'Hindi',
  hu: 'Hungarian', id: 'Indonesian', it: 'Italian', ja: 'Japanese', ko: 'Korean',
  nl: 'Dutch', no: 'Norwegian', pl: 'Polish', pt: 'Portuguese', ro: 'Romanian',
  ru: 'Russian', sv: 'Swedish', th: 'Thai', tr: 'Turkish', uk: 'Ukrainian',
  vi: 'Vietnamese', zh: 'Chinese',
};

const PRIVATE_REASONS = {
  user: (d) => `Not scanning ${d}: you turned it off. Press \u{1F44D} to allow it.`,
  builtin: (d) => `Not scanning ${d}: it looks like a private site (banking, health, email, accounts). Press \u{1F44D} to scan it anyway.`,
  local: () => 'Not scanning: this is a local or private network address.',
  fields: () => 'Not scanning this page: it has a password or card field.',
  language: (_d, msg) => {
    const name = LANGUAGE_NAMES[msg?.language] || '';
    return `Not scanning: this page looks like it is in ${name || 'another language'}. `
      + 'The claim detector only reads English. Press \u{1F44D} to scan it anyway.';
  },
  unsupported: () => '',
};

function renderBanner() {
  let text = '';
  if (pageStatus?.blocked) text = (PRIVATE_REASONS[pageStatus.reason] || PRIVATE_REASONS.builtin)(pageStatus.domain, pageStatus);
  else if (captionMsg) text = captionHintText(captionMsg) || '';
  banner.hidden = !text;
  banner.textContent = text;
}

function renderPageStatus(msg) {
  pageStatus = msg;
  bannerTabId = msg.tabId;
  const usable = msg.domain && msg.reason !== 'unsupported' && msg.reason !== 'local';
  siteRow.hidden = !usable;
  if (usable) {
    siteName.textContent = msg.domain;
    siteName.title = msg.blocked ? 'Not being scanned' : 'Being scanned';
    siteAllow.classList.toggle('active', msg.rule === 'allow');
    siteBlock.classList.toggle('active', msg.rule === 'block');
  }
  renderBanner();
}

function clearTabBanners() {
  pageStatus = null;
  captionMsg = null;
  bannerTabId = null;
  siteRow.hidden = true;
  renderBanner();
}

for (const [btn, action] of [[siteAllow, 'allow'], [siteBlock, 'block']]) {
  btn.addEventListener('click', () => {
    if (!pageStatus?.domain) return;
    chrome.runtime
      .sendMessage({ type: MSG.SITE_RULE, domain: pageStatus.domain, action })
      .catch(() => {});
  });
}

// "reading" carries a live count, so that a video which is being read but has
// produced nothing above the threshold does not look like one that is not read.
function captionHintText(msg) {
  if (msg.hint === 'reading') {
    const n = msg.scanned || 0;
    return n
      ? `Reading captions and transcript: ${n} sentence${n === 1 ? '' : 's'} scanned so far.`
      : 'Reading captions and transcript: waiting for the first sentence.';
  }
  return CAPTION_HINTS[msg.hint];
}

function renderCaptionHint(msg) {
  captionMsg = captionHintText(msg) ? msg : null;
  if (captionMsg) bannerTabId = msg.tabId;
  renderBanner();
}

const STATUS_LABEL = {
  [STATUS.UNCHECKED]: 'flagged',
  [STATUS.PENDING]: 'checking…',
  [STATUS.CHECKED]: 'sources found',
  [STATUS.ERROR]: 'check failed',
  [STATUS.NO_KEY]: 'no search key',
};

function fmtTime(t) {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Whether an AI provider is configured decides if the AI buttons appear at all.
let llmEnabled = false;
let lastClaims = [];

function render(claims) {
  lastClaims = claims;
  feed.innerHTML = '';
  if (!claims.length) {
    feed.innerHTML = '<div class="empty">Nothing flagged yet on this page.<br>Select any text and right-click to check it.</div>';
    return;
  }

  for (const c of [...claims].reverse()) {
    const el = document.createElement('div');
    el.className = 'claim';
    el.dataset.claimId = c.id;

    const text = document.createElement('div');
    text.className = 'claim-text';
    text.textContent = c.text;
    text.title = c.located === false
      ? 'This claim has no highlight on the page'
      : 'Jump to this on the page';
    text.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: MSG.FOCUS_CLAIM, claimId: c.id }).catch(() => {});
    });
    el.appendChild(text);

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.innerHTML = `<span class="badge ${c.status}">${STATUS_LABEL[c.status] || c.status}</span>`;
    if (c.ts != null) meta.innerHTML += `<span>${fmtTime(c.ts)}</span>`;
    // Says so plainly rather than leaving the user looking for a highlight that
    // was never drawn, e.g. when the page rewrote the text after it was scanned.
    if (c.located === false) meta.innerHTML += '<span title="This sentence could not be located in the page text, so it has no highlight to jump to.">not on page</span>';
    if (c.score != null) meta.innerHTML += `<span>score ${c.score}</span>`;
    if (c.userAdded) meta.innerHTML += '<span title="You added this by right-clicking selected text.">added by you</span>';
    el.appendChild(meta);

    // Search and AI calls both cost the user something, so each is its own button
    // and nothing runs until they ask.
    const actions = document.createElement('div');
    actions.className = 'actions';

    function addButton(label, busyLabel, withAi, primary) {
      const b = document.createElement('button');
      b.className = primary ? 'check' : 'check secondary';
      b.textContent = label;
      b.addEventListener('click', () => {
        for (const other of actions.querySelectorAll('button')) other.disabled = true;
        b.textContent = busyLabel;
        chrome.runtime
          .sendMessage({ type: MSG.CHECK_CLAIM, claimId: c.id, withAi })
          .catch(() => {});
      });
      actions.appendChild(b);
    }

    if (c.summarizing) {
      const note = document.createElement('div');
      note.className = 'muted-note';
      note.textContent = 'Asking the AI…';
      actions.appendChild(note);
    } else if (c.status === STATUS.UNCHECKED || c.status === STATUS.ERROR) {
      addButton(c.status === STATUS.ERROR ? 'Try again' : 'Check sources', 'Checking…', false, true);
      if (llmEnabled) addButton('Check with AI', 'Checking…', true, false);
    } else if (c.status === STATUS.CHECKED && llmEnabled && !c.analysis) {
      // Sources are already paid for; summarizing them costs no further search call.
      addButton('Summarize with AI', 'Asking the AI…', true, false);
    }

    // Native and keyless: opens the claim in the browser's own default search
    // engine, in a new tab. On every claim, whatever the provider state.
    const browse = document.createElement('button');
    browse.className = 'check secondary';
    browse.textContent = 'Search in browser';
    browse.title = 'Open this claim in your default search engine, in a new tab';
    browse.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: MSG.BROWSER_SEARCH, claimId: c.id }).catch(() => {});
    });
    actions.appendChild(browse);

    if (actions.childElementCount) el.appendChild(actions);

    if (c.status === STATUS.NO_KEY) {
      const p = document.createElement('div');
      p.className = 'summary';
      p.textContent = 'This search provider needs an API key. Add one, or switch to Wikipedia, which needs none. ';
      const b = document.createElement('button');
      b.className = 'link';
      b.textContent = 'Open settings';
      b.addEventListener('click', () => chrome.runtime.openOptionsPage());
      p.appendChild(b);
      el.appendChild(p);
    }

    // Verdicts from real fact-checking organisations sit above the AI summary and
    // the raw results, because a human verdict outranks both.
    if (c.factChecks?.length) el.appendChild(renderFactChecks(c.factChecks));

    // Peer-reviewed work, when academic mode asked for it. Placed above the web
    // results because a journal article outranks a news snippet for this purpose.
    if (c.scholar?.length) el.appendChild(renderScholar(c.scholar));
    else if (c.scholarError) {
      const e = document.createElement('div');
      e.className = 'muted-note';
      e.textContent = `Peer-reviewed lookup failed: ${c.scholarError}`;
      el.appendChild(e);
    }

    if (c.evidence) el.appendChild(renderEvidence(c));
    if (c.analysis) el.appendChild(renderAnalysis(c.analysis));

    if (c.error && c.status === STATUS.ERROR) {
      const e = document.createElement('div');
      e.className = 'summary';
      e.textContent = c.error;
      el.appendChild(e);
    }

    for (const r of c.results || []) {
      const row = document.createElement('div');
      row.className = 'result';
      const a = document.createElement('a');
      a.href = r.url;
      a.target = '_blank';
      a.rel = 'noreferrer';
      a.textContent = r.title || r.url;
      row.appendChild(a);
      const src = document.createElement('div');
      src.className = 'src';
      src.textContent = r.source || '';
      // The stance the AI assigned to this source, when it ran.
      const stance = c.evidence?.rows?.find((row) => row.url === r.url)?.stance;
      if (stance && stance !== 'unrelated') {
        const st = document.createElement('span');
        st.className = `chip stance-${stance}`;
        st.textContent = stance;
        src.appendChild(st);
      }
      if (r.academic) {
        const chip = document.createElement('span');
        chip.className = 'chip academic';
        chip.textContent = 'academic';
        src.appendChild(chip);
      }
      row.appendChild(src);
      if (r.snippet) {
        const sn = document.createElement('div');
        sn.className = 'snip';
        sn.textContent = r.snippet;
        row.appendChild(sn);
      }
      el.appendChild(row);
    }

    feed.appendChild(el);
  }
}

function renderScholar(list) {
  const box = document.createElement('div');
  box.className = 'scholar';

  const head = document.createElement('div');
  head.className = 'fc-head';
  head.textContent = list.length === 1 ? 'Peer-reviewed source (OpenAlex)' : `Peer-reviewed sources (OpenAlex, ${list.length})`;
  box.appendChild(head);

  for (const w of list) {
    const row = document.createElement('div');
    row.className = 'factcheck';

    const a = document.createElement('a');
    a.href = w.url;
    a.target = '_blank';
    a.rel = 'noreferrer';
    a.textContent = w.title;
    row.appendChild(a);

    const by = document.createElement('div');
    by.className = 'src';
    const bits = [w.venue, w.year, w.citations ? `${w.citations} citation${w.citations === 1 ? '' : 's'}` : ''].filter(Boolean);
    by.textContent = bits.join(' · ');
    if (w.openAccess) {
      const chip = document.createElement('span');
      chip.className = 'chip academic';
      chip.textContent = 'open access';
      by.appendChild(chip);
    }
    row.appendChild(by);

    if (w.authors?.length) {
      const au = document.createElement('div');
      au.className = 'snip';
      au.textContent = w.authors.join(', ') + (w.authors.length >= 3 ? ' et al.' : '');
      row.appendChild(au);
    }
    box.appendChild(row);
  }
  return box;
}

// Rating colours: ratingTone lives in shared/evidence.js, where the thermometer uses it too.

function renderFactChecks(list) {
  const box = document.createElement('div');
  box.className = 'factchecks';

  const head = document.createElement('div');
  head.className = 'fc-head';
  head.textContent = list.length === 1 ? 'Published fact-check' : `Published fact-checks (${list.length})`;
  box.appendChild(head);

  for (const f of list) {
    const row = document.createElement('div');
    row.className = 'factcheck';

    const rating = document.createElement('span');
    rating.className = `rating tone-${ratingTone(f.rating)}`;
    rating.textContent = f.rating || 'rated';
    row.appendChild(rating);

    const a = document.createElement('a');
    a.href = f.url;
    a.target = '_blank';
    a.rel = 'noreferrer';
    a.textContent = f.title || f.claim || f.url;
    row.appendChild(a);

    const by = document.createElement('div');
    by.className = 'src';
    by.textContent = [f.publisher, f.reviewDate].filter(Boolean).join(' · ');
    row.appendChild(by);

    if (f.claim && f.claim !== f.title) {
      const claimed = document.createElement('div');
      claimed.className = 'snip';
      claimed.textContent = f.claimant ? `${f.claimant}: ${f.claim}` : f.claim;
      row.appendChild(claimed);
    }

    box.appendChild(row);
  }
  return box;
}

// The thermometer reads how far the sources go toward supporting the claim. It is
// deliberately NOT driven by the classifier score, which measures whether a sentence
// is worth checking, not whether it is true — showing that as a truth reading would
// mislead. So it only appears once sources have actually been consulted.
const VERDICT_VIEW = {
  not_supported: { label: 'Not supported by sources', position: 8, tone: 'cold' },
  mixed: { label: 'Sources are mixed', position: 50, tone: 'warm' },
  supported: { label: 'Supported by sources', position: 92, tone: 'hot' },
  unclear: { label: "Sources don't settle this", position: 50, tone: 'flat' },
};

const LEAN_LABEL = { left: 'L', center: 'C', right: 'R', unclear: '?' };

function renderAnalysis(a) {
  const box = document.createElement('div');
  box.className = 'analysis';

  if (a.summary) {
    const sm = document.createElement('div');
    sm.className = 'summary';
    sm.textContent = a.summary;
    box.appendChild(sm);
  }

  for (const [label, value] of [['Sources agree', a.agreement], ['Unsettled', a.dispute]]) {
    if (!value) continue;
    const row = document.createElement('div');
    row.className = 'facet';
    const l = document.createElement('span');
    l.className = 'facet-label';
    l.textContent = label;
    row.append(l, document.createTextNode(` ${value}`));
    box.appendChild(row);
  }

  if (a.perspectives?.length) {
    const spread = document.createElement('div');
    spread.className = 'spread';
    for (const p of a.perspectives) {
      const chip = document.createElement('span');
      chip.className = `chip lean-${p.lean}`;
      chip.textContent = `${LEAN_LABEL[p.lean]} ${p.source}`;
      spread.appendChild(chip);
    }
    box.appendChild(spread);

    const caveat = document.createElement('div');
    caveat.className = 'caveat';
    caveat.textContent = 'Lean is the AI model\u2019s rough estimate, not an authoritative rating.';
    box.appendChild(caveat);
  }

  return box;
}

// The thermometer. Its position comes from evidence.js: a published fact-check
// when one exists, else the AI's per-source stances weighted by relevance and
// source tier. With neither there is no position to show, and the meter reads
// evidence strength instead: how much credible, plainly worded coverage the claim
// has, which is not the same thing as whether it is true. Every input is listed
// beneath it, so the reading is explainable rather than a bare number.
function renderEvidence(c) {
  const e = c.evidence;
  const box = document.createElement('div');
  box.className = 'analysis';
  const hasPosition = e.position != null;
  const view = VERDICT_VIEW[e.verdict] || VERDICT_VIEW.unclear;

  const verdictLine = document.createElement('div');
  verdictLine.className = 'verdict';
  verdictLine.textContent = hasPosition ? view.label : 'Evidence gathered, no position judged';
  const strength = document.createElement('span');
  strength.className = 'confidence';
  strength.textContent = `Evidence strength ${Math.round(e.quality * 100)}%`;
  verdictLine.appendChild(strength);
  box.appendChild(verdictLine);

  const thermo = document.createElement('div');
  thermo.className = `thermo tone-${hasPosition ? view.tone : 'quality'}`;
  const track = document.createElement('div');
  track.className = 'thermo-track';
  const marker = document.createElement('div');
  marker.className = 'thermo-marker';
  marker.style.left = `${hasPosition ? e.position : Math.round(e.quality * 100)}%`;
  track.appendChild(marker);
  thermo.appendChild(track);
  const scale = document.createElement('div');
  scale.className = 'thermo-scale';
  for (const label of hasPosition ? ['refuted', 'mixed', 'supported'] : ['weak evidence', '', 'strong evidence']) {
    const span = document.createElement('span');
    span.textContent = label;
    scale.appendChild(span);
  }
  thermo.appendChild(scale);
  box.appendChild(thermo);

  const explain = document.createElement('ul');
  explain.className = 'explain';
  for (const line of e.lines) {
    const li = document.createElement('li');
    li.textContent = line;
    explain.appendChild(li);
  }
  box.appendChild(explain);
  return box;
}

function focusClaim(claimId) {
  const el = feed.querySelector(`[data-claim-id="${claimId}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('fc-focused');
  setTimeout(() => el.classList.remove('fc-focused'), 1600);
}

// The service worker cannot reach the browser's built-in model, so it delegates
// the call here, where a document context exists.
async function runInPageLlm(msg) {
  const settings = await getSettings();
  const llm = getLlmProvider(settings.llmProvider);
  if (!llm.runsInPage) return;
  try {
    const analysis = await llm.crossReference(msg.claim, msg.results, settings.llmApiKey);
    chrome.runtime.sendMessage({ type: MSG.LLM_RESULT, claimId: msg.claimId, analysis }).catch(() => {});
  } catch (err) {
    chrome.runtime
      .sendMessage({ type: MSG.LLM_RESULT, claimId: msg.claimId, error: err.message })
      .catch(() => {});
  }
}

// --- find bar ---------------------------------------------------------------

function step(direction) {
  chrome.runtime.sendMessage({ type: MSG.NAV_CLAIM, direction }).catch(() => {});
}

function renderNavState({ index, total, claimId }) {
  findbar.hidden = !total;
  counter.textContent = `${index || 0} of ${total || 0}`;
  prevBtn.disabled = !total;
  nextBtn.disabled = !total;
  if (claimId) focusClaim(claimId);
}

prevBtn.addEventListener('click', () => step('prev'));
nextBtn.addEventListener('click', () => step('next'));

// Enter and the arrow keys step matches, as they do in a find bar.
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea')) return;
  if (e.key === 'Enter') step(e.shiftKey ? 'prev' : 'next');
  else if (e.key === 'ArrowDown') step('next');
  else if (e.key === 'ArrowUp') step('prev');
  else return;
  e.preventDefault();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === MSG.PANEL_UPDATE) {
    // Banners and the site row belong to one tab; switching clears them.
    if (bannerTabId != null && msg.tabId !== bannerTabId) clearTabBanners();
    render(msg.claims || []);
  } else if (msg.type === MSG.CAPTION_HINT) renderCaptionHint(msg);
  else if (msg.type === MSG.PAGE_STATUS) renderPageStatus(msg);
  else if (msg.type === MSG.NAV_STATE) renderNavState(msg);
  else if (msg.type === MSG.PANEL_FOCUS) focusClaim(msg.claimId);
  else if (msg.type === MSG.LLM_REQUEST) runInPageLlm(msg);
});

toggle.addEventListener('change', () => {
  chrome.runtime
    .sendMessage({ type: MSG.SET_AUTOCHECK, autoCheck: toggle.checked })
    .catch(() => {});
});

// Changing the AI provider in settings should show or hide the AI buttons without
// needing the panel reopened.
chrome.storage.onChanged.addListener(async () => {
  const s = await getSettings();
  const next = s.llmProvider !== 'none';
  toggle.checked = s.autoCheck;
  if (next !== llmEnabled) {
    llmEnabled = next;
    render(lastClaims);
  }
});

(async () => {
  const settings = await getSettings();
  llmEnabled = settings.llmProvider !== 'none';
  toggle.checked = settings.autoCheck;
  const res = await chrome.runtime.sendMessage({ type: MSG.PANEL_READY }).catch(() => null);
  render(res?.claims || []);
  if (res?.page) renderPageStatus({ ...res.page, tabId: res.tabId });
})();
