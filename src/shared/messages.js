import { DEFAULT_APPEARANCE } from './appearance.js';

// Shared message contract between content scripts, background worker, and side panel.
// Every message is { type, ...payload }. Tab id is attached by the background worker
// from sender.tab, never trusted from the message body.

export const MSG = {
  // content script -> background
  SENTENCES: 'sentences',           // { sentences: [{id, text, ts?}] }
  HIGHLIGHT_CLICKED: 'highlightClicked', // { claimId }
  GET_STATE: 'getState',            // content asks whether to scan at all
  UNLOCATED: 'unlocated',           // { ids } -> claims with no highlight on the page
  CAPTION_HINT: 'captionHint',      // { hint: 'off' | 'none' | null } -> panel banner, video pages only
  PAGE_PRIVATE: 'pagePrivate',      // { reason: 'fields' } -> page has a password or card field
  PAGE_LANGUAGE: 'pageLanguage',    // { language } -> the page is not in English, so it was not scanned
  PAGE_SOURCES: 'pageSources',      // { domains } -> publishers behind this page, e.g. the wire it came from
  OPEN_TRANSCRIPT: 'openTranscript', // {} -> ask the video script to open YouTube's transcript panel
  RESCAN: 'rescan',                 // {} -> throw away this page's claims and read it again
  PAGE_CHANGED: 'pageChanged',      // { url } -> same document, new page (SPA navigation)

  // background -> content script
  SCAN_CONFIG: 'scanConfig',        // { autoCheck, scanAllowed }
  CLAIM_STATUS: 'claimStatus',      // { claims: [{id, status}] } -> draw/update highlights
  FOCUS_SENTENCE: 'focusSentence',  // { claimId } -> scroll page to it
  NAV_CLAIM: 'navClaim',            // { direction: 'next' | 'prev' } -> step like Ctrl+F

  // background -> side panel
  PANEL_UPDATE: 'panelUpdate',      // { tabId, claims: Claim[] }
  PANEL_FOCUS: 'panelFocus',        // { claimId }
  PAGE_STATUS: 'pageStatus',        // { tabId, blocked, reason, domain, rule } -> banner + thumbs
  NAV_STATE: 'navState',            // { claimId, index, total } -> find-bar counter

  // side panel -> background
  PANEL_READY: 'panelReady',        // { } -> reply with current tab's claims
  SET_AUTOCHECK: 'setAutoCheck',    // { autoCheck }
  FOCUS_CLAIM: 'focusClaim',        // { claimId } -> forward to content script
  CLEAR_CACHE: 'clearCache',        // {} -> empty the remembered provider answers
  CHECK_CLAIM: 'checkClaim',        // { claimId } -> user asked to spend a search call
  BROWSER_SEARCH: 'browserSearch',  // { claimId } -> open the claim in the browser's default search engine
  CITE_SOURCES: 'citeSources',      // { claimId, url? } -> citable records for one source, or all of a claim's
  CITE_MATERIAL: 'citeMaterial',    // { claimId, url } -> what a model may read to fill a citation's gaps
  ADD_SOURCE: 'addSource',          // {} -> keep the current page in the works cited list
  LIST_SOURCES: 'listSources',      // {} -> the kept list, for the options page
  REMOVE_SOURCE: 'removeSource',    // { key } -> drop one
  CLEAR_SOURCES: 'clearSources',    // {} -> drop them all

  // background -> content script
  PAGE_META: 'pageMeta',            // {} -> the page describes itself for a citation
  SITE_RULE: 'siteRule',            // { domain, action: 'allow' | 'block' } -> thumbs up / down

  // The browser's built-in model needs a document context, so the panel runs it.
  LLM_REQUEST: 'llmRequest',        // background -> panel { claimId, claim, results }
  LLM_RESULT: 'llmResult',          // panel -> background { claimId, summary?, error? }
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

// A sentence scoring just under the flagging threshold is not nothing. It is
// drawn faintly, dashed on the page and dimmed in the panel, so a reader can see it
// without being told it is a claim. The band is fixed at 0.20 below the threshold,
// so the default of 0.70 gives faint flags from 0.50, and it moves with the slider
// rather than needing a second one.
export const FAINT_BAND = 0.2;

export function faintThreshold(threshold) {
  return Math.max(0.2, Number(threshold) - FAINT_BAND);
}

export const DEFAULT_SETTINGS = {
  autoCheck: true,
  threshold: 0.7,
  faintFlags: true,      // also mark sentences scoring within FAINT_BAND below the threshold, faintly
  browserSearchEngine: 'default', // which engine the Search in browser button asks, and how; see shared/engines.js
  searchProvider: 'wikipedia', // needs no key, so the extension works out of the box; keyed providers are the upgrade
  searchApiKey: '',
  distillQueries: false, // shorten long claims before web search; see tools/query-compare.html
  academicMode: false,   // bias web search toward scholarly sources and ask OpenAlex for peer-reviewed work
  privateSitesRule: true, // built-in never-scan rules for banks, health, mail, accounts, local addresses
  blockedDomains: [],     // the user's never-scan list; always wins
  allowedDomains: [],     // the user's always-scan list; overrides the built-in rules
  trustedDomains: [],     // sources the user rates highly; see shared/evidence.js
  distrustedDomains: [],  // sources the user rates weak
  readSources: true,      // read the top results' own pages, not just their snippets
  citationFormat: 'mla',  // which style the Cite button copies; chosen on the panel, remembered here
  autoCitationData: false, // read every result's author and title during a check, rather than when cited
  ...DEFAULT_APPEARANCE,  // highlight colour and style, panel text size; see shared/appearance.js
  cacheResults: true,     // remember search, fact-check and AI answers for a day; see shared/cache.js
  factCheckProvider: 'google',
  factCheckApiKey: '',
  llmProvider: 'none',
  llmApiKey: '',
  llmModel: '', // optional override for the Anthropic/OpenAI model; empty = provider default
  localLlmUrl: 'http://localhost:11434/v1',
  localLlmModel: 'llama3.1',
};

export async function getSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] || {}) };
}

// Saving is a read, a change and a write, which is three chances for a second save
// to start before the first has finished. Both of them then read the same settings,
// and the one that writes last silently discards the other's change. It happens for
// real: the options page and the side panel are both open, the reader drags the
// confidence slider while pressing the thumbs-down on a site, and one of the two
// does nothing. Measured with three concurrent saves, two were lost.
//
// So saves are queued. Each one reads only after the one before it has written.
// This is the same fix, for the same reason, as the serialized index writes in
// shared/cache.js.
let settingsQueue = Promise.resolve();

export async function saveSettings(patch) {
  const work = async () => {
    const current = await getSettings();
    const next = { ...current, ...patch };
    await chrome.storage.local.set({ [SETTINGS_KEY]: next });
    return next;
  };
  const next = settingsQueue.then(work, work);
  settingsQueue = next.then(() => {}, () => {}); // a failed save must not stall the queue
  return next;
}
