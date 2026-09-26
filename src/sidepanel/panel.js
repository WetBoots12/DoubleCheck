import { MSG, STATUS, getSettings, saveSettings } from '../shared/messages.js';
import { panelTextSize, applyTheme, THEMES } from '../shared/appearance.js';
import { getLlmProvider, getSearchProvider, partialSummary, LLM_PROVIDERS } from '../providers/index.js';
import { ratingTone } from '../shared/evidence.js';
import { httpUrl } from '../shared/privacy.js';
import { claimToMarkdown } from '../shared/exportclaim.js';
import { FORMATS, DEFAULT_FORMAT, isFormat, formatCitation, worksCited, missingFields } from '../shared/citation.js';
import { AI_DISCLAIMER, applyCitationFacts } from '../shared/citationprompt.js';

// Keep every request and update attached to this panel's window.
const panelId = crypto.randomUUID();
let panelWindowId = null;
let activePanelTab = null;
const panelScope = chrome.windows.getCurrent().then(async (window) => {
  panelWindowId = window.id;
  const [tab] = await chrome.tabs.query({ active: true, windowId: window.id });
  activePanelTab = tab?.id ?? null;
});
async function sendPanelMessage(message) {
  await panelScope;
  return chrome.runtime.sendMessage({ ...message, windowId: panelWindowId, panelId });
}
async function refreshPanel() {
  const requestedTab = activePanelTab;
  const res = await sendPanelMessage({ type: MSG.PANEL_READY });
  if (requestedTab !== activePanelTab || res?.tabId !== activePanelTab) return;
  renderedTabId = res?.tabId ?? null;
  folded.clear();
  clearTabBanners();
  render(res?.claims || [], { keepScroll: false });
  if (res?.page) renderPageStatus({ ...res.page, tabId: res.tabId });
  if (res?.caption) renderCaptionHint({ ...res.caption, tabId: res.tabId });
}
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  panelScope.then(() => {
    if (windowId !== panelWindowId) return;
    activePanelTab = tabId;
    refreshPanel().catch(() => {});
  });
});

// A link to a source, built so that where it goes matches what it says. The
// address is checked by shared/privacy.js; anything that is not an ordinary web
// address is shown as plain text rather than as a link that lies about itself.
function sourceLink(url, label) {
  const safe = httpUrl(url);
  if (!safe) {
    const span = document.createElement('span');
    span.textContent = label;
    return span;
  }
  const a = document.createElement('a');
  a.href = safe;
  a.target = '_blank';
  a.rel = 'noreferrer';
  a.textContent = label;
  return a;
}

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
const foldAll = document.getElementById('foldAll');

// The video script explains an idle state that has a cause the viewer can fix.
const CAPTION_HINTS = {
  off: 'Subtitles are off for this video. Turn on the CC button, or open the transcript and it will be read.',
  none: 'No captions are playing. If this video has a transcript, it can be opened and read.',
};

// The caption track behind a video cannot simply be fetched: the URL is in the page,
// but the endpoint answers with an empty body without a token the player mints. The
// transcript YouTube already offers is the route that works, so the panel opens it
// rather than asking the viewer to hunt for it under "…more".
const TRANSCRIPT_HINTS = new Set(['off', 'none']);
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
  user: (d) => `Not scanning ${d}: you set it to Never. Choose Always or Default under "Scan this site" to allow it.`,
  builtin: (d) => `Not scanning ${d}: it looks like a private site (banking, health, email, accounts). Choose Always under "Scan this site" to scan it anyway.`,
  local: () => 'Not scanning: this is a local or private network address.',
  fields: () => 'Not scanning this page: it has a password or card field.',
  language: (_d, msg) => {
    const name = LANGUAGE_NAMES[msg?.language] || '';
    return `Not scanning: this page looks like it is in ${name || 'another language'}. `
      + 'The claim detector only reads English. Choose Always under "Scan this site" to scan it anyway.';
  },
  unsupported: () => '',
};

function renderBanner() {
  let text = '';
  if (pageStatus?.blocked) text = (PRIVATE_REASONS[pageStatus.reason] || PRIVATE_REASONS.builtin)(pageStatus.domain, pageStatus);
  else if (captionMsg) text = captionHintText(captionMsg) || '';
  banner.hidden = !text;
  banner.textContent = text;

  if (!banner.hidden && !pageStatus?.blocked && TRANSCRIPT_HINTS.has(captionMsg?.hint)) {
    const open = document.createElement('button');
    open.className = 'check secondary';
    open.id = 'openTranscript';
    open.textContent = 'Open the transcript';
    open.addEventListener('click', () => {
      open.disabled = true;
      open.textContent = 'Opening…';
      sendPanelMessage({ type: MSG.OPEN_TRANSCRIPT }).catch(() => {});
    });
    banner.appendChild(open);
  }
}

// Which citation style the Cite buttons use. Chosen on the panel next to the button
// rather than buried in settings, because it is a decision about the essay being
// written and not about the extension. Remembered so it holds across every source
// and every tab until the reader changes it.
let citationFormat = DEFAULT_FORMAT;

// Every dropdown on screen shows the same choice, so changing one changes them all.
//
// Asked of the document rather than kept in a set. A set was the obvious way and was
// wrong: the panel rebuilds its feed on every update from the worker, so the set
// filled with dropdowns that had already been thrown away and nothing ever removed
// them. Measured after fifty updates with two sources: two on screen, a hundred and
// two still held. The document already knows which ones exist.
function eachFormatPicker(fn) {
  for (const el of document.querySelectorAll('select.cite-format')) fn(el);
}

function setCitationFormat(next) {
  if (!isFormat(next) || next === citationFormat) return;
  citationFormat = next;
  eachFormatPicker((el) => { el.value = next; });
  saveSettings({ citationFormat: next }).catch(() => {});
}

function formatPicker() {
  const select = document.createElement('select');
  select.className = 'cite-format';
  select.title = 'Which citation style to copy';
  for (const f of FORMATS) {
    const opt = document.createElement('option');
    opt.value = f.id;
    opt.textContent = f.label;
    select.appendChild(opt);
  }
  select.value = citationFormat;
  select.addEventListener('change', () => setCitationFormat(select.value));
  return select;
}

// A citation, on the clipboard, in the style showing on the dropdown.
//
// The lookup can involve reading the source's page, so the button says what it is
// doing. Where the clipboard refuses, which it does when the panel has lost focus,
// the text is put on screen to be copied by hand rather than silently lost.
async function copyCitation(button, request, { asList = false } = {}) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Citing…';
  try {
    const res = await sendPanelMessage(request);
    const sources = res?.sources || [];
    if (!sources.length) throw new Error('nothing to cite');

    // One entry per line, which is what a works cited page is.
    const text = asList
      ? worksCited(sources, citationFormat).join('\n')
      : formatCitation(sources[0], citationFormat);

    await navigator.clipboard.writeText(text);
    const gaps = asList ? [] : missingFields(sources[0]);
    // Saved as well as copied: citing something is what puts it in the works cited
    // list, which is on the Works cited tab of the options page.
    button.textContent = gaps.length
      ? `Saved, no ${gaps.slice(0, 2).join(' or ')}`
      : 'Copied and saved';
  } catch {
    button.textContent = 'Could not copy';
  }
  button.disabled = false;
  setTimeout(() => { button.textContent = label; }, 2600);
}

// Asking a model to find what the page did not say.
//
// A separate AI function from the summary, with its own prompt and its own rules;
// see shared/citationprompt.js. It runs here rather than in the worker because the
// browser's built-in model needs a document, and putting every provider through one
// path is worth more than keeping the key on the other side of a message.
//
// Only on this press. Only for the fields that are actually missing. What comes back
// is refused unless it survives the same checks a scraped byline faces, and it can
// never overwrite something the page itself said.
async function citeWithAi(button, claimId, url, statusLine) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Asking the AI…';
  statusLine.textContent = '';

  try {
    const settings = await getSettings();
    const llm = getLlmProvider(settings.llmProvider);
    if (!llm.lookupCitationFacts) throw new Error('this provider cannot look up citations');

    const material = await sendPanelMessage({ type: MSG.CITE_MATERIAL, claimId, url });
    if (!material?.source) throw new Error('nothing to complete');
    if (!material.missing.length) throw new Error('nothing missing');

    const facts = await llm.lookupCitationFacts(material, settings.llmApiKey, {
      model: settings.llmModel,
      url: settings.localLlmUrl,
    });
    const filled = applyCitationFacts(material.source, facts);

    const text = filled.aiFilled?.length
      ? `${formatCitation(filled, citationFormat)}\n\n${AI_DISCLAIMER}`
      : formatCitation(filled, citationFormat);
    await navigator.clipboard.writeText(text);

    if (filled.aiFilled?.length) {
      button.textContent = 'Copied';
      // The disclaimer is not optional, and it goes on screen as well as into the
      // clipboard, because the two get read by different people at different times.
      statusLine.textContent = `${AI_DISCLAIMER} It supplied the ${filled.aiFilled.join(' and ')}.`;
      statusLine.className = 'ai-note warn';
    } else {
      button.textContent = 'Copied';
      // Being unable to find a byline is the right answer for a page without one.
      statusLine.textContent = `The AI could not find the ${material.missing.join(' or ')} either. `
        + 'The citation is correct without it.';
      statusLine.className = 'ai-note';
    }
  } catch (err) {
    button.textContent = 'Could not copy';
    statusLine.textContent = err?.message ? `Could not ask the AI: ${err.message}` : '';
    statusLine.className = 'ai-note';
  }

  button.disabled = false;
  setTimeout(() => { button.textContent = label; }, 2600);
}

// The site the claims came from, so copied text says where it was found. The panel
// is told the domain and not the full address, which is enough to name the source
// and is the least it could carry.
let pageDomain = '';

function renderPageStatus(msg) {
  pageStatus = msg;
  bannerTabId = msg.tabId;
  pageDomain = msg.domain || '';
  const usable = msg.domain && msg.reason !== 'unsupported' && msg.reason !== 'local';
  siteRow.hidden = !usable;
  if (usable) {
    siteName.textContent = msg.domain;
    siteName.title = msg.blocked ? 'Not being scanned' : 'Being scanned';
    siteAllow.setAttribute('aria-pressed', String(msg.rule === 'allow'));
    siteDefault.setAttribute('aria-pressed', String(msg.rule !== 'allow' && msg.rule !== 'block'));
    siteBlock.setAttribute('aria-pressed', String(msg.rule === 'block'));
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

// "Scan this site": Always, Default or Never. Pressing the one already chosen does
// nothing, so a second press cannot quietly undo the first.
const siteDefault = document.getElementById('siteDefault');
for (const [btn, action] of [[siteAllow, 'allow'], [siteDefault, 'clear'], [siteBlock, 'block']]) {
  btn.addEventListener('click', () => {
    if (!pageStatus?.domain || btn.getAttribute('aria-pressed') === 'true') return;
    sendPanelMessage({ type: MSG.SITE_RULE, domain: pageStatus.domain, action })
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
// True once a provider that needs a key has one. Until then the panel's own search
// is the keyless fallback, and the button order says so.
let searchKeyed = false;

function keyedSearch(settings) {
  return Boolean(getSearchProvider(settings.searchProvider)?.requiresKey && settings.searchApiKey);
}
let lastClaims = [];

// Which claims are folded shut, and which tab the feed was last drawn for.
const folded = new Set();
let renderedTabId = null;

function render(claims, { keepScroll = true } = {}) {
  lastClaims = claims;

  // Rebuilding the feed empties the document, and the browser then clamps the
  // scroll to the top. So pressing Check sources on the tenth claim answered by
  // throwing the reader back to the first. The position is taken before the wipe
  // and put back after, which holds because the cards above the one being checked
  // do not change height.
  const scroller = document.scrollingElement || document.documentElement;
  const wasAt = scroller.scrollTop;

  feed.innerHTML = '';
  if (!claims.length) {
    feed.innerHTML = '<div class="empty">Nothing flagged yet on this page.<br>Highlight a sentence, then right-click it and choose &quot;Double-check the highlighted text&quot;.</div>';
    foldAll.hidden = true;
    return;
  }

  // In the order they appear in the article. The list used to show the newest flag
  // first, which on a page read top to bottom is the article upside down: the reader
  // looked at the panel, then at the page, and found the two disagreeing about
  // what came first. Claims arrive in the order the page was read, which is the
  // order of the text, so keeping that order keeps the two in step.
  for (const c of claims) {
    const el = document.createElement('div');
    el.className = c.band === 'faint' ? 'claim faint' : 'claim';
    el.dataset.claimId = c.id;

    const text = document.createElement('div');
    text.className = 'claim-text';
    text.textContent = c.text;
    text.title = c.located === false
      ? 'This claim has no highlight on the page'
      : 'Jump to this on the page';
    // The sentence is a control: it says so, and it works from the keyboard too.
    const jumpTo = () => sendPanelMessage({ type: MSG.FOCUS_CLAIM, claimId: c.id }).catch(() => {});
    if (c.located !== false) {
      const jump = document.createElement('span');
      jump.className = 'jump';
      jump.textContent = '↗ jump to';
      text.append(' ', jump);
      text.setAttribute('role', 'button');
      text.tabIndex = 0;
      text.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        jumpTo();
      });
    }
    text.addEventListener('click', jumpTo);
    el.appendChild(text);
    // A re-render rebuilds every card, so the outline goes back on the one it was on.
    if (c.id === focusedId) el.classList.add('fc-focused');

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.innerHTML = `<span class="badge ${c.status}">${STATUS_LABEL[c.status] || c.status}</span>`;
    // The raw number is off by default: to most readers it looks like a truth rating.
    // It stays on the badge's tooltip, and a setting shows it in full.
    if (c.score != null) meta.firstElementChild.title = `Classifier score ${c.score}: how checkable the sentence looks, not whether it is true`;
    if (c.ts != null) meta.innerHTML += `<span>${fmtTime(c.ts)}</span>`;
    // Says so plainly rather than leaving the user looking for a highlight that
    // was never drawn, e.g. when the page rewrote the text after it was scanned.
    if (c.located === false) meta.innerHTML += '<span title="This sentence could not be located in the page text, so it has no highlight to jump to.">not on page</span>';
    if (c.score != null && showScores) meta.innerHTML += `<span>score ${c.score}</span>`;
    if (c.userAdded) meta.innerHTML += '<span title="You added this by highlighting the sentence and right-clicking it.">added by you</span>';
    // Said plainly, so a dimmed card reads as "unsure" and not as "broken".
    if (c.band === 'faint') meta.innerHTML += '<span class="faint-tag" title="This sentence scored just below your flagging threshold. It may be a claim; the classifier was not sure.">possibly a claim</span>';
    el.appendChild(meta);

    // What about the sentence made it look checkable. The score on its own is an
    // oracle; this says what the model actually noticed, which is a description of
    // the sentence and not a judgement about whether it is true.
    if (Array.isArray(c.signals) && c.signals.length) {
      const why = document.createElement('div');
      why.className = 'signals';
      why.textContent = `Flagged for: ${c.signals.join(', ')}`;
      why.title = 'What this sentence contains that makes it checkable. It says nothing about whether the sentence is correct.';
      el.appendChild(why);
    }

    // Search and AI calls both cost the user something, so each is its own button
    // and nothing runs until they ask.
    const actions = document.createElement('div');
    actions.className = 'actions';

    function addButton(label, busyLabel, withAi, primary) {
      const b = document.createElement('button');
      b.className = primary ? 'check' : 'check secondary';
      b.textContent = label;
      b.addEventListener('click', () => {
        // Asking for sources and then not being shown them would be absurd.
        folded.delete(c.id);
        for (const other of actions.querySelectorAll('button')) other.disabled = true;
        b.textContent = busyLabel;
        sendPanelMessage({ type: MSG.CHECK_CLAIM, claimId: c.id, withAi })
          .catch(() => {});
      });
      actions.appendChild(b);
    }

    if (c.summarizing) {
      // Its own class, not just the shared muted style: this is the one note that
      // gets rewritten from outside render, as the model writes.
      const note = document.createElement('div');
      note.className = 'muted-note ai-progress';
      note.textContent = 'Asking the AI…';
      actions.appendChild(note);
    } else if (c.status === STATUS.UNCHECKED || c.status === STATUS.ERROR) {
      // Without a web-search key the panel's own lookup is Wikipedia, which is good
      // for background on a person, a place or a term and poor on this week's news.
      // Saying "Check sources" for that promises more than it delivers, so it is
      // named for what it does and the browser search leads instead.
      const label = c.status === STATUS.ERROR
        ? 'Try again'
        : (searchKeyed ? 'Check sources' : 'Add background');
      addButton(label, 'Checking…', false, searchKeyed);
      if (llmEnabled) addButton('Check with AI', 'Checking…', true, false);
    } else if (c.status === STATUS.CHECKED && llmEnabled && !c.analysis) {
      // Sources are already paid for; summarizing them costs no further search call.
      addButton('Summarize with AI', 'Asking the AI…', true, false);
    }

    // The browser's own search engine, with the claim turned into a query rather
    // than pasted in whole. Present on every claim; which button leads depends on
    // whether a web-search key exists, since without one this is the route that
    // actually reaches the open web.
    const browse = document.createElement('button');
    browse.className = searchKeyed ? 'check secondary' : 'check';
    browse.textContent = 'Search in browser';
    browse.title = 'Open this claim in your default search engine, in a new tab';
    browse.addEventListener('click', () => {
      sendPanelMessage({ type: MSG.BROWSER_SEARCH, claimId: c.id }).catch(() => {});
    });
    if (searchKeyed) actions.appendChild(browse);
    else actions.insertBefore(browse, actions.firstChild);

    // An answer already stored costs nothing to look at again, and saying so before
    // the button is pressed is the point: the whole design is that the reader
    // decides when to spend, so they should know when there is nothing to spend.
    if (c.cached && (c.status === STATUS.UNCHECKED || c.status === STATUS.ERROR)) {
      const free = document.createElement('div');
      free.className = 'muted-note';
      free.textContent = 'Search results are cached. Other lookups and AI summaries may still make requests.';
      actions.appendChild(free);
    }

    // Out of the panel and into wherever the reader is actually writing. Nothing
    // leaves the machine: this is the clipboard.
    if (c.status === STATUS.CHECKED || c.results?.length || c.factChecks?.length) {
      const copy = document.createElement('button');
      copy.className = 'check secondary';
      copy.textContent = 'Copy';
      copy.title = 'Copy this claim and what was found about it, as text you can paste';
      copy.addEventListener('click', async () => {
        const label = copy.textContent;
        try {
          await navigator.clipboard.writeText(claimToMarkdown(c, { pageTitle: pageDomain }));
          copy.textContent = 'Copied';
        } catch {
          copy.textContent = 'Could not copy';
        }
        setTimeout(() => { copy.textContent = label; }, 1500);
      });
      actions.appendChild(copy);
    }

    // Everything this claim found, as a works cited list: deduplicated, alphabetised
    // and ready to paste under the heading.
    if ((c.results?.length || 0) + (c.scholar?.length || 0) + (c.factChecks?.length || 0) > 1) {
      const all = document.createElement('button');
      all.className = 'check secondary';
      all.textContent = 'Cite all sources';
      all.title = 'Copy every source found for this claim, as a works cited list';
      all.addEventListener('click', () =>
        copyCitation(all, { type: MSG.CITE_SOURCES, claimId: c.id }, { asList: true }));
      actions.appendChild(all);
    }

    if (actions.childElementCount) el.appendChild(actions);

    // Everything a check produced goes in here, so one press can fold it away and
    // leave the sentence, its badges and its buttons behind.
    const body = document.createElement('div');
    body.className = 'claim-body';

    if (c.status === STATUS.NO_KEY) {
      const p = document.createElement('div');
      p.className = 'summary';
      p.textContent = 'This search provider needs an API key. Add one in settings, or use "Search in browser", which needs none. ';
      const b = document.createElement('button');
      b.className = 'link';
      b.textContent = 'Open settings';
      b.addEventListener('click', () => chrome.runtime.openOptionsPage());
      p.appendChild(b);
      body.appendChild(p);
    }

    // Verdicts from real fact-checking organisations sit above the AI summary and
    // the raw results, because a human verdict outranks both.
    if (c.factChecks?.length) body.appendChild(renderFactChecks(c.factChecks));

    // Peer-reviewed work, when academic mode asked for it. Placed above the web
    // results because a journal article outranks a news snippet for this purpose.
    if (c.scholar?.length) body.appendChild(renderScholar(c.scholar));
    else if (c.scholarError) {
      const e = document.createElement('div');
      e.className = 'muted-note';
      e.textContent = `Peer-reviewed lookup failed: ${c.scholarError}`;
      body.appendChild(e);
    }

    if (c.evidence) body.appendChild(renderEvidence(c));
    if (c.analysis) body.appendChild(renderAnalysis(c.analysis));

    if (c.error && c.status === STATUS.ERROR) {
      const e = document.createElement('div');
      e.className = 'summary';
      e.textContent = c.error;
      body.appendChild(e);
    }

    for (const r of c.results || []) {
      const row = document.createElement('div');
      row.className = 'result';
      row.appendChild(sourceLink(r.url, r.title || r.url));
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
      // Say it on the source itself, not only in the explanation lines: a reader
      // looking at a 2019 page needs to see why it counted for less.
      const evidenceRow = c.evidence?.rows?.find((x) => x.url === r.url);
      if (evidenceRow?.figures?.note) {
        const fig = document.createElement('div');
        fig.className = 'figures';
        fig.textContent = `Different figure: ${evidenceRow.figures.note}`;
        row.appendChild(fig);
      }
      const timing = evidenceRow?.time;
      if (timing?.note) {
        const age = document.createElement('div');
        age.className = 'age';
        age.textContent = timing.note;
        row.appendChild(age);
      }
      if (r.snippet) {
        const sn = document.createElement('div');
        sn.className = 'snip';
        sn.textContent = r.snippet;
        row.appendChild(sn);
      }

      // The style sits next to the button rather than in settings, so the choice is
      // made where the citation is taken.
      if (r.url) {
        const cite = document.createElement('div');
        cite.className = 'cite-row';
        cite.appendChild(formatPicker());
        const b = document.createElement('button');
        b.className = 'check secondary';
        b.textContent = 'Cite this source';
        b.title = 'Copy a citation for this source in the style shown';
        b.addEventListener('click', () =>
          copyCitation(b, { type: MSG.CITE_SOURCES, claimId: c.id, url: r.url }));
        cite.appendChild(b);

        // Whatever the AI says about a citation is said here, under the buttons that
        // asked for it.
        const note = document.createElement('div');
        note.className = 'ai-note';

        // Offered only when a model is configured. What it fills is checked, and what
        // it cannot find it is allowed to say.
        if (llmEnabled) {
          const ai = document.createElement('button');
          ai.className = 'check secondary';
          ai.textContent = 'Complete with AI';
          ai.title = 'Ask the AI to look for the author and date this page did not state, then copy the citation';
          ai.addEventListener('click', () => citeWithAi(ai, c.id, r.url, note));
          cite.appendChild(ai);
        }

        row.appendChild(cite);
        row.appendChild(note);
      }

      body.appendChild(row);
    }


    // A long list of checked claims is unreadable, so each one folds. The state
    // lives in the panel rather than in storage: it is how the reader is looking at
    // this page right now, not a preference about every page.
    if (body.childElementCount) {
      const shut = folded.has(c.id);
      const found = (c.results?.length || 0) + (c.scholar?.length || 0) + (c.factChecks?.length || 0);
      const fold = document.createElement('button');
      fold.className = 'fold';
      fold.setAttribute('aria-expanded', String(!shut));
      fold.textContent = shut
        ? `\u25b8 ${found ? `${found} source${found === 1 ? '' : 's'}` : 'show'}`
        : '\u25be hide';
      fold.title = shut
        ? 'Show what was found for this claim'
        : 'Fold this away and keep the list short';
      fold.addEventListener('click', () => {
        if (folded.has(c.id)) folded.delete(c.id); else folded.add(c.id);
        render(lastClaims);
      });
      meta.appendChild(fold);
      if (!shut) el.appendChild(body);
    }

    feed.appendChild(el);
  }

  renderFoldAll(claims);
  // A new page starts at the top; the same page keeps the reader where they were.
  scroller.scrollTop = keepScroll ? wasAt : 0;
}

// One press to fold every claim that has anything to fold, and one to open them
// again. Only offered once there is more than one, since below that the per-claim
// control is the whole story.
function renderFoldAll(claims) {
  const holders = claims.filter((c) => (c.results?.length || c.scholar?.length || c.factChecks?.length || c.analysis));
  foldAll.hidden = holders.length < 2;
  if (foldAll.hidden) return;
  const anyOpen = holders.some((c) => !folded.has(c.id));
  foldAll.textContent = anyOpen ? 'Fold all' : 'Open all';
  foldAll.title = anyOpen
    ? 'Fold every checked claim, leaving the sentences and their buttons'
    : 'Show what was found for every claim';
  foldAll.onclick = () => {
    for (const c of holders) {
      if (anyOpen) folded.add(c.id); else folded.delete(c.id);
    }
    render(lastClaims);
  };
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

    row.appendChild(sourceLink(w.url, w.title));

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

    row.appendChild(sourceLink(f.url, f.title || f.claim || f.url));

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

// The claim the reader is on. The outline used to fade after a second and a half,
// which meant that after pressing next the reader had to find the claim again in
// the list. It now stays on the current claim until another takes its place, the
// same way the page keeps its own marker on the current highlight.
let focusedId = null;

function markFocused(claimId) {
  focusedId = claimId;
  for (const other of feed.querySelectorAll('.fc-focused')) other.classList.remove('fc-focused');
  const el = claimId ? feed.querySelector(`[data-claim-id="${claimId}"]`) : null;
  if (el) el.classList.add('fc-focused');
  return el;
}

function focusClaim(claimId) {
  const el = markFocused(claimId);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// The service worker cannot reach the browser's built-in model, so it delegates
// the call here, where a document context exists.
// The worker marks the claim as summarizing and will not touch it again until an
// answer comes back, so every path out of here has to send one. Returning quietly
// because the provider changed under us left the claim's buttons dead.
async function runInPageLlm(msg) {
  const answer = (payload) =>
    sendPanelMessage({ type: MSG.LLM_RESULT, tabId: msg.tabId, requestId: msg.requestId, claimId: msg.claimId, ...payload }).catch(() => {});

  let settings;
  try {
    settings = await getSettings();
  } catch (err) {
    return answer({ error: err.message });
  }

  const llm = getLlmProvider(settings.llmProvider);
  if (!llm.runsInPage) {
    // The provider was changed between the worker asking and this running.
    return answer({ error: 'the AI provider changed before the summary could run' });
  }

  try {
    // An on-device model writes at reading speed, and a note that never changes
    // looks like a hang. The summary it is composing is shown as it arrives, so
    // the wait is spent reading rather than wondering.
    const analysis = await llm.crossReference(msg.claim, msg.results, settings.llmApiKey, {
      onProgress: (text) => showProgress(msg.claimId, text),
    });
    return answer({ analysis });
  } catch (err) {
    return answer({ error: err.message });
  }
}

function showProgress(claimId, text) {
  const note = feed.querySelector(`[data-claim-id="${claimId}"] .ai-progress`);
  if (!note) return;
  const written = partialSummary(text).trim();
  note.textContent = written ? `Asking the AI… ${written}` : 'Asking the AI…';
}

// --- find bar ---------------------------------------------------------------

function step(direction) {
  sendPanelMessage({ type: MSG.NAV_CLAIM, direction }).catch(() => {});
}

function renderNavState({ index, total, claimId }) {
  findbar.hidden = !total;
  counter.textContent = `${index || 0} of ${total || 0}`;
  prevBtn.disabled = !total;
  nextBtn.disabled = !total;
  // No current highlight on the page means no current claim here either.
  if (claimId) focusClaim(claimId);
  else markFocused(null);
}

prevBtn.addEventListener('click', () => step('prev'));
nextBtn.addEventListener('click', () => step('next'));

// Enter and the arrow keys step matches, as they do in a find bar.
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, button, a, select, [contenteditable], [role=button]')) return;
  if (e.key === 'Enter') step(e.shiftKey ? 'prev' : 'next');
  else if (e.key === 'ArrowDown') step('next');
  else if (e.key === 'ArrowUp') step('prev');
  else return;
  e.preventDefault();
});

chrome.runtime.onMessage.addListener((msg) => {
  panelScope.then(() => {
    if (msg.type === MSG.LLM_REQUEST) {
      if (msg.windowId === panelWindowId) runInPageLlm(msg);
      return;
    }
    if (msg.tabId !== activePanelTab) return;
    if (msg.type === MSG.PANEL_UPDATE) {
      // Banners and the site row belong to one tab; switching clears them.
      if (bannerTabId != null && msg.tabId !== bannerTabId) clearTabBanners();
      // So does what is folded and where the reader had scrolled to. A new page
      // starts at the top with everything open.
      const sameTab = renderedTabId != null && msg.tabId === renderedTabId;
      if (!sameTab) folded.clear();
      renderedTabId = msg.tabId;
      render(msg.claims || [], { keepScroll: sameTab });
    } else if (msg.type === MSG.CAPTION_HINT) renderCaptionHint(msg);
    else if (msg.type === MSG.PAGE_STATUS) renderPageStatus(msg);
    else if (msg.type === MSG.NAV_STATE) renderNavState(msg);
    else if (msg.type === MSG.PANEL_FOCUS) focusClaim(msg.claimId);
  }).catch(() => {});
});

// Settings apply to sentences the extension has not judged yet, so changing the
// threshold does nothing to the page already on screen. This throws away what both
// sides remember about this tab and reads the page again.
// The guide answers what the panel cannot: what the scores mean, where keys come
// from, and what each button spends.
document.getElementById('guideLink')?.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html#guide') });
});

// Keeping the page the reader is on, for the works cited list.
//
// Manual, one press at a time. Nothing reads browsing history and no permission to
// do so is requested; this button is the only way a page enters the list. The worker
// applies a stricter rule here than it does for scanning, and when it refuses the
// reason is said plainly rather than the press appearing to do nothing.
const REFUSALS = {
  builtin: 'That page looks private (banking, health, email, accounts), so it is not kept. '
    + 'This one rule has no override, because the list is a file that outlives the browser.',
  user: 'That site is on your never-scan list, so it is not kept.',
  local: 'That is a local or private network address, so it is not kept.',
  fields: 'That page has a password or card field, so it is not kept.',
  incognito: 'Nothing from an incognito window is written to disk.',
  moved: 'That page changed while it was being read, so nothing was kept. Try again.',
  unsupported: 'That page cannot be cited.',
};

const addSourceBtn = document.getElementById('addSource');
const keepNote = document.getElementById('keepNote');

addSourceBtn?.addEventListener('click', async () => {
  addSourceBtn.disabled = true;
  const label = addSourceBtn.textContent;
  addSourceBtn.textContent = 'Keeping…';
  keepNote.textContent = '';
  keepNote.className = 'keep-note';

  const res = await sendPanelMessage({ type: MSG.ADD_SOURCE }).catch(() => null);

  if (res?.ok) {
    addSourceBtn.textContent = res.replaced ? 'Updated' : 'Kept';
    keepNote.textContent = res.title ? `“${res.title}” is in your works cited list.` : '';
  } else {
    addSourceBtn.textContent = 'Not kept';
    keepNote.textContent = REFUSALS[res?.reason] || REFUSALS.unsupported;
    keepNote.className = 'keep-note refused';
  }

  addSourceBtn.disabled = false;
  setTimeout(() => { addSourceBtn.textContent = label; }, 2600);
});

const rescanBtn = document.getElementById('rescan');
rescanBtn?.addEventListener('click', async () => {
  // The button is an icon, so the progress is said in the feed where the claims go.
  rescanBtn.disabled = true;
  rescanBtn.setAttribute('aria-busy', 'true');
  staleNote.hidden = true;
  const note = document.createElement('div');
  note.className = 'empty';
  note.textContent = 'Reading the page again…';
  feed.replaceChildren(note);
  await sendPanelMessage({ type: MSG.RESCAN }).catch(() => {});
  setTimeout(() => {
    rescanBtn.disabled = false;
    rescanBtn.removeAttribute('aria-busy');
  }, 1200);
});

toggle.addEventListener('change', () => {
  sendPanelMessage({ type: MSG.SET_AUTOCHECK, autoCheck: toggle.checked })
    .catch(() => {});
});

// The panel's own text size, for anyone who finds the default hard going.
function applyPanelSize(settings) {
  document.documentElement.style.setProperty('--fc-panel-size', panelTextSize(settings));
}

// Whether each claim shows the classifier's raw number. Off unless the reader asks.
let showScores = false;

// The theme button steps System, Light, Dark. It says what it is now and what the
// next press does, since an icon alone says neither.
const themeBtn = document.getElementById('themeToggle');
let themeSetting = 'system';

const SVG_NS = 'http://www.w3.org/2000/svg';
function themeIcon(theme) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  const shape = (tag, attrs) => {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.appendChild(el);
  };
  const line = { stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', fill: 'none' };
  if (theme === 'light') {
    shape('circle', { cx: 8, cy: 8, r: 3, fill: 'currentColor' });
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      shape('line', { ...line, x1: 8 + Math.cos(a) * 5, y1: 8 + Math.sin(a) * 5, x2: 8 + Math.cos(a) * 6.8, y2: 8 + Math.sin(a) * 6.8 });
    }
  } else if (theme === 'dark') {
    shape('path', { d: 'M10.8 11.9A5.5 5.5 0 0 1 6.1 2.6a5.5 5.5 0 1 0 7.3 7.3 5.5 5.5 0 0 1-2.6 2z', fill: 'currentColor' });
  } else {
    shape('circle', { ...line, cx: 8, cy: 8, r: 5.8 });
    shape('path', { d: 'M8 2.2a5.8 5.8 0 0 1 0 11.6z', fill: 'currentColor' });
  }
  return svg;
}

function renderTheme(settings) {
  themeSetting = THEMES.some((t) => t.id === settings.theme) ? settings.theme : 'system';
  applyTheme(document.documentElement, { theme: themeSetting });
  const at = THEMES.findIndex((t) => t.id === themeSetting);
  const now = THEMES[at].label;
  const next = THEMES[(at + 1) % THEMES.length].label;
  themeBtn.setAttribute('aria-label', `Theme: ${now}`);
  themeBtn.title = `Theme: ${now}. Click for ${next}.`;
  // Drawn, not typed: the sun and moon characters vary from font to font, and in the
  // Windows symbol font the sun reads as an asterisk.
  themeBtn.replaceChildren(themeIcon(themeSetting));
}

themeBtn.addEventListener('click', () => {
  const at = THEMES.findIndex((t) => t.id === themeSetting);
  const theme = THEMES[(at + 1) % THEMES.length].id;
  renderTheme({ theme }); // at once; the saved setting follows
  saveSettings({ theme }).catch(() => {});
});

// Settings that change what is found or drawn on a page only apply to that page once
// it is read again. Said here, with the button that does it, rather than left to a
// line of small print on the options page. Changes made in this panel apply at once
// and are not listed.
const PAGE_SETTINGS = ['threshold', 'faintFlags', 'highlightStyle', 'highlightColor',
  'highlightThickness', 'privateSitesRule', 'showVideoOverlay'];
const staleNote = document.getElementById('stale');

function settingsTouchPage(change) {
  const before = change.oldValue || {};
  const after = change.newValue || {};
  return PAGE_SETTINGS.some((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
}

document.getElementById('staleRescan').addEventListener('click', () => rescanBtn.click());

// Changing the AI provider or the appearance in settings takes effect here without
// the panel needing to be reopened.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !changes.fc_settings) return;
  if (settingsTouchPage(changes.fc_settings) && renderedTabId != null) staleNote.hidden = false;
  const s = await getSettings();
  applyPanelSize(s);
  renderTheme(s);
  if (Boolean(s.showScores) !== showScores) {
    showScores = Boolean(s.showScores);
    render(lastClaims);
  }
  if (isFormat(s.citationFormat) && s.citationFormat !== citationFormat) {
    // Changed in another window; follow it without writing it back.
    citationFormat = s.citationFormat;
    eachFormatPicker((el) => { el.value = citationFormat; });
  }
  const next = s.llmProvider !== 'none';
  const keyed = keyedSearch(s);
  toggle.checked = s.autoCheck;
  if (next !== llmEnabled || keyed !== searchKeyed) {
    llmEnabled = next;
    searchKeyed = keyed;
    warmUpLlm(s); // the reader just chose a model; start loading it now
    render(lastClaims);
  }
});

(async () => {
  const settings = await getSettings();
  applyPanelSize(settings);
  renderTheme(settings);
  showScores = Boolean(settings.showScores);
  llmEnabled = settings.llmProvider !== 'none';
  searchKeyed = keyedSearch(settings);
  if (isFormat(settings.citationFormat)) citationFormat = settings.citationFormat;
  toggle.checked = settings.autoCheck;

  // The on-device model has to be loaded before it can write a word, and that load
  // used to happen on the first press. Starting it as the panel opens moves the
  // wait to a moment when nobody is waiting.
  warmUpLlm(settings);

  await panelScope;
  await refreshPanel();
})();

function warmUpLlm(settings) {
  try {
    for (const p of Object.values(LLM_PROVIDERS)) {
      if (p.id !== settings.llmProvider) p.release?.();
    }
    getLlmProvider(settings.llmProvider).warmUp?.();
  } catch { /* a model that will not warm up still answers when asked */ }
}
