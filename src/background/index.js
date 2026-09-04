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

// withAi false: fetch sources only. withAi true: also summarize them. If sources are
// already fetched, summarizing costs no further search call.
async function requestCheck(claimId, withAi) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id == null) return;
  const claim = tabs.get(tab.id)?.claims.get(claimId);
  if (!claim || claim.status === STATUS.PENDING || claim.summarizing) return;

  const settings = await getSettings();

  if (withAi && claim.results?.length) {
    summarize(tab.id, claim, settings);
    return;
  }

  if (!settings.searchApiKey) {
    claim.status = STATUS.NO_KEY;
    pushPanel(tab.id);
    return;
  }

  claim.status = STATUS.PENDING;
  claim.error = undefined;
  pushPanel(tab.id);
  pushHighlights(tab.id, [claim]);
  enqueue(() => checkClaim(tab.id, claimId, settings, withAi));
}

async function summarize(tabId, claim, settings) {
  const llm = getLlmProvider(settings.llmProvider);
  if (llm.id === 'none' || !claim.results?.length) return;

  claim.summarizing = true;
  claim.error = undefined;
  pushPanel(tabId);

  if (llm.runsInPage) {
    // The browser's built-in model only exists in a document context, so the side
    // panel runs it and returns the summary via LLM_RESULT. No panel open means no
    // summary, which is fine since summaries are only ever read there.
    chrome.runtime
      .sendMessage({
        type: MSG.LLM_REQUEST,
        claimId: claim.id,
        claim: claim.text,
        results: claim.results,
      })
      .catch(() => {
        claim.summarizing = false;
        pushPanel(tabId);
      });
    return;
  }

  try {
    claim.analysis = await llm.crossReference(claim.text, claim.results, settings.llmApiKey, {
      url: settings.localLlmUrl,
      model: settings.localLlmModel,
    });
  } catch (err) {
    claim.analysis = null;
    claim.error = `Summary unavailable: ${err.message}`;
  }
  claim.summarizing = false;
  pushPanel(tabId);
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

async function checkClaim(tabId, claimId, settings, withAi = false) {
  const state = tabs.get(tabId);
  const claim = state?.claims.get(claimId);
  if (!claim) return;

  try {
    const search = getSearchProvider(settings.searchProvider);
    claim.results = await search.search(claim.text, settings.searchApiKey);
    claim.status = STATUS.CHECKED;

    if (withAi) await summarize(tabId, claim, settings);
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

    case MSG.LLM_RESULT:
      chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
        const claim = tab?.id != null && tabs.get(tab.id)?.claims.get(msg.claimId);
        if (!claim) return;
        claim.summarizing = false;
        if (msg.analysis) claim.analysis = msg.analysis;
        if (msg.error) claim.error = `Summary unavailable: ${msg.error}`;
        pushPanel(tab.id);
      });
      return false;

    case MSG.CHECK_CLAIM:
      requestCheck(msg.claimId, Boolean(msg.withAi));
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
