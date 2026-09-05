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
  getScholarProvider,
  originDomain,
  searchQuery,
  browserQuery,
  fetchPageHtml,
  ProviderError,
} from '../providers/index.js';
import { extractParagraphs, relevantExcerpt } from '../shared/extract.js';
import { publishedDateFromHtml } from '../shared/dates.js';
import { engineStyle, searchUrl } from '../shared/engines.js';
import { tabStore, privateTabs } from './tabstate.js';
import { evaluateUrl, applySiteRule } from '../shared/privacy.js';
import { scoreEvidence } from '../shared/evidence.js';
import { createCache, cacheKey } from '../shared/cache.js';
// Content scripts are classic scripts and cannot import, so the worker computes the
// appearance and sends it as plain values with every state reply.
import { highlightVars, highlightStyleName } from '../shared/appearance.js';

function appearanceOf(settings) {
  return {
    vars: highlightVars(settings),
    style: highlightStyleName(settings),
    showVideoOverlay: settings.showVideoOverlay !== false,
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
tabStore.recoverStale().catch(() => {});

chrome.tabs.onRemoved.addListener((tabId) => {
  queue.drop(tabId);
  publishers.delete(tabId);
  privateTabs.forget(tabId).catch(() => {});
  tabStore.clear(tabId).catch(() => {});
});

// Any URL change resets the tab: a real load reports a status, while a single-page-app
// navigation (history.pushState) reports only a url. Requiring both missed every SPA.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url) resetTab(tabId);
});

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
  publishers.delete(tabId);
  chrome.tabs.sendMessage(tabId, { type: MSG.RESCAN }).catch(() => {});
  return true;
}

async function resetTab(tabId) {
  queue.drop(tabId);
  publishers.delete(tabId);
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

async function pushPageStatus(tabId, policy) {
  if ((await activeTabId()) !== tabId) return;
  chrome.runtime.sendMessage({ type: MSG.PAGE_STATUS, tabId, ...policy }).catch(() => {});
}

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
  const flagged = [];
  fresh.forEach((s, i) => {
    if (scores[i] < settings.threshold) return;
    const claim = {
      id: s.id,
      text: s.text,
      ts: s.ts,
      score: Number(scores[i].toFixed(2)),
      status: searchReady(settings) ? STATUS.UNCHECKED : STATUS.NO_KEY,
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
const publishers = new Map(); // tabId -> domains

async function excludedDomains(tabId) {
  const origin = await tabOrigin(tabId);
  const extra = publishers.get(tabId) || [];
  return [...new Set([origin, ...extra].filter(Boolean))];
}

// A search snippet is 150 characters, usually cut mid-sentence, and often missing
// the number or the date the claim turns on. Reading the page itself gives the
// evidence score and the model the paragraphs that actually bear on the claim.
//
// Only the top results, only on a check the user asked for, and never at the cost
// of the results themselves: a page that will not load leaves its snippet in place.
const READ_TOP_N = 2;

async function readSources(claim, results, settings) {
  if (!settings.readSources) return;
  await Promise.all(results.slice(0, READ_TOP_N).map(async (r) => {
    if (!r?.url) return;
    try {
      // The excerpt and the date are cached, not the page: they are small, and
      // they are what gets used. The date the publisher put on the page beats a
      // search provider's guess at it, so it wins where both exist.
      const read = await remember(settings, 'read', [r.url, claim.text], async () => {
        const html = await fetchPageHtml(r.url);
        if (!html) return { excerpt: '', date: '' };
        return {
          excerpt: relevantExcerpt(claim.text, extractParagraphs(html)),
          date: publishedDateFromHtml(html),
        };
      });
      if (read?.excerpt) r.excerpt = read.excerpt;
      if (read?.date) r.date = read.date;
    } catch {
      // Unreadable page: the snippet stands.
    }
  }));
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
    const query = settings.distillQueries ? searchQuery(claim.text) : claim.text;

    // Published fact-checks and, in academic mode, peer-reviewed work come back with
    // the search results, from the same button. A failure in either must not lose
    // the search results, so each is caught apart.
    const academic = Boolean(settings.academicMode);
    const [results, factChecks, scholar] = await Promise.all([
      remember(settings, 'search', [search.id, query, excludeDomain.join(','), academic], () =>
        search.search(query, settings.searchApiKey, { excludeDomain, academic })),
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
  pushHighlights(tabId, [claim]);
}

// --- context menu -----------------------------------------------------------
// The classifier will always miss some claims. Highlighting a sentence and
// right-clicking it puts that sentence through the same path as a flagged one,
// bypassing the threshold and marked as the user's own, so an unflagged claim
// still has a way in. The guards keep the worker loadable where these APIs are
// absent, as in the tests.

const MENU_ID = 'fc-check-selection';

chrome.runtime.onInstalled?.addListener(() => {
  chrome.contextMenus?.create(
    // contexts: ['selection'] means the item only exists once text is highlighted,
    // which is why every instruction says to highlight the sentence first.
    { id: MENU_ID, title: 'Fact-check the highlighted text', contexts: ['selection'] },
    () => void chrome.runtime.lastError, // already exists after a reload; harmless
  );
});

chrome.contextMenus?.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || tab?.id == null) return;
  addUserClaim(tab.id, info.selectionText || '');
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
    await chrome.sidePanel?.open?.({ tabId }).catch(() => {});
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

  // A menu click is a user gesture, which is what opening the panel requires.
  chrome.sidePanel.open?.({ tabId }).catch(() => {});
  await pushPanel(tabId);
  chrome.runtime.sendMessage({ type: MSG.PANEL_FOCUS, claimId }).catch(() => {});
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  switch (msg.type) {
    case MSG.GET_STATE:
      // The fallback refuses: a page that cannot be judged is a page that is not read.
      return reply(sendResponse, async () => {
        const [settings, policy] = await Promise.all([getSettings(), scanPolicy(tabId)]);
        if (tabId != null) pushPageStatus(tabId, policy);
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
      return reply(sendResponse, async () => ({ ok: await rescanTab(await activeTabId()) }), { ok: false });

    case MSG.OPEN_TRANSCRIPT:
      // The panel asks; the video script does it, because only a content script can
      // touch YouTube's own controls.
      activeTabId().then((id) => {
        if (id == null) return;
        chrome.tabs.sendMessage(id, { type: MSG.OPEN_TRANSCRIPT }).catch(() => {});
      });
      return false;

    case MSG.PAGE_SOURCES:
      if (tabId != null) {
        const domains = Array.isArray(msg.domains) ? msg.domains.filter(Boolean).slice(0, 5) : [];
        if (domains.length) publishers.set(tabId, domains);
        else publishers.delete(tabId);
      }
      return false;

    case MSG.SITE_RULE:
      return reply(sendResponse, async () => {
        const settings = await getSettings();
        await saveSettings(applySiteRule(settings, msg.domain, msg.action));
        const id = await activeTabId();
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
      return reply(sendResponse, async () => {
        const id = await activeTabId();
        const state = id == null ? null : await tabStore.peek(id);
        return {
          tabId: id,
          claims: [...(state?.claims.values() || [])],
          page: id == null ? null : await scanPolicy(id),
        };
      }, { tabId: null, claims: [], page: null });

    case MSG.SET_AUTOCHECK:
      return reply(sendResponse, async () => {
        await saveSettings({ autoCheck: msg.autoCheck });
        const id = await activeTabId();
        const policy = await scanPolicy(id);
        sendToActiveTab({
          type: MSG.SCAN_CONFIG,
          autoCheck: msg.autoCheck,
          scanAllowed: !policy.blocked,
          appearance: appearanceOf(await getSettings()),
        });
        return { ok: true };
      }, { ok: false });

    case MSG.LLM_RESULT:
      activeTabId().then(async (id) => {
        const state = id == null ? null : await tabStore.peek(id);
        const claim = state?.claims.get(msg.claimId);
        if (!claim) return;
        claim.summarizing = false;
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
      activeTabId().then(async (id) => {
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

    case MSG.CHECK_CLAIM:
      requestCheck(msg.claimId, Boolean(msg.withAi));
      return false;

    case MSG.NAV_CLAIM:
      sendToActiveTab({ type: MSG.NAV_CLAIM, direction: msg.direction });
      return false;

    case MSG.CAPTION_HINT:
      // Only the active tab's video may put a banner in the panel; a background tab
      // with captions off must not nag about a page the user is not looking at.
      activeTabId().then((id) => {
        if (tabId == null || id !== tabId) return;
        chrome.runtime
          .sendMessage({ type: MSG.CAPTION_HINT, tabId, hint: msg.hint ?? null, scanned: msg.scanned ?? 0 })
          .catch(() => {});
      });
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
