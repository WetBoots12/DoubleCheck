// Orchestrator: sentences in -> scored -> flagged -> searched -> (optionally) summarized
// -> pushed to side panel + highlighted on the page.
//
// Per-tab state lives in chrome.storage.session via tabstate.js, so it survives the
// service worker being put to sleep, which Manifest V3 does after ~30s idle. Every
// mutation is followed by a save. The job queue is deliberately in-memory: it only
// holds work the user just asked for, a fetch in flight keeps the worker alive until
// it completes, and a tab that navigates or closes has its queued jobs dropped so
// no search call is spent on a page nobody is reading any more.

import { MSG, STATUS, getSettings as loadSettings, saveSettings as persistSettings, faintThreshold } from '../shared/messages.js';
import { scoreClaimWorthiness, explainClaim } from '../../classifier/inference/classifier.js';
import {
  getSearchProvider,
  getLlmProvider,
  getFactCheckProvider,
  getScholarProvider,
  originDomain,
  searchQuery,
  browserQuery,
  fetchPageHtml,
  ProviderError,
} from '../providers/index.js';
import { extractParagraphs, relevantExcerpt } from '../shared/extract.js';
import { publishedDateFromHtml } from '../shared/dates.js';
import { metadataFromHtml } from '../shared/metadata.js';
import { sourcesForClaim, missingFields } from '../shared/citation.js';
import { makeSource, sourceKey } from '../shared/sources.js';
import { engineStyle, searchUrl } from '../shared/engines.js';
import { tabStore, privateTabs } from './tabstate.js';
import { sourceStore } from './sourcestore.js';
import { evaluateUrl, applySiteRule, normalizeDomain, httpUrl, publicSourceUrl } from '../shared/privacy.js';
import { scoreEvidence } from '../shared/evidence.js';
import { createCache, cacheKey } from '../shared/cache.js';
// Content scripts are classic scripts and cannot import, so the worker computes the
// appearance and sends it as plain values with every state reply.
import { highlightVars, highlightStyleName } from '../shared/appearance.js';

// Reuse settings until storage changes; all document writes still go through
// the worker. Tests without a storage event API use uncached reads.
let settingsSnapshot = null;
let settingsPending = null;
let settingsRevision = 0;
function invalidateSettings() {
  settingsRevision++;
  settingsSnapshot = null;
  settingsPending = null;
}
async function getSettings() {
  if (!chrome.storage.onChanged) return loadSettings();
  if (settingsSnapshot) return settingsSnapshot;
  if (!settingsPending) {
    const revision = settingsRevision;
    settingsPending = loadSettings().then((value) => {
      if (revision !== settingsRevision) return getSettings();
      settingsSnapshot = value;
      settingsPending = null;
      return value;
    }).catch((err) => { settingsPending = null; throw err; });
  }
  return settingsPending;
}
async function saveSettings(patch) {
  const value = await persistSettings(patch);
  invalidateSettings();
  return value;
}

function appearanceOf(settings) {
  return {
    vars: highlightVars(settings),
    style: highlightStyleName(settings),
    showVideoOverlay: settings.showVideoOverlay !== false,
    autoTranscript: settings.autoTranscript !== false,
  };
}

// Provider answers are remembered for a day on the user's own machine, so reading a
// second article about the same event, or re-opening a page, does not spend another
// search call or another paid AI call on a question already answered. Nothing about
// when a call happens changes: a check still runs only when the user clicks.
// Guarded the way tabstate.js guards the session store, so importing this module
// somewhere without a full chrome stub does not throw at load. A cache that stores
// nothing simply means every check pays for its call, which is the old behaviour.
const cache = createCache(
  typeof chrome !== 'undefined' && chrome.storage?.local
    ? chrome.storage.local
    : { get: async () => ({}), set: async () => {}, remove: async () => {} },
);

async function remember(settings, kind, parts, fn) {
  if (!settings.cacheResults) return fn();
  return cache.wrap(cacheKey(kind, parts), fn);
}

// The thermometer's number: measured relevance, verbiage and source tier, plus the
// AI's per-source stances when it ran and any published fact-check. Recomputed
// whenever one of those inputs changes. See shared/evidence.js.
function computeEvidence(claim, settings) {
  const sources = [
    ...(claim.results || []),
    ...(claim.scholar || []).map((w) => ({ url: w.url, title: w.title, snippet: w.venue, academic: true })),
  ];
  claim.evidence = scoreEvidence(claim.text, sources, {
    stances: claim.analysis?.stances || null,
    factChecks: claim.factChecks || [],
    tiers: { trusted: settings.trustedDomains || [], distrusted: settings.distrustedDomains || [] },
  });
}
import { createQueue } from './queue.js';

const queue = createQueue(3);

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// A worker that died mid-check left claims spinning; put them back to actionable.
const startupReady = Promise.all([tabStore.recoverStale(), loadSettings().then((s) => s.cacheResults ? cache.sweep() : cache.clear())]).catch(() => {});
chrome.storage.onChanged?.addListener((changes, area) => {
  if (area === 'local' && changes.fc_settings) invalidateSettings();
  if (area === 'local' && changes.fc_settings?.newValue?.cacheResults === false) cache.clear().catch(() => {});
});

async function settingsForTab(tabId) {
  const settings = await getSettings();
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  return !tab || tab.incognito ? { ...settings, cacheResults: false } : settings;
}

function pageIdentity(url) {
  // Preserve hash-router paths; ordinary in-document anchors do not change pages.
  const value = String(url || '');
  return /#(?:!|\/)/.test(value) ? value : value.split('#')[0];
}
const navigationQueues = new Map();
function navigateTab(tabId, url, reload = false) {
  const work = async () => {
    const key = `page:${tabId}`;
    const previous = (await chrome.storage.session.get(key))[key];
    const next = pageIdentity(url);
    if (!reload && previous === next) return;
    await resetTab(tabId);
    await chrome.storage.session.set({ [key]: next });
  };
  const next = (navigationQueues.get(tabId) || startupReady).then(work);
  navigationQueues.set(tabId, next.catch(() => {}));
  return next;
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await startupReady;
  await navigationQueues.get(tabId);
  navigationQueues.delete(tabId);
  await chrome.storage.session.remove([`page:${tabId}`, `doc:${tabId}`, `caption:${tabId}`]);
  queue.drop(tabId);
  await clearPublishers(tabId);
  privateTabs.forget(tabId).catch(() => {});
  tabStore.clear(tabId).catch(() => {});
});

// URL changes are serialized with content-script navigation reports.
//
// Only a changed address counts here. A status of 'loading' with no address is not
// a reload: measured in Chrome 153, history.replaceState to the same address and an
// iframe navigating after the page has loaded both report exactly that, and treating
// them as reloads wiped every claim on the page while its highlights stayed behind.
// A real reload is recognised by its new document instead; see documentChanged.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url) navigateTab(tabId, info.url).catch(() => {});
});

// Each content script instance names its document with a random id. A different id
// from the same tab means a new document on it: a reload of the same address, or a
// page restored from the back-forward cache, neither of which changes the URL the
// worker last saw. The first id a tab reports is simply recorded.
async function documentChanged(tabId, docId, url) {
  if (typeof docId !== 'string' || !/^[a-z0-9-]{8,64}$/i.test(docId)) return;
  const key = `doc:${tabId}`;
  const previous = (await chrome.storage.session.get(key))[key];
  if (previous === docId) return;
  await chrome.storage.session.set({ [key]: docId });
  if (previous) await navigateTab(tabId, url, true);
}

// Read the page again from nothing.
//
// Both sides remember what they have already judged: the content script so it does
// not ship a sentence twice, and the worker so it does not score it twice. That is
// right while reading and wrong whenever the answer would now be different, so both
// memories are emptied together. Anything less produces the failure this fixed:
// pressing the thumbs-up on a site that had been refused appeared to do nothing,
// because every sentence on the page was already marked as seen.
async function rescanTab(tabId) {
  if (tabId == null) return false;
  await resetTab(tabId);
  chrome.tabs.sendMessage(tabId, { type: MSG.RESCAN }).catch(() => {});
  return true;
}

async function resetTab(tabId) {
  queue.drop(tabId);
  await clearPublishers(tabId);
  await chrome.storage.session.remove(`caption:${tabId}`);
  await privateTabs.forget(tabId); // a new page is judged on its own merits
  await tabStore.clear(tabId);
  updateBadge(tabId);
  pushPanel(tabId);
}

chrome.tabs.onActivated.addListener(({ tabId }) => {
  updateBadge(tabId);
  pushPanel(tabId);
  scanPolicy(tabId).then((policy) => pushPageStatus(tabId, policy));
});

// --- privacy ------------------------------------------------------------------
// Whether a tab may be scanned at all: the user's lists, then the built-in rules.
// Consulted when a content script asks, and again when sentences arrive, so a
// content script that misjudged still cannot get a private page classified.

const NO_TAB = { blocked: true, reason: 'unsupported', domain: '', rule: null };

// The one place that decides whether anything may happen for a tab. Everything
// that could read, score, store or send a page's text asks this first.
async function scanPolicy(tabId) {
  if (tabId == null) return NO_TAB;
  // Every read in here is inside the guard: storage or the tabs API failing must
  // mean "do not scan", never "no rule found, go ahead".
  try {
    if (await privateTabs.has(tabId)) {
      // Reported by the page itself, and kept until the tab navigates. A form is
      // invisible to a URL rule, so the report has to outlive the moment it arrived,
      // and outlive the worker being put to sleep; see tabstate.js.
      return { blocked: true, reason: 'fields', domain: await tabOrigin(tabId), rule: null };
    }
    const tab = await chrome.tabs.get(tabId);
    return evaluateUrl(tab?.url || '', await getSettings());
  } catch {
    return NO_TAB;
  }
}

// Whether a page may be kept in the works cited list, which is a harder question
// than whether it may be scanned, and deliberately so.
//
// Scanning is transient and local: it happens in memory, it is thrown away when the
// tab navigates, and a reader who presses the thumbs-up on a site has said something
// reasonable about that site. The list is a record on disk that outlives the browser
// session, so it does not take that answer. A page the built-in rules flag is refused
// here even when the reader has allowed that site for scanning, and even when they
// have switched the built-in rules off altogether, because that switch governs
// scanning and was not a decision about what to write down.
//
// The point of all this is one sentence: a bank statement cannot end up in a file
// that is still there tomorrow.
async function citationPolicy(tabId) {
  if (tabId == null) return { blocked: true, reason: 'unsupported' };
  try {
    if (await privateTabs.has(tabId)) return { blocked: true, reason: 'fields' };

    const tab = await chrome.tabs.get(tabId);
    if (tab?.incognito) return { blocked: true, reason: 'incognito' };

    const settings = await getSettings();
    // The address is returned alongside the verdict, so the caller can store the one
    // that was actually judged rather than whatever the page says a moment later.
    return {
      ...evaluateUrl(tab?.url || '', {
        ...settings,
        allowedDomains: [],     // no per-site override for a durable record
        privateSitesRule: true, // and the built-in rules always apply to one
      }),
      url: tab?.url || '',
    };
  } catch {
    return { blocked: true, reason: 'unsupported' };
  }
}

// How the page describes itself, read from the live document rather than from
// fetched HTML, because the content script can see what the page actually rendered.
// Falls back to what the tab itself reports when no content script answers, which is
// the case on pages the extension does not inject into.
async function pageCitationRecord(tabId, approvedUrl) {
  if (!approvedUrl) return null;

  let described = null;
  try {
    described = await chrome.tabs.sendMessage(tabId, { type: MSG.PAGE_META });
  } catch { /* no content script here */ }

  // The address the policy judged is the address that gets stored, and if the page
  // has moved since then nothing is stored at all.
  //
  // The check reads the tab's address; the reply comes back a moment later carrying
  // the page's own. On a single-page app those are not always the same address: one
  // history.pushState in between and the approval belonged to the page before. Small
  // window, same shape as every other bug in this extension that let one page's
  // permission cover another.
  if (described?.url && sourceKey(described.url) !== sourceKey(approvedUrl)) return null;

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const url = approvedUrl;

  const meta = described?.head ? metadataFromHtml(described.head) : { authors: [], title: '', siteName: '', date: '' };
  return makeSource({
    url,
    title: meta.title || described?.title || tab?.title || '',
    siteName: meta.siteName || originDomain(url),
    authors: meta.authors,
    date: meta.date,
  });
}

async function pushPageStatus(tabId, policy) {
  chrome.runtime.sendMessage({ type: MSG.PAGE_STATUS, tabId, ...policy }).catch(() => {});
}

async function activeTabId(windowId) {
  const [tab] = await chrome.tabs.query({ active: true, ...(Number.isInteger(windowId) ? { windowId } : { currentWindow: true }) });
  return tab?.id ?? null;
}

// The badge counts the flags, not the faint marks: it is the loud signal, and a
// sentence the classifier was unsure about should not add to it.
async function updateBadge(tabId) {
  const state = await tabStore.peek(tabId);
  const count = [...(state?.claims.values() || [])].filter((c) => c.band !== 'faint').length;
  chrome.action.setBadgeText({ tabId, text: count ? String(count) : '' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#b4462d' }).catch(() => {});
}

// Only the active tab may drive the panel, otherwise a background tab navigating
// blanks whatever the user is currently reading.
// The claims as the panel should see them. Both the push and the panel's own first
// read go through here, or the flag would be missing from exactly the moment the
// panel opens, which is when a reader is most likely to press something.
//
// cached is a view of the cache at this instant, not a property of the claim, so it
// is added to the copy that goes out and never to what is stored.
async function panelClaims(tabId, state) {
  const stored = [...(state?.claims.values() || [])];
  if (!stored.length) return stored;
  let cached = new Set();
  try {
    cached = await cachedClaims(tabId, stored, await settingsForTab(tabId));
  } catch { /* the panel is still worth sending without it */ }
  return stored.map((c) => (cached.has(c.id) ? { ...c, cached: true } : c));
}

async function pushPanel(tabId) {
  // Panels only draw the active tab of their own window, so a background tab's
  // update would be built, including its cache lookup, and then thrown away.
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab?.active === false) return;
  const state = await tabStore.peek(tabId);
  chrome.runtime
    .sendMessage({ type: MSG.PANEL_UPDATE, tabId, claims: await panelClaims(tabId, state) })
    .catch(() => {}); // no panel open — fine
}

function pushHighlights(tabId, claims) {
  chrome.tabs
    .sendMessage(tabId, {
      type: MSG.CLAIM_STATUS,
      claims: claims.map((c) => ({ id: c.id, text: c.text, status: c.status, band: c.band, ts: c.ts })),
    })
    .catch(() => {});
}

// A provider that needs no key, such as Wikipedia, is ready the moment the
// extension is installed. Keyed providers need their key before a check can run.
function searchReady(settings) {
  return !getSearchProvider(settings.searchProvider).requiresKey || Boolean(settings.searchApiKey);
}

// --- pipeline ---------------------------------------------------------------

async function handleSentences(tabId, sentences) {
  const settings = await getSettings();
  if (!settings.autoCheck) return;
  if ((await scanPolicy(tabId)).blocked) return; // second line of defence

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
  // Two bars. At or above the threshold a sentence is flagged. Within a band just
  // below it, when the reader has the option on, it is marked faintly: the same
  // claim with the same buttons, drawn so that it does not shout. A score is a
  // probability, and a probability of 0.6 deserves something other than silence.
  const faint = settings.faintFlags ? faintThreshold(settings.threshold) : settings.threshold;
  const flagged = [];
  fresh.forEach((s, i) => {
    if (scores[i] < faint) return;
    const claim = {
      id: s.id,
      text: s.text,
      ts: s.ts,
      score: Number(scores[i].toFixed(2)),
      band: scores[i] >= settings.threshold ? 'flag' : 'faint',
      status: searchReady(settings) ? STATUS.UNCHECKED : STATUS.NO_KEY,
    };
    state.claims.set(claim.id, claim);
    flagged.push(claim);
  });

  // What about each sentence made it look checkable. A bare score tells a reader
  // that a sentence is worth checking without telling them what about it is
  // checkable, which is the difference between a description and an oracle. Only
  // for the ones that were flagged, and only local arithmetic on signals already
  // computed while scoring.
  for (const claim of flagged) {
    try {
      const signals = await explainClaim(claim.text);
      if (signals.length) claim.signals = signals;
    } catch { /* an unexplained claim is still a claim */ }
  }
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
async function requestCheck(claimId, withAi, windowId, panelId) {
  const tabId = await activeTabId(windowId);
  if ((await scanPolicy(tabId)).blocked) return;
  if (tabId == null) return;
  const state = await tabStore.peek(tabId);
  const claim = state?.claims.get(claimId);
  if (!claim || claim.status === STATUS.PENDING || claim.summarizing) return;

  // Nothing from an incognito tab is written to disk. The cache lives in
  // chrome.storage.local, which outlives the incognito window and the browser
  // itself, and the whole point of that window is that nothing does. An extension
  // runs in one shared worker across normal and incognito tabs unless it says
  // otherwise, so without this a check run in incognito left a day-long record of
  // the claim's answer, its AI summary and excerpts of the pages read for it.
  const settings = { ...await settingsForTab(tabId), panelId };

  if (withAi && claim.results?.length) {
    summarize(tabId, claim, settings);
    return;
  }

  if (!searchReady(settings)) {
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

// Claims left waiting on a summary that nobody is left to produce. Returns whether
// anything changed, so the caller only writes when there is something to write.
async function clearStrandedSummaries(tabId, state, panelId) {
  let changed = false;
  for (const claim of state.claims.values()) {
    if (claim.summarizing && (!claim.summaryRequestId || claim.summaryOwner !== panelId)) {
      claim.summarizing = false;
      changed = true;
    }
  }
  if (changed) await tabStore.save(tabId);
  return changed;
}

async function summarize(tabId, claim, settings) {
  const llm = getLlmProvider(settings.llmProvider);
  if (llm.id === 'none' || !claim.results?.length) return;

  claim.summarizing = true;
  claim.error = undefined;
  await tabStore.save(tabId);
  pushPanel(tabId);

  if (llm.runsInPage) {
    const requestId = crypto.randomUUID();
    claim.summaryRequestId = requestId;
    claim.summaryOwner = settings.panelId;
    await tabStore.save(tabId);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    // The browser's built-in model only exists in a document context, so the side
    // panel runs it and returns the summary via LLM_RESULT. No panel open means no
    // summary, which is fine since summaries are only ever read there.
    chrome.runtime
      .sendMessage({
        type: MSG.LLM_REQUEST,
        tabId,
        windowId: tab?.windowId,
        requestId,
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
    // Keyed on the sources as well as the claim, so a summary is only reused when
    // the model was given the same evidence to read.
    const model = llm.id === 'local' ? settings.localLlmModel : settings.llmModel || undefined;
    claim.analysis = await remember(
      settings,
      'llm',
      [llm.id, model || '', claim.text, (claim.results || []).map((r) => r.url)],
      () => llm.crossReference(claim.text, claim.results, settings.llmApiKey, {
        url: settings.localLlmUrl,
        model,
      }),
    );
  } catch (err) {
    claim.analysis = null;
    claim.error = `Summary unavailable: ${err.message}`;
  }
  computeEvidence(claim, settings);
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

// Everything that would be the article quoting itself: the domain in the address
// bar, plus whoever actually wrote it. A portal's copy of a wire story and the
// wire's own copy are one source, not two, and the content script reports the
// second from the page's canonical link, Open Graph URL and credit line.
async function clearPublishers(tabId) {
  await chrome.storage.session.remove(`publishers:${tabId}`);
}

// The addresses under every other claim on the tab: what the reader can already
// see, which is what a new check should try not to repeat.
function shownUrls(state, exceptClaimId) {
  const urls = new Set();
  for (const other of state?.claims.values() || []) {
    if (other.id === exceptClaimId) continue;
    for (const r of other.results || []) if (r?.url) urls.add(r.url);
  }
  return [...urls];
}

async function excludedDomains(tabId) {
  const origin = await tabOrigin(tabId);
  const extra = (await chrome.storage.session.get(`publishers:${tabId}`))[`publishers:${tabId}`] || [];
  return [...new Set([origin, ...extra].filter(Boolean))];
}

// A search snippet is 150 characters, usually cut mid-sentence, and often missing
// the number or the date the claim turns on. Reading the page itself gives the
// evidence score and the model the paragraphs that actually bear on the claim.
//
// Only the top results, only on a check the user asked for, and never at the cost
// of the results themselves: a page that will not load leaves its snippet in place.
const READ_TOP_N = 2;

// What a page says about itself: its author, its real title, the publisher's name.
// Read from the same HTML readSources already fetches, but cached by address alone
// rather than by address and claim, because who wrote a page does not depend on
// which claim sent us to it. Two claims citing the same source pay for one fetch.
//
// Nothing here happens on its own. It runs when a check is already fetching the
// page, or when the reader presses a Cite button, and the empty answer is a valid
// one: shared/citation.js cites an unauthored page correctly in all four styles.
async function pageMetadata(url, settings) {
  if (!publicSourceUrl(url)) return null;
  try {
    return await remember(settings, 'meta', [url], async () => {
      const html = await fetchPageHtml(url);
      return html ? metadataFromHtml(html) : { authors: [], title: '', siteName: '', date: '' };
    });
  } catch {
    return null; // an unreadable page cites from what the search result gave us
  }
}

// Metadata for a set of addresses, as a plain object the citation module can read.
// Fetched in parallel, and a failure anywhere costs that one source its author and
// nothing else.
async function metadataFor(urls, settings, results = []) {
  const found = Object.fromEntries(results.filter((r) => r.metadata && publicSourceUrl(r.url)).map((r) => [r.url, r.metadata]));
  const wanted = [...new Set(urls.filter((url) => publicSourceUrl(url) && !found[url]))];
  await Promise.all(wanted.map(async (url) => {
    const meta = await pageMetadata(url, settings);
    if (meta) found[url] = meta;
  }));
  return found;
}

async function readSources(claim, results, settings) {
  if (!settings.readSources) return;
  await Promise.all(results.slice(0, READ_TOP_N).map(async (r) => {
    if (!publicSourceUrl(r?.url)) return;
    try {
      // The excerpt and the date are cached, not the page: they are small, and
      // they are what gets used. The date the publisher put on the page beats a
      // search provider's guess at it, so it wins where both exist.
      const read = await remember(settings, 'read', [r.url, claim.text], async () => {
        const epoch = cache.epoch();
        const html = await fetchPageHtml(r.url);
        if (!html) return { excerpt: '', date: '' };
        const meta = metadataFromHtml(html);
        if (settings.cacheResults) await cache.set(cacheKey('meta', [r.url]), meta, epoch);
        return {
          meta,
          excerpt: relevantExcerpt(claim.text, extractParagraphs(html)),
          date: publishedDateFromHtml(html),
        };
      });
      if (read?.meta) r.metadata = read.meta;
      if (read?.excerpt) r.excerpt = read.excerpt;
      if (read?.date) r.date = read.date;
    } catch {
      // Unreadable page: the snippet stands.
    }
  }));
}

// The key a claim's search answer is stored under. Written once and used both by
// the check that stores the answer and by the panel that asks whether one is already
// there. Two copies of this would drift, and a drifted copy tells the reader a check
// is free when it is not.
function searchCacheParts(claim, settings, search, excludeDomain) {
  const query = settings.distillQueries ? searchQuery(claim.text) : claim.text;
  return [search.id, query, excludeDomain.join(','), Boolean(settings.academicMode)];
}

// Which unchecked claims already have an answer stored, so the panel can say the
// button costs nothing before the reader presses it. One storage read for all of
// them, and only when there is something to ask about.
async function cachedClaims(tabId, claims, settings) {
  if (!settings.cacheResults) return new Set();
  const waiting = claims.filter((c) => c.status === STATUS.UNCHECKED);
  if (!waiting.length) return new Set();

  const search = getSearchProvider(settings.searchProvider);
  const excludeDomain = await excludedDomains(tabId);
  const byKey = new Map(
    waiting.map((c) => [cacheKey('search', searchCacheParts(c, settings, search, excludeDomain)), c.id]),
  );
  const live = await cache.hasMany([...byKey.keys()]);
  return new Set([...live].map((k) => byKey.get(k)));
}

async function checkClaim(tabId, claimId, settings, withAi = false) {
  const state = await tabStore.peek(tabId);
  const claim = state?.claims.get(claimId);
  if (!claim) return; // tab was reset or closed while queued

  try {
    const search = getSearchProvider(settings.searchProvider);
    const factCheck = getFactCheckProvider(settings.factCheckProvider);
    const excludeDomain = await excludedDomains(tabId);
    // Verbatim by default. Distillation is an opt-in until it has been measured.

    // Published fact-checks and, in academic mode, peer-reviewed work come back with
    // the search results, from the same button. A failure in either must not lose
    // the search results, so each is caught apart.
    const academic = Boolean(settings.academicMode);
    const query = settings.distillQueries ? searchQuery(claim.text) : claim.text;
    // What is already on the panel for this page. Two claims about one subject
    // otherwise come back with the same sources, and the provider can prefer ones
    // the reader has not seen when it is told which those are.
    const avoidUrls = shownUrls(state, claimId);
    const [results, factChecks, scholar] = await Promise.all([
      remember(settings, 'search', searchCacheParts(claim, settings, search, excludeDomain), () =>
        search.search(query, settings.searchApiKey, { excludeDomain, academic, avoidUrls })),
      settings.factCheckApiKey
        ? remember(settings, 'factcheck', [factCheck.id, claim.text], () =>
            factCheck.lookup(claim.text, settings.factCheckApiKey)).catch((err) => {
            claim.factCheckError = err.message;
            return [];
          })
        : Promise.resolve([]),
      academic
        ? remember(settings, 'scholar', ['openalex', claim.text], () =>
            getScholarProvider('openalex').lookup(claim.text)).catch((err) => {
            claim.scholarError = err.message;
            return [];
          })
        : Promise.resolve([]),
    ]);

    await readSources(claim, results, settings);

    // Off by default. On, every result's author and real title are read while the
    // check is already running, so a later Cite press copies instantly instead of
    // waiting on a fetch. It is a page fetch either way and costs no API quota; the
    // difference is only whether it happens now for all of them or later for the
    // one that gets cited.
    if (settings.autoCitationData) {
      await metadataFor(results.filter((r) => !r.metadata).map((r) => r?.url), settings);
    }

    if ((await tabStore.peek(tabId)) !== state) return;
    claim.results = results;
    claim.factChecks = factChecks;
    claim.scholar = scholar;
    claim.status = STATUS.CHECKED;
    computeEvidence(claim, settings);
    await tabStore.save(tabId);

    if (withAi) await summarize(tabId, claim, settings);
  } catch (err) {
    claim.status = err instanceof ProviderError && err.kind === 'noKey' ? STATUS.NO_KEY : STATUS.ERROR;
    claim.error = err.message;
  }

  await tabStore.save(tabId);
  pushPanel(tabId);
  if ((await tabStore.peek(tabId)) === state) pushHighlights(tabId, [claim]);
}

// --- context menu -----------------------------------------------------------
// The classifier will always miss some claims. Highlighting a sentence and
// right-clicking it puts that sentence through the same path as a flagged one,
// bypassing the threshold and marked as the user's own, so an unflagged claim
// still has a way in. The guards keep the worker loadable where these APIs are
// absent, as in the tests.

const MENU_ID = 'fc-check-selection';

chrome.runtime.onInstalled?.addListener((details) => {
  // First install only. A reader who has just added this sees sentences light up on
  // the next page they open with no idea what the colour means, that a side panel
  // exists, or that nothing has been searched. The guide answers all three and is
  // already the first tab of the options page; it just needed opening once. Not on
  // an update, which would reopen it every time the extension is upgraded.
  if (details?.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html#guide') }).catch(() => {});
  }

  chrome.contextMenus?.create(
    // contexts: ['selection'] means the item only exists once text is highlighted,
    // which is why every instruction says to highlight the sentence first.
    { id: MENU_ID, title: 'Fact-check the highlighted text', contexts: ['selection'] },
    () => void chrome.runtime.lastError, // already exists after a reload; harmless
  );
});

chrome.contextMenus?.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || tab?.id == null) return;
  // Open during the actual gesture, before storage or policy awaits.
  chrome.sidePanel.open?.({ tabId: tab.id }).catch(() => {});
  startupReady.then(() => addUserClaim(tab.id, info.selectionText || '')).catch(() => {});
});

async function addUserClaim(tabId, selection) {
  const text = selection.replace(/\s+/g, ' ').trim();
  if (text.length < 10) return;

  // A right-click is an explicit request, and it still does not override the
  // never-scan rules. Sending a sentence from a bank statement or a medical portal
  // to a search API is exactly what those rules exist to prevent, and the thumbs-up
  // in the panel is the deliberate way to change your mind about a site.
  const policy = await scanPolicy(tabId);
  if (policy.blocked) {
    pushPageStatus(tabId, policy); // the banner says which rule, and how to override
    return;
  }

  const state = await tabStore.get(tabId);
  const key = text.toLowerCase();

  // Already a claim, flagged or added: bring it into view rather than duplicate it.
  const existing = [...state.claims.values()].find((c) => c.text.trim().toLowerCase() === key);
  const claimId = existing ? existing.id : `u${Date.now().toString(36)}`;

  if (!existing) {
    const settings = await getSettings();
    state.seen.add(key);
    state.claims.set(claimId, {
      id: claimId,
      text,
      score: null, // never scored; the user decided this one
      userAdded: true,
      status: searchReady(settings) ? STATUS.UNCHECKED : STATUS.NO_KEY,
    });
    await tabStore.save(tabId);
    updateBadge(tabId);
    pushHighlights(tabId, [state.claims.get(claimId)]);
  }

  await pushPanel(tabId);
  chrome.runtime.sendMessage({ type: MSG.PANEL_FOCUS, tabId, claimId }).catch(() => {});
}

async function sendToActiveTab(message, windowId) {
  const tabId = await activeTabId(windowId);
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

// Answering a message asynchronously, without the failure mode that comes with it.
// Returning true from a listener promises a reply; if the work then rejects, no reply
// is ever sent, the sender's promise hangs until Chrome tears the channel down, and
// the user sees a button that does nothing rather than an error. Every asynchronous
// case below goes through here, so a rejection becomes a definite, safe answer.
function reply(sendResponse, work, onFailure) {
  Promise.resolve()
    .then(work)
    .then(sendResponse)
    .catch((err) => {
      console.warn('[factcheck] message handler failed:', err?.message || err);
      sendResponse(onFailure);
    });
  return true;
}

// Sources the reader has just cited, added to the works cited list.
//
// Refused only for the two reasons that apply to a third party's page: an address
// that is not an ordinary web address, and a reader who is browsing privately.
async function keepCitedSources(tabId, sources) {
  if (!sources.length) return;
  try {
    const tab = tabId == null ? null : await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || tab.incognito) return;

    for (const source of sources) {
      if (!httpUrl(source.url)) continue;
      if (!publicSourceUrl(source.url)) continue;
      const record = makeSource(source);
      if (record) await sourceStore.add(record);
    }
  } catch { /* a citation the reader already has is worth more than the bookkeeping */ }
}

const CONTENT_MESSAGES = new Set([
  MSG.GET_STATE, MSG.PAGE_PRIVATE, MSG.PAGE_LANGUAGE, MSG.PAGE_SOURCES,
  MSG.PAGE_CHANGED, MSG.UNLOCATED, MSG.SENTENCES, MSG.HIGHLIGHT_CLICKED,
  MSG.CAPTION_HINT, MSG.NAV_STATE,
]);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;
  const fromDocument = typeof sender.url === 'string' &&
    (sender.url === chrome.runtime.getURL('src/options/options.html') ||
     sender.url.split('#')[0] === chrome.runtime.getURL('src/options/options.html') ||
     sender.url === chrome.runtime.getURL('src/sidepanel/panel.html'));
  if (sender.id && sender.id !== chrome.runtime.id) return false;
  if (sender.tab?.id != null && !fromDocument && !CONTENT_MESSAGES.has(msg.type)) return false;
  if (sender.tab?.id == null && !fromDocument && sender.url) return false;
  startupReady.then(async () => {
    if (msg.type !== MSG.PAGE_CHANGED && sender.tab?.id != null) await navigationQueues.get(sender.tab.id);
    const keep = handleMessage(msg, sender, sendResponse);
    if (!keep) sendResponse();
  }).catch(() => sendResponse({ ok: false }));
  return true;
});

function handleMessage(msg, sender, sendResponse) {
  const tabId = sender.tab?.id;

  switch (msg.type) {
    case MSG.SAVE_SETTINGS:
      return reply(sendResponse, async () => ({ settings: await saveSettings(msg.patch) }), { settings: null });
    case MSG.GET_STATE:
      // The fallback refuses: a page that cannot be judged is a page that is not read.
      return reply(sendResponse, async () => {
        // A new document is reset before it is judged, so a password-field marker
        // or claims from the previous document cannot carry into this answer.
        if (tabId != null) await documentChanged(tabId, msg.docId, sender.tab?.url || '');
        const [settings, policy] = await Promise.all([getSettings(), scanPolicy(tabId)]);
        if (tabId != null) {
          const key = `page:${tabId}`;
          const stored = await chrome.storage.session.get(key);
          if (!stored[key]) {
            const tab = await chrome.tabs.get(tabId);
            await chrome.storage.session.set({ [key]: pageIdentity(tab?.url) });
          }
          pushPageStatus(tabId, policy);
        }
        return {
          autoCheck: settings.autoCheck,
          scanAllowed: !policy.blocked,
          reason: policy.reason,
          appearance: appearanceOf(settings),
        };
      }, { autoCheck: false, scanAllowed: false, reason: 'unsupported' });

    case MSG.PAGE_PRIVATE:
      // The page itself has a password or card field; say so, whatever the domain,
      // and remember it, because the URL rules cannot see a form. Anything already
      // collected from this page goes: a login screen that appeared after the
      // article must not leave claims from that page sitting in the panel.
      if (tabId != null) {
        privateTabs.mark(tabId).catch(() => {});
        queue.drop(tabId);
        tabStore.clear(tabId)
          .then(() => {
            updateBadge(tabId);
            pushPanel(tabId);
            return scanPolicy(tabId);
          })
          .then((policy) => pushPageStatus(tabId, { ...policy, blocked: true, reason: msg.reason || 'fields' }))
          .catch(() => {});
      }
      return false;

    case MSG.PAGE_LANGUAGE:
      // Not a privacy rule: the classifier simply cannot read this page. The panel
      // says which language it looks like, and the thumbs-up still overrides it.
      if (tabId != null) {
        scanPolicy(tabId).then((policy) =>
          pushPageStatus(tabId, {
            ...policy,
            blocked: true,
            reason: 'language',
            language: msg.language || null,
          }),
        );
      }
      return false;

    case MSG.RESCAN:
      // Settings only take effect on sentences the extension has not already
      // judged. Both sides remember what they have seen: the content script so it
      // does not ship the same sentence twice, and the worker so it does not score
      // it twice. A changed threshold therefore does nothing to a page already on
      // screen until both of those are emptied, which is what this does.
      return reply(sendResponse, async () => ({ ok: await rescanTab(await activeTabId(msg.windowId)) }), { ok: false });

    case MSG.OPEN_TRANSCRIPT:
      // The panel asks; the video script does it, because only a content script can
      // touch YouTube's own controls.
      activeTabId(msg.windowId).then((id) => {
        if (id == null) return;
        chrome.tabs.sendMessage(id, { type: MSG.OPEN_TRANSCRIPT }).catch(() => {});
      });
      return false;

    case MSG.PAGE_SOURCES:
      // These come from the page's own canonical link and Open Graph URL, so the
      // page chooses them. They end up inside a search query as -site: terms, which
      // is a request the user pays for, so they are held to the shape of a hostname
      // and to a length one could actually be, rather than merely to being truthy.
      if (tabId != null) {
        const domains = (Array.isArray(msg.domains) ? msg.domains : [])
          .map(normalizeDomain)
          .filter(Boolean)
          .slice(0, 5);
        return reply(sendResponse, async () => {
          await chrome.storage.session.set({ [`publishers:${tabId}`]: domains });
          return { ok: true };
        }, { ok: false });
      }
      return false;

    case MSG.SITE_RULE:
      return reply(sendResponse, async () => {
        const settings = await getSettings();
        await saveSettings((current) => applySiteRule(current, msg.domain, msg.action));
        const id = await activeTabId(msg.windowId);
        if (id == null) return { ok: false };
        const policy = await scanPolicy(id);
        chrome.tabs
          .sendMessage(id, {
            type: MSG.SCAN_CONFIG,
            autoCheck: settings.autoCheck,
            scanAllowed: !policy.blocked,
            appearance: appearanceOf(settings),
          })
          .catch(() => {});
        if (policy.blocked) {
          // A site just turned off must not keep showing what was found on it.
          queue.drop(id);
          await tabStore.clear(id);
          updateBadge(id);
        } else {
          // A site just turned on has to be read from scratch. Telling the page to
          // collect is not enough on its own: everything on it may already be
          // marked as seen from before the rule changed, in which case nothing new
          // would ever be shipped and the thumbs-up would look broken.
          await rescanTab(id);
        }
        await pushPanel(id);
        pushPageStatus(id, policy);
        return { ok: true };
      }, { ok: false });

    case MSG.PAGE_CHANGED:
      if (tabId != null) return reply(sendResponse, async () => {
        await navigateTab(tabId, msg.url || sender.tab.url);
        return { ok: true };
      }, { ok: false });
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
      if (tabId != null) handleSentences(tabId, (Array.isArray(msg.sentences) ? msg.sentences : []).filter((s) => s && typeof s.id === 'string' && /^[a-z0-9_-]{1,100}$/i.test(s.id) && typeof s.text === 'string' && s.text.length <= 20000).slice(0, 1000)).catch(() => {});
      return false;

    case MSG.HIGHLIGHT_CLICKED:
      chrome.runtime.sendMessage({ type: MSG.PANEL_FOCUS, tabId, claimId: msg.claimId }).catch(() => {});
      return false;

    case MSG.PANEL_READY:
      return reply(sendResponse, async () => {
        const id = await activeTabId(msg.windowId);
        const state = id == null ? null : await tabStore.peek(id);
        // A panel that has only just opened cannot be running a summary from before
        // it opened. The built-in model runs in the panel's document, so closing the
        // panel mid-summary destroys the only thing that could ever answer, and the
        // claim would sit marked summarizing with its buttons refusing to act. The
        // panel now answers on every path it can; this covers the one it cannot.
        if (state && await clearStrandedSummaries(id, state, msg.panelId)) pushHighlights(id, []);
        const captionKey = `caption:${id}`;
        return {
          tabId: id,
          claims: await panelClaims(id, state),
          page: id == null ? null : await scanPolicy(id),
          caption: id == null ? null : (await chrome.storage.session.get(captionKey))[captionKey] || null,
        };
      }, { tabId: null, claims: [], page: null });

    case MSG.SET_AUTOCHECK:
      return reply(sendResponse, async () => {
        await saveSettings({ autoCheck: msg.autoCheck });
        const id = await activeTabId(msg.windowId);
        const policy = await scanPolicy(id);
        sendToActiveTab({
          type: MSG.SCAN_CONFIG,
          autoCheck: msg.autoCheck,
          scanAllowed: !policy.blocked,
          appearance: appearanceOf(await getSettings()),
        }, msg.windowId);
        return { ok: true };
      }, { ok: false });

    case MSG.LLM_RESULT:
      Promise.resolve(msg.tabId).then(async (id) => {
        const state = id == null ? null : await tabStore.peek(id);
        const claim = state?.claims.get(msg.claimId);
        if (!claim || !claim.summarizing || claim.summaryRequestId !== msg.requestId) return;
        claim.summarizing = false;
        delete claim.summaryRequestId;
        delete claim.summaryOwner;
        if (msg.analysis) {
          claim.analysis = msg.analysis;
          computeEvidence(claim, await getSettings());
        }
        if (msg.error) claim.error = `Summary unavailable: ${msg.error}`;
        await tabStore.save(id);
        pushPanel(id);
      });
      return false;

    case MSG.CLEAR_CACHE:
      cache.clear().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
      return true;

    case MSG.BROWSER_SEARCH:
      // The browser's own default engine, whichever the user set: native, keyless,
      // and the same as the user typing the claim into the address bar. The results
      // open in a tab rather than the panel, because no browser hands them to
      // extensions as data.
      activeTabId(msg.windowId).then(async (id) => {
        const state = id == null ? null : await tabStore.peek(id);
        const claim = state?.claims.get(msg.claimId);
        if (!claim) return;
        // Not the sentence: a query, shaped for the engine that will read it.
        // Engines differ enough that one shape does not suit them all, and the
        // differences are recorded with their evidence in shared/engines.js.
        const settings = await getSettings();
        const engine = settings.browserSearchEngine || 'default';
        const text = browserQuery(claim.text, engineStyle(engine)) || claim.text;

        // A named engine is opened by address. The browser's own default cannot be
        // read by an extension, so that one goes through chrome.search instead,
        // which is the only way to honour a setting this code cannot see.
        const url = searchUrl(engine, text);
        if (url) chrome.tabs.create({ url }).catch(() => {});
        else Promise.resolve(chrome.search?.query({ text, disposition: 'NEW_TAB' })).catch(() => {});
      });
      return false;

    case MSG.CITE_SOURCES:
      // The panel asks for the records; it does the formatting, because it is the
      // panel that knows which style the reader picked. url names one source, and
      // its absence means all of the claim's.
      //
      // This is where a page is fetched for a citation, and it happens because a
      // button was pressed. Cached by address, so the second claim citing the same
      // source pays nothing, and an unreadable page still cites from what the
      // search result gave us.
      return reply(sendResponse, async () => {
        const id = await activeTabId(msg.windowId);
        const state = id == null ? null : await tabStore.peek(id);
        const claim = state?.claims.get(msg.claimId);
        if (!claim) return { sources: [] };

        const settings = await settingsForTab(id);
        const wanted = msg.url
          ? (claim.results || []).filter((r) => r?.url === msg.url).map((r) => r.url)
          : (claim.results || []).map((r) => r?.url);
        const meta = await metadataFor(wanted, settings, claim.results);

        const accessed = new Date().toISOString().slice(0, 10);
        const all = sourcesForClaim(claim, meta, accessed);
        const cited = msg.url ? all.filter((x) => x.url === msg.url) : all;

        // Citing something is the moment it belongs in the works cited list, and for
        // a while it was not put there: one path stored the page the reader was on
        // and the other only copied text, so a source found by a check never reached
        // the list at all.
        //
        // The test applied here is lighter than the one guarding "add this page", and
        // deliberately. That rule exists because the page a reader is looking at may
        // hold their own private data. These are results a search provider returned
        // for a claim, fetched because a button was pressed; the reader never visited
        // them, so they cannot carry anything of the reader's. What still applies is
        // that the address is an ordinary web address, and that nothing at all is
        // written to disk from an incognito window.
        await keepCitedSources(id, cited);
        return { sources: cited };
      }, { sources: [] });

    case MSG.ADD_SOURCE:
      // Keeping the current page. Manual, always: nothing reads browsing history and
      // no permission to do so is requested. The policy consulted here is the strict
      // one, because this writes to disk and stays there.
      return reply(sendResponse, async () => {
        const id = await activeTabId(msg.windowId);
        if (id == null) return { ok: false, reason: 'unsupported' };

        const policy = await citationPolicy(id);
        if (policy.blocked) return { ok: false, blocked: true, reason: policy.reason, domain: policy.domain || '' };

        const record = await pageCitationRecord(id, policy.url);
        if (!record) return { ok: false, reason: 'moved' };

        const result = await sourceStore.add(record);
        return { ok: result.added, replaced: result.replaced, title: record.title, url: record.url };
      }, { ok: false, reason: 'unsupported' });

    case MSG.LIST_SOURCES:
      return reply(sendResponse, async () => ({ sources: await sourceStore.list() }), { sources: [] });

    case MSG.REMOVE_SOURCE:
      return reply(sendResponse, async () => ({ sources: await sourceStore.remove(msg.key) }), { sources: null });

    case MSG.CLEAR_SOURCES:
      return reply(sendResponse, async () => ({ sources: await sourceStore.clear() }), { sources: null });

    case MSG.CITE_MATERIAL:
      // Everything a model may read to fill a citation's gaps, gathered here because
      // fetching and searching are the worker's job. The panel runs the model, since
      // the browser's built-in one needs a document and this way every provider takes
      // the same path.
      //
      // Only on a press, and only for a citation that is actually incomplete. The web
      // search spends a search call, so it runs only when the reader has a provider
      // that can answer and when the page itself did not say enough.
      return reply(sendResponse, async () => {
        const nothing = { source: null, missing: [], pageText: '', searchResults: [] };
        const id = await activeTabId(msg.windowId);
        const state = id == null ? null : await tabStore.peek(id);
        const claim = state?.claims.get(msg.claimId);
        if (!claim) return nothing;

        if (!(claim.results || []).some((r) => r?.url === msg.url) || !publicSourceUrl(msg.url)) return nothing;
        const settings = await settingsForTab(id);
        const meta = await metadataFor([msg.url], settings, claim.results);
        const accessed = new Date().toISOString().slice(0, 10);
        const source = sourcesForClaim(claim, meta, accessed).find((x) => x.url === msg.url) || null;
        if (!source) return nothing;

        const missing = missingFields(source);
        if (!missing.length) return { source, missing, pageText: '', searchResults: [] };

        // The page's own text. The excerpt read during the check is the cheap route;
        // otherwise the page is read now and remembered, exactly as citing does.
        let pageText = '';
        const hit = (claim.results || []).find((r) => r?.url === msg.url);
        if (hit?.excerpt) {
          pageText = hit.excerpt;
        } else {
          try {
            pageText = await remember(settings, 'pagetext', [msg.url], async () => {
              const raw = await fetchPageHtml(msg.url);
              return raw ? extractParagraphs(raw).slice(0, 12).join('\n\n') : '';
            }) || '';
          } catch { /* an unreadable page simply gives the model less to read */ }
        }

        // Looking for the piece elsewhere, which is where a byline this copy omits is
        // most likely to appear. Uses whichever search provider the reader configured.
        let searchResults = [];
        if (searchReady(settings)) {
          try {
            const search = getSearchProvider(settings.searchProvider);
            const query = [source.title, source.siteName].filter(Boolean).join(' ');
            if (query) {
              searchResults = await remember(settings, 'citesearch', [search.id, query], () =>
                search.search(query, settings.searchApiKey, {}));
            }
          } catch { /* no results is a smaller loss than a failed citation */ }
        }

        return { source, missing, pageText, searchResults: (searchResults || []).slice(0, 3) };
      }, { source: null, missing: [], pageText: '', searchResults: [] });

    case MSG.CHECK_CLAIM:
      requestCheck(msg.claimId, Boolean(msg.withAi), msg.windowId, msg.panelId).catch(() => {});
      return false;

    case MSG.NAV_CLAIM:
      sendToActiveTab({ type: MSG.NAV_CLAIM, direction: msg.direction }, msg.windowId);
      return false;

    case MSG.CAPTION_HINT:
      // Remembered as well as forwarded. The video script only reports a change, so
      // a panel opened after the report, which is the usual order, would otherwise
      // never show the captions-off banner or its "Open the transcript" button.
      if (tabId != null) {
        const caption = { hint: ['off', 'none', 'reading'].includes(msg.hint) ? msg.hint : null,
          scanned: Number.isFinite(msg.scanned) ? msg.scanned : 0 };
        chrome.storage.session.set({ [`caption:${tabId}`]: caption }).catch(() => {});
        chrome.runtime.sendMessage({ type: MSG.CAPTION_HINT, tabId, ...caption }).catch(() => {});
      }
      return false;

    case MSG.NAV_STATE:
      // Straight through to the panel's find-bar counter.
      chrome.runtime
        .sendMessage({
          type: MSG.NAV_STATE,
          tabId,
          claimId: msg.claimId,
          index: msg.index,
          total: msg.total,
        })
        .catch(() => {});
      return false;

    case MSG.FOCUS_CLAIM:
      sendToActiveTab({ type: MSG.FOCUS_SENTENCE, claimId: msg.claimId }, msg.windowId);
      return false;

    default:
      return false;
  }
}
