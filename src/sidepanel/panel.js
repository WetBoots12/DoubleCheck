import { MSG, STATUS, getSettings, saveSettings } from '../shared/messages.js';
import { panelTextSize } from '../shared/appearance.js';
import { getLlmProvider, getSearchProvider } from '../providers/index.js';
import { ratingTone } from '../shared/evidence.js';
import { httpUrl } from '../shared/privacy.js';
import { claimToMarkdown } from '../shared/exportclaim.js';
import { FORMATS, DEFAULT_FORMAT, isFormat, formatCitation, worksCited, missingFields } from '../shared/citation.js';

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

  if (!banner.hidden && !pageStatus?.blocked && TRANSCRIPT_HINTS.has(captionMsg?.hint)) {
    const open = document.createElement('button');
    open.className = 'check secondary';
    open.id = 'openTranscript';
    open.textContent = 'Open the transcript';
    open.addEventListener('click', () => {
      open.disabled = true;
      open.textContent = 'Opening…';
      chrome.runtime.sendMessage({ type: MSG.OPEN_TRANSCRIPT }).catch(() => {});
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
const formatPickers = new Set();

function setCitationFormat(next) {
  if (!isFormat(next) || next === citationFormat) return;
  citationFormat = next;
  for (const el of formatPickers) el.value = next;
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
  formatPickers.add(select);
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
    const res = await chrome.runtime.sendMessage(request);
    const sources = res?.sources || [];
    if (!sources.length) throw new Error('nothing to cite');

    // One entry per line, which is what a works cited page is.
    const text = asList
      ? worksCited(sources, citationFormat).join('\n')
      : formatCitation(sources[0], citationFormat);

    await navigator.clipboard.writeText(text);
    const gaps = asList ? [] : missingFields(sources[0]);
    button.textContent = gaps.length
      ? `Copied, no ${gaps.slice(0, 2).join(' or ')}`
      : 'Copied';
  } catch {
    button.textContent = 'Could not copy';
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
// True once a provider that needs a key has one. Until then the panel's own search
// is the keyless fallback, and the button order says so.
let searchKeyed = false;

function keyedSearch(settings) {
  return Boolean(getSearchProvider(settings.searchProvider)?.requiresKey && settings.searchApiKey);
}
let lastClaims = [];

function render(claims) {
  lastClaims = claims;
  feed.innerHTML = '';
  if (!claims.length) {
    feed.innerHTML = '<div class="empty">Nothing flagged yet on this page.<br>Highlight a sentence, then right-click it and choose &quot;Fact-check the highlighted text&quot;.</div>';
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
    if (c.userAdded) meta.innerHTML += '<span title="You added this by highlighting the sentence and right-clicking it.">added by you</span>';
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
      chrome.runtime.sendMessage({ type: MSG.BROWSER_SEARCH, claimId: c.id }).catch(() => {});
    });
    if (searchKeyed) actions.appendChild(browse);
    else actions.insertBefore(browse, actions.firstChild);

    // An answer already stored costs nothing to look at again, and saying so before
    // the button is pressed is the point: the whole design is that the reader
    // decides when to spend, so they should know when there is nothing to spend.
    if (c.cached && (c.status === STATUS.UNCHECKED || c.status === STATUS.ERROR)) {
      const free = document.createElement('div');
      free.className = 'muted-note';
      free.textContent = 'You looked this one up recently, so the answer is already saved. No call will be made.';
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

    if (c.status === STATUS.NO_KEY) {
      const p = document.createElement('div');
      p.className = 'summary';
      p.textContent = 'This search provider needs an API key. Add one in settings, or use "Search in browser", which needs none. ';
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
        row.appendChild(cite);
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

function focusClaim(claimId) {
  const el = feed.querySelector(`[data-claim-id="${claimId}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('fc-focused');
  setTimeout(() => el.classList.remove('fc-focused'), 1600);
}

// The service worker cannot reach the browser's built-in model, so it delegates
// the call here, where a document context exists.
// The worker marks the claim as summarizing and will not touch it again until an
// answer comes back, so every path out of here has to send one. Returning quietly
// because the provider changed under us left the claim's buttons dead.
async function runInPageLlm(msg) {
  const answer = (payload) =>
    chrome.runtime.sendMessage({ type: MSG.LLM_RESULT, claimId: msg.claimId, ...payload }).catch(() => {});

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
    const analysis = await llm.crossReference(msg.claim, msg.results, settings.llmApiKey);
    return answer({ analysis });
  } catch (err) {
    return answer({ error: err.message });
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

// Settings apply to sentences the extension has not judged yet, so changing the
// threshold does nothing to the page already on screen. This throws away what both
// sides remember about this tab and reads the page again.
// The guide answers what the panel cannot: what the scores mean, where keys come
// from, and what each button spends.
document.getElementById('guideLink')?.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html#guide') });
});

const rescanBtn = document.getElementById('rescan');
rescanBtn?.addEventListener('click', async () => {
  rescanBtn.disabled = true;
  const label = rescanBtn.textContent;
  rescanBtn.textContent = 'Rescanning…';
  feed.replaceChildren();
  await chrome.runtime.sendMessage({ type: MSG.RESCAN }).catch(() => {});
  setTimeout(() => {
    rescanBtn.disabled = false;
    rescanBtn.textContent = label;
  }, 1200);
});

toggle.addEventListener('change', () => {
  chrome.runtime
    .sendMessage({ type: MSG.SET_AUTOCHECK, autoCheck: toggle.checked })
    .catch(() => {});
});

// The panel's own text size, for anyone who finds the default hard going.
function applyPanelSize(settings) {
  document.documentElement.style.setProperty('--fc-panel-size', panelTextSize(settings));
}

// Changing the AI provider or the appearance in settings takes effect here without
// the panel needing to be reopened.
chrome.storage.onChanged.addListener(async () => {
  const s = await getSettings();
  applyPanelSize(s);
  if (isFormat(s.citationFormat) && s.citationFormat !== citationFormat) {
    // Changed in another window; follow it without writing it back.
    citationFormat = s.citationFormat;
    for (const el of formatPickers) el.value = citationFormat;
  }
  const next = s.llmProvider !== 'none';
  const keyed = keyedSearch(s);
  toggle.checked = s.autoCheck;
  if (next !== llmEnabled || keyed !== searchKeyed) {
    llmEnabled = next;
    searchKeyed = keyed;
    render(lastClaims);
  }
});

(async () => {
  const settings = await getSettings();
  applyPanelSize(settings);
  llmEnabled = settings.llmProvider !== 'none';
  searchKeyed = keyedSearch(settings);
  if (isFormat(settings.citationFormat)) citationFormat = settings.citationFormat;
  toggle.checked = settings.autoCheck;
  const res = await chrome.runtime.sendMessage({ type: MSG.PANEL_READY }).catch(() => null);
  render(res?.claims || []);
  if (res?.page) renderPageStatus({ ...res.page, tabId: res.tabId });
})();
