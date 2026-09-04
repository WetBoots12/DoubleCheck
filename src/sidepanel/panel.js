import { MSG, STATUS, getSettings, saveSettings } from '../shared/messages.js';

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

function render(claims) {
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

    // Search calls cost the user quota, so nothing is fetched until they ask.
    if (c.status === STATUS.UNCHECKED || c.status === STATUS.ERROR) {
      const check = document.createElement('button');
      check.className = 'check';
      check.textContent = c.status === STATUS.ERROR ? 'Try again' : 'Check sources';
      check.addEventListener('click', () => {
        check.disabled = true;
        check.textContent = 'Checking…';
        chrome.runtime.sendMessage({ type: MSG.CHECK_CLAIM, claimId: c.id }).catch(() => {});
      });
      el.appendChild(check);
    }

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

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === MSG.PANEL_UPDATE) render(msg.claims || []);
  else if (msg.type === MSG.PANEL_FOCUS) focusClaim(msg.claimId);
});

toggle.addEventListener('change', () => {
  chrome.runtime
    .sendMessage({ type: MSG.SET_AUTOCHECK, autoCheck: toggle.checked })
    .catch(() => {});
});

(async () => {
  toggle.checked = (await getSettings()).autoCheck;
  const res = await chrome.runtime.sendMessage({ type: MSG.PANEL_READY }).catch(() => null);
  render(res?.claims || []);
})();
