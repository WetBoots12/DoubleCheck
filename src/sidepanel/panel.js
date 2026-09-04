import { MSG, STATUS, getSettings } from '../shared/messages.js';
import { getLlmProvider } from '../providers/index.js';

const feed = document.getElementById('feed');
const toggle = document.getElementById('autocheck');

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
    feed.innerHTML = '<div class="empty">Nothing flagged yet on this page.</div>';
    return;
  }

  for (const c of [...claims].reverse()) {
    const el = document.createElement('div');
    el.className = 'claim';
    el.dataset.claimId = c.id;

    const text = document.createElement('div');
    text.className = 'claim-text';
    text.textContent = c.text;
    text.title = 'Jump to this on the page';
    text.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: MSG.FOCUS_CLAIM, claimId: c.id }).catch(() => {});
    });
    el.appendChild(text);

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.innerHTML = `<span class="badge ${c.status}">${STATUS_LABEL[c.status] || c.status}</span>`;
    if (c.ts != null) meta.innerHTML += `<span>${fmtTime(c.ts)}</span>`;
    if (c.score != null) meta.innerHTML += `<span>score ${c.score}</span>`;
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
    } else if (c.status === STATUS.CHECKED && llmEnabled && !c.summary) {
      // Sources are already paid for; summarizing them costs no further search call.
      addButton('Summarize with AI', 'Asking the AI…', true, false);
    }

    if (actions.childElementCount) el.appendChild(actions);

    if (c.status === STATUS.NO_KEY) {
      const p = document.createElement('div');
      p.className = 'summary';
      p.innerHTML = 'Add a search API key to cross-reference this. ';
      const b = document.createElement('button');
      b.className = 'link';
      b.textContent = 'Open settings';
      b.addEventListener('click', () => chrome.runtime.openOptionsPage());
      p.appendChild(b);
      el.appendChild(p);
    }

    if (c.summary) {
      const s = document.createElement('div');
      s.className = 'summary';
      s.textContent = c.summary;
      el.appendChild(s);
    }

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
    const summary = await llm.crossReference(msg.claim, msg.results, settings.llmApiKey);
    chrome.runtime.sendMessage({ type: MSG.LLM_RESULT, claimId: msg.claimId, summary }).catch(() => {});
  } catch (err) {
    chrome.runtime
      .sendMessage({ type: MSG.LLM_RESULT, claimId: msg.claimId, error: err.message })
      .catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === MSG.PANEL_UPDATE) render(msg.claims || []);
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
})();
