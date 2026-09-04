// Shared message contract between content scripts, background worker, and side panel.
// Every message is { type, ...payload }. Tab id is attached by the background worker
// from sender.tab, never trusted from the message body.

export const MSG = {
  // content script -> background
  SENTENCES: 'sentences',           // { sentences: [{id, text, ts?}] }
  HIGHLIGHT_CLICKED: 'highlightClicked', // { claimId }
  GET_STATE: 'getState',            // content asks whether to scan at all
  PAGE_CHANGED: 'pageChanged',      // { url } -> same document, new page (SPA navigation)

  // background -> content script
  SCAN_CONFIG: 'scanConfig',        // { autoCheck }
  CLAIM_STATUS: 'claimStatus',      // { claims: [{id, status}] } -> draw/update highlights
  FOCUS_SENTENCE: 'focusSentence',  // { claimId } -> scroll page to it

  // background -> side panel
  PANEL_UPDATE: 'panelUpdate',      // { tabId, claims: Claim[] }
  PANEL_FOCUS: 'panelFocus',        // { claimId }

  // side panel -> background
  PANEL_READY: 'panelReady',        // { } -> reply with current tab's claims
  SET_AUTOCHECK: 'setAutoCheck',    // { autoCheck }
  FOCUS_CLAIM: 'focusClaim',        // { claimId } -> forward to content script
  CHECK_CLAIM: 'checkClaim',        // { claimId } -> user asked to spend a search call
};

// Claim: { id, text, ts?, status, score, results?: SearchResult[], summary?, error? }
export const STATUS = {
  UNCHECKED: 'unchecked', // flagged, but no search call spent on it yet
  PENDING: 'pending',
  CHECKED: 'checked',
  ERROR: 'error',
  NO_KEY: 'noKey',
};

export const SETTINGS_KEY = 'fc_settings';

export const DEFAULT_SETTINGS = {
  autoCheck: true,
  threshold: 0.6,
  searchProvider: 'serpapi',
  searchApiKey: '',
  llmProvider: 'none',
  llmApiKey: '',
};

export async function getSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] || {}) };
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}
