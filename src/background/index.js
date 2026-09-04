// Orchestrator: sentences in -> scored -> flagged -> searched -> (optionally) summarized
// -> pushed to side panel + highlighted on the page. Per-tab state is in-memory; it
// resets when the service worker restarts, which is acceptable for v1.

import { MSG, STATUS, getSettings, saveSettings } from '../shared/messages.js';
import { scoreClaimWorthiness } from '../../classifier/inference/classifier.js';
import { getSearchProvider, getLlmProvider, ProviderError } from '../providers/index.js';

const tabs = new Map(); // tabId -> { claims: Map<id, Claim>, seen: Set<textKey> }
const MAX_INFLIGHT = 3;
let inflight = 0;
const queue = [];

function stateFor(tabId) {
  if (!tabs.has(tabId)) tabs.set(tabId, { claims: new Map(), seen: new Set() });
  return tabs.get(tabId);
}

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.tabs.onRemoved.addListener((tabId) => tabs.delete(tabId));

// Any URL change resets the tab: a real load reports a status, while a single-page-app
// navigation (history.pushState) reports only a url. Requiring both missed every SPA.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url) resetTab(tabId);
});

function resetTab(tabId) {
  tabs.delete(tabId);
  updateBadge(tabId);
  pushPanel(tabId);
}

chrome.tabs.onActivated.addListener(({ tabId }) => {
  updateBadge(tabId);
  pushPanel(tabId);
});

function updateBadge(tabId) {
  const count = tabs.get(tabId)?.claims.size || 0;
  chrome.action.setBadgeText({ tabId, text: count ? String(count) : '' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#b4462d' }).catch(() => {});
}

// Only the active tab may drive the panel, otherwise a background tab navigating
// blanks whatever the user is currently reading.
async function pushPanel(tabId) {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!active || active.id !== tabId) return;
  const claims = [...(tabs.get(tabId)?.claims.values() || [])];
  chrome.runtime
    .sendMessage({ type: MSG.PANEL_UPDATE, tabId, claims })
    .catch(() => {}); // no panel open — fine
}

function pushHighlights(tabId, claims) {
  chrome.tabs
    .sendMessage(tabId, {
      type: MSG.CLAIM_STATUS,
      claims: claims.map((c) => ({ id: c.id, text: c.text, status: c.status })),
    })
    .catch(() => {});
}

// --- pipeline ---------------------------------------------------------------

async function handleSentences(tabId, sentences) {
  const settings = await getSettings();
  if (!settings.autoCheck) return;

  const state = stateFor(tabId);
  const fresh = sentences.filter((s) => {
    const key = s.text.trim().toLowerCase();
    if (!key || state.seen.has(key)) return false;
    state.seen.add(key);
    return true;
  });
  if (!fresh.length) return;

  const scores = await scoreClaimWorthiness(fresh.map((s) => s.text));
  const flagged = [];
  fresh.forEach((s, i) => {
    if (scores[i] < settings.threshold) return;
    const claim = {
      id: s.id,
      text: s.text,
      ts: s.ts,
      score: Number(scores[i].toFixed(2)),
      status: settings.searchApiKey ? STATUS.UNCHECKED : STATUS.NO_KEY,
    };
    state.claims.set(claim.id, claim);
    flagged.push(claim);
  });
  if (!flagged.length) return;

  updateBadge(tabId);
  pushPanel(tabId);
  pushHighlights(tabId, flagged);
  // No search call is made here. Claims stay UNCHECKED until the user asks for one
  // from the side panel, so a text-heavy page cannot burn through their quota.
}

async function requestCheck(claimId) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id == null) return;
  const claim = tabs.get(tab.id)?.claims.get(claimId);
  if (!claim || claim.status === STATUS.PENDING) return;

  const settings = await getSettings();
  if (!settings.searchApiKey) {
    claim.status = STATUS.NO_KEY;
    pushPanel(tab.id);
    return;
  }

  claim.status = STATUS.PENDING;
  claim.error = undefined;
  pushPanel(tab.id);
  pushHighlights(tab.id, [claim]);
  enqueue(() => checkClaim(tab.id, claimId, settings));
}

function enqueue(job) {
  queue.push(job);
  drain();
}

function drain() {
  while (inflight < MAX_INFLIGHT && queue.length) {
    const job = queue.shift();
    inflight++;
    job().finally(() => {
      inflight--;
      drain();
    });
  }
}

async function checkClaim(tabId, claimId, settings) {
  const state = tabs.get(tabId);
  const claim = state?.claims.get(claimId);
  if (!claim) return;

  try {
    const search = getSearchProvider(settings.searchProvider);
    claim.results = await search.search(claim.text, settings.searchApiKey);
    claim.status = STATUS.CHECKED;

    const llm = getLlmProvider(settings.llmProvider);
    if (llm.id !== 'none' && claim.results.length && (await llm.isAvailable())) {
      try {
        claim.summary = await llm.crossReference(claim.text, claim.results, settings.llmApiKey);
      } catch (err) {
        claim.summary = '';
        claim.error = `Summary unavailable: ${err.message}`;
      }
    }
  } catch (err) {
    claim.status = err instanceof ProviderError && err.kind === 'noKey' ? STATUS.NO_KEY : STATUS.ERROR;
    claim.error = err.message;
  }

  state.claims.set(claimId, claim);
  pushPanel(tabId);
  pushHighlights(tabId, [claim]);
}

// --- messaging --------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  switch (msg.type) {
    case MSG.GET_STATE:
      getSettings().then((s) => sendResponse({ autoCheck: s.autoCheck }));
      return true;

    case MSG.PAGE_CHANGED:
      if (tabId != null) resetTab(tabId);
      return false;

    case MSG.SENTENCES:
      if (tabId != null) handleSentences(tabId, msg.sentences || []);
      return false;

    case MSG.HIGHLIGHT_CLICKED:
      chrome.runtime.sendMessage({ type: MSG.PANEL_FOCUS, claimId: msg.claimId }).catch(() => {});
      return false;

    case MSG.PANEL_READY:
      chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
        sendResponse({
          tabId: tab?.id,
          claims: [...(tabs.get(tab?.id)?.claims.values() || [])],
        });
      });
      return true;

    case MSG.SET_AUTOCHECK:
      saveSettings({ autoCheck: msg.autoCheck }).then(() => {
        chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
          if (tab?.id != null) {
            chrome.tabs
              .sendMessage(tab.id, { type: MSG.SCAN_CONFIG, autoCheck: msg.autoCheck })
              .catch(() => {});
          }
        });
        sendResponse({ ok: true });
      });
      return true;

    case MSG.CHECK_CLAIM:
      requestCheck(msg.claimId);
      return false;

    case MSG.FOCUS_CLAIM:
      chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
        if (tab?.id != null) {
          chrome.tabs
            .sendMessage(tab.id, { type: MSG.FOCUS_SENTENCE, claimId: msg.claimId })
            .catch(() => {});
        }
      });
      return false;

    default:
      return false;
  }
});
