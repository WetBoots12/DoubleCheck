// Orchestrator: sentences in -> scored -> flagged -> searched -> (optionally) summarized
// -> pushed to side panel + highlighted on the page.
//
// Per-tab state lives in chrome.storage.session via tabstate.js, so it survives the
// service worker being put to sleep, which Manifest V3 does after ~30s idle. Every
// mutation is followed by a save. The job queue is deliberately in-memory: it only
// holds work the user just asked for, a fetch in flight keeps the worker alive until
// it completes, and a tab that navigates or closes has its queued jobs dropped so
// no search call is spent on a page nobody is reading any more.

import { MSG, STATUS, getSettings, saveSettings } from '../shared/messages.js';
import { scoreClaimWorthiness } from '../../classifier/inference/classifier.js';
import {
  getSearchProvider,
  getLlmProvider,
  getFactCheckProvider,
  originDomain,
  searchQuery,
  ProviderError,
} from '../providers/index.js';
import { tabStore } from './tabstate.js';
import { createQueue } from './queue.js';

const queue = createQueue(3);

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// A worker that died mid-check left claims spinning; put them back to actionable.
tabStore.recoverStale().catch(() => {});

chrome.tabs.onRemoved.addListener((tabId) => {
  queue.drop(tabId);
  tabStore.clear(tabId).catch(() => {});
});

// Any URL change resets the tab: a real load reports a status, while a single-page-app
// navigation (history.pushState) reports only a url. Requiring both missed every SPA.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url) resetTab(tabId);
});

async function resetTab(tabId) {
  queue.drop(tabId);
  await tabStore.clear(tabId);
  updateBadge(tabId);
  pushPanel(tabId);
}

chrome.tabs.onActivated.addListener(({ tabId }) => {
  updateBadge(tabId);
  pushPanel(tabId);
});

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

async function updateBadge(tabId) {
  const state = await tabStore.peek(tabId);
  const count = state?.claims.size || 0;
  chrome.action.setBadgeText({ tabId, text: count ? String(count) : '' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#b4462d' }).catch(() => {});
}

// Only the active tab may drive the panel, otherwise a background tab navigating
// blanks whatever the user is currently reading.
async function pushPanel(tabId) {
  if ((await activeTabId()) !== tabId) return;
  const state = await tabStore.peek(tabId);
  const claims = [...(state?.claims.values() || [])];
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

  const state = await tabStore.get(tabId);
  const fresh = sentences.filter((s) => {
    const key = s.text.trim().toLowerCase();
    if (!key || state.seen.has(key)) return false;
    state.seen.add(key);
    return true;
  });
  if (!fresh.length) {
    await tabStore.save(tabId); // seen changed even if nothing was flagged
    return;
  }

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
  await tabStore.save(tabId);
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
  const tabId = await activeTabId();
  if (tabId == null) return;
  const state = await tabStore.peek(tabId);
  const claim = state?.claims.get(claimId);
  if (!claim || claim.status === STATUS.PENDING || claim.summarizing) return;

  const settings = await getSettings();

  if (withAi && claim.results?.length) {
    summarize(tabId, claim, settings);
    return;
  }

  if (!settings.searchApiKey) {
    claim.status = STATUS.NO_KEY;
    await tabStore.save(tabId);
    pushPanel(tabId);
    return;
  }

  claim.status = STATUS.PENDING;
  claim.error = undefined;
  await tabStore.save(tabId);
  pushPanel(tabId);
  pushHighlights(tabId, [claim]);
  queue.push(tabId, () => checkClaim(tabId, claimId, settings, withAi));
}

async function summarize(tabId, claim, settings) {
  const llm = getLlmProvider(settings.llmProvider);
  if (llm.id === 'none' || !claim.results?.length) return;

  claim.summarizing = true;
  claim.error = undefined;
  await tabStore.save(tabId);
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
      .catch(async () => {
        claim.summarizing = false;
        await tabStore.save(tabId);
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
  await tabStore.save(tabId);
  pushPanel(tabId);
}

// The page being read must not be offered as its own corroboration, so its domain
// is excluded from the search. Empty when the tab cannot be read.
async function tabOrigin(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return originDomain(tab?.url || '');
  } catch {
    return '';
  }
}

async function checkClaim(tabId, claimId, settings, withAi = false) {
  const state = await tabStore.peek(tabId);
  const claim = state?.claims.get(claimId);
  if (!claim) return; // tab was reset or closed while queued

  try {
    const search = getSearchProvider(settings.searchProvider);
    const factCheck = getFactCheckProvider(settings.factCheckProvider);
    const excludeDomain = await tabOrigin(tabId);
    // Verbatim by default. Distillation is an opt-in until it has been measured.
    const query = settings.distillQueries ? searchQuery(claim.text) : claim.text;

    // Published fact-checks come back with the search results, from the same button.
    // A failure to find any must not lose the search results, so it is caught apart.
    const [results, factChecks] = await Promise.all([
      search.search(query, settings.searchApiKey, { excludeDomain }),
      settings.factCheckApiKey
        ? factCheck.lookup(claim.text, settings.factCheckApiKey).catch((err) => {
            claim.factCheckError = err.message;
            return [];
          })
        : Promise.resolve([]),
    ]);

    claim.results = results;
    claim.factChecks = factChecks;
    claim.status = STATUS.CHECKED;
    await tabStore.save(tabId);

    if (withAi) await summarize(tabId, claim, settings);
  } catch (err) {
    claim.status = err instanceof ProviderError && err.kind === 'noKey' ? STATUS.NO_KEY : STATUS.ERROR;
    claim.error = err.message;
  }

  await tabStore.save(tabId);
  pushPanel(tabId);
  pushHighlights(tabId, [claim]);
}

async function sendToActiveTab(message) {
  const tabId = await activeTabId();
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, message).catch(() => {});
}

// Keyboard shortcuts, so claims can be stepped through without opening the panel.
// Ctrl+F itself belongs to the browser and cannot be taken.
chrome.commands?.onCommand.addListener((command) => {
  if (command === 'next-claim') sendToActiveTab({ type: MSG.NAV_CLAIM, direction: 'next' });
  else if (command === 'prev-claim') sendToActiveTab({ type: MSG.NAV_CLAIM, direction: 'prev' });
});

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

    case MSG.UNLOCATED:
      if (tabId != null) {
        tabStore.peek(tabId).then(async (state) => {
          if (!state) return;
          for (const id of msg.ids || []) {
            const claim = state.claims.get(id);
            if (claim) claim.located = false;
          }
          await tabStore.save(tabId);
          pushPanel(tabId);
        });
      }
      return false;

    case MSG.SENTENCES:
      if (tabId != null) handleSentences(tabId, msg.sentences || []);
      return false;

    case MSG.HIGHLIGHT_CLICKED:
      chrome.runtime.sendMessage({ type: MSG.PANEL_FOCUS, claimId: msg.claimId }).catch(() => {});
      return false;

    case MSG.PANEL_READY:
      activeTabId().then(async (id) => {
        const state = id == null ? null : await tabStore.peek(id);
        sendResponse({ tabId: id, claims: [...(state?.claims.values() || [])] });
      });
      return true;

    case MSG.SET_AUTOCHECK:
      saveSettings({ autoCheck: msg.autoCheck }).then(() => {
        sendToActiveTab({ type: MSG.SCAN_CONFIG, autoCheck: msg.autoCheck });
        sendResponse({ ok: true });
      });
      return true;

    case MSG.LLM_RESULT:
      activeTabId().then(async (id) => {
        const state = id == null ? null : await tabStore.peek(id);
        const claim = state?.claims.get(msg.claimId);
        if (!claim) return;
        claim.summarizing = false;
        if (msg.analysis) claim.analysis = msg.analysis;
        if (msg.error) claim.error = `Summary unavailable: ${msg.error}`;
        await tabStore.save(id);
        pushPanel(id);
      });
      return false;

    case MSG.CHECK_CLAIM:
      requestCheck(msg.claimId, Boolean(msg.withAi));
      return false;

    case MSG.NAV_CLAIM:
      sendToActiveTab({ type: MSG.NAV_CLAIM, direction: msg.direction });
      return false;

    case MSG.NAV_STATE:
      // Straight through to the panel's find-bar counter.
      chrome.runtime
        .sendMessage({
          type: MSG.NAV_STATE,
          claimId: msg.claimId,
          index: msg.index,
          total: msg.total,
        })
        .catch(() => {});
      return false;

    case MSG.FOCUS_CLAIM:
      sendToActiveTab({ type: MSG.FOCUS_SENTENCE, claimId: msg.claimId });
      return false;

    default:
      return false;
  }
});
