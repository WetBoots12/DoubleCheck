import { getSettings, saveSettings, changedSettings, MSG } from '../shared/messages.js';
import { SEARCH_PROVIDERS, LLM_PROVIDERS, FACTCHECK_PROVIDERS } from '../providers/index.js';
import { parseDomainList } from '../shared/privacy.js';
import {
  HIGHLIGHT_STYLES, HIGHLIGHT_COLORS, THICKNESS, PANEL_SIZES, applyAppearance,
} from '../shared/appearance.js';
import { SEARCH_ENGINES } from '../shared/engines.js';
import {
  FORMATS, DEFAULT_FORMAT, isFormat, formatCitation, citationSegments, worksCited, missingFields,
} from '../shared/citation.js';
import { citableSources } from '../shared/sources.js';
import { worksCitedRtf, worksCitedText } from '../shared/rtf.js';
import { worksCitedDocx } from '../shared/docx.js';

const el = (id) => document.getElementById(id);

// Three panels behind one page: the guide, the settings, and the credits. The guide
// is first and open by default, because someone opening this page for the first time
// needs to know what the extension does before changing how it does it.
const TABS = ['guide', 'settings', 'sources', 'credits', 'support'];

function showTab(name) {
  for (const id of TABS) {
    const panel = el(`tab-${id}`);
    const button = el(`tab-${id}-btn`);
    if (!panel || !button) continue;
    const selected = id === name;
    panel.hidden = !selected;
    button.setAttribute('aria-selected', String(selected));
  }
  // Deep links: options.html#credits opens on the credits, which is where a licence
  // question is usually coming from.
  if (location.hash.slice(1) !== name) history.replaceState(null, '', `#${name}`);
}

function wireTabs() {
  for (const id of TABS) {
    el(`tab-${id}-btn`)?.addEventListener('click', () => showTab(id));
  }
  const requested = location.hash.slice(1);
  showTab(TABS.includes(requested) ? requested : 'guide');
}
const fields = {
  autoCheck: el('autoCheck'),
  threshold: el('threshold'),
  thresholdVal: el('thresholdVal'),
  searchProvider: el('searchProvider'),
  searchApiKey: el('searchApiKey'),
  searchKeyField: el('searchKeyField'),
  browserSearchEngine: el('browserSearchEngine'),
  distillQueries: el('distillQueries'),
  cacheResults: el('cacheResults'),
  faintFlags: el('faintFlags'),
  highlightStyle: el('highlightStyle'),
  highlightColor: el('highlightColor'),
  highlightThickness: el('highlightThickness'),
  panelTextSize: el('panelTextSize'),
  showVideoOverlay: el('showVideoOverlay'),
  autoTranscript: el('autoTranscript'),
  readSources: el('readSources'),
  academicMode: el('academicMode'),
  privateSitesRule: el('privateSitesRule'),
  blockedDomains: el('blockedDomains'),
  allowedDomains: el('allowedDomains'),
  trustedDomains: el('trustedDomains'),
  distrustedDomains: el('distrustedDomains'),
  llmProvider: el('llmProvider'),
  factCheckProvider: el('factCheckProvider'),
  factCheckApiKey: el('factCheckApiKey'),
  factCheckKeyField: el('factCheckKeyField'),
  llmApiKey: el('llmApiKey'),
  llmKeyField: el('llmKeyField'),
  llmModelField: el('llmModelField'),
  llmModel: el('llmModel'),
  llmModelHint: el('llmModelHint'),
  localFields: el('localFields'),
  localLlmUrl: el('localLlmUrl'),
  localLlmModel: el('localLlmModel'),
  builtinNote: el('builtinNote'),
};

// Providers needing no key: no summary, the browser's own model, or a local server.
const KEYLESS_LLM = new Set(['none', 'builtin', 'local']);

// Shown as the placeholder so the default is visible without being saved.
const MODEL_DEFAULTS = {
  anthropic: { placeholder: 'claude-haiku-4-5', hint: 'Leave empty for claude-haiku-4-5, the cheapest current model. claude-opus-5 gives stronger summaries at higher cost.' },
  openai: { placeholder: 'gpt-4o-mini', hint: 'Leave empty for gpt-4o-mini. Any chat-completions model ID your key can use works here.' },
};

function fill(select, providers) {
  select.innerHTML = '';
  for (const p of providers) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.label;
    select.appendChild(opt);
  }
}

function syncLlmKeyVisibility() {
  const id = fields.llmProvider.value;
  fields.llmKeyField.style.display = KEYLESS_LLM.has(id) ? 'none' : '';
  fields.localFields.style.display = id === 'local' ? '' : 'none';
  fields.builtinNote.style.display = id === 'builtin' ? '' : 'none';
  fields.factCheckKeyField.style.display = fields.factCheckProvider.value === 'none' ? 'none' : '';
  fields.searchKeyField.style.display =
    SEARCH_PROVIDERS[fields.searchProvider.value]?.requiresKey === false ? 'none' : '';
  const hosted = MODEL_DEFAULTS[id];
  fields.llmModelField.style.display = hosted ? '' : 'none';
  if (hosted) {
    fields.llmModel.placeholder = hosted.placeholder;
    fields.llmModelHint.textContent = hosted.hint;
  }
}

// What the sample shows, live, without saving first: the same variables the real
// highlights use are written onto this page's root.
function currentAppearance() {
  return {
    highlightStyle: fields.highlightStyle.value,
    highlightColor: fields.highlightColor.value,
    highlightThickness: fields.highlightThickness.value,
  };
}

function previewAppearance() {
  applyAppearance(document.documentElement, currentAppearance());
}

function showError(id, message) {
  const node = el(id);
  node.textContent = message;
  node.classList.toggle('show', Boolean(message));
}

// Cheap well-formedness check only — no live call against the provider.
function validate() {
  let ok = true;
  showError('searchErr', '');
  showError('llmErr', '');

  const searchKey = fields.searchApiKey.value.trim();
  if (searchKey && searchKey.length < 16) {
    showError('searchErr', 'That looks too short to be a valid API key.');
    ok = false;
  }

  const llmId = fields.llmProvider.value;
  const llmKey = fields.llmApiKey.value.trim();
  if (!KEYLESS_LLM.has(llmId)) {
    if (!llmKey) {
      showError('llmErr', 'This provider needs an API key, or switch the provider to "None".');
      ok = false;
    } else if (llmId === 'anthropic' && !llmKey.startsWith('sk-ant-')) {
      showError('llmErr', 'Anthropic keys normally start with "sk-ant-".');
      ok = false;
    } else if (llmId === 'openai' && !llmKey.startsWith('sk-')) {
      showError('llmErr', 'OpenAI keys normally start with "sk-".');
      ok = false;
    }
  }

  return ok;
}

let formBaseline = {};

function formValues() {
  return {
    autoCheck: fields.autoCheck.checked,
    threshold: Number(fields.threshold.value),
    searchProvider: fields.searchProvider.value,
    browserSearchEngine: fields.browserSearchEngine.value,
    factCheckProvider: fields.factCheckProvider.value,
    factCheckApiKey: fields.factCheckApiKey.value.trim(),
    searchApiKey: fields.searchApiKey.value.trim(),
    distillQueries: fields.distillQueries.checked,
    cacheResults: fields.cacheResults.checked,
    faintFlags: fields.faintFlags.checked,
    highlightStyle: fields.highlightStyle.value,
    highlightColor: fields.highlightColor.value,
    highlightThickness: fields.highlightThickness.value,
    panelTextSize: fields.panelTextSize.value,
    showVideoOverlay: fields.showVideoOverlay.checked,
    autoTranscript: fields.autoTranscript.checked,
    readSources: fields.readSources.checked,
    academicMode: fields.academicMode.checked,
    privateSitesRule: fields.privateSitesRule.checked,
    blockedDomains: parseDomainList(fields.blockedDomains.value),
    allowedDomains: parseDomainList(fields.allowedDomains.value),
    trustedDomains: parseDomainList(fields.trustedDomains.value),
    distrustedDomains: parseDomainList(fields.distrustedDomains.value),
    llmProvider: fields.llmProvider.value,
    // Keep the key even while a keyless provider is selected, so switching back
    // later doesn't mean pasting it again.
    llmApiKey: fields.llmApiKey.value.trim(),
    llmModel: fields.llmModel.value.trim(),
    localLlmUrl: fields.localLlmUrl.value.trim() || 'http://localhost:11434/v1',
    localLlmModel: fields.localLlmModel.value.trim() || 'llama3.1',
  };
}

async function save() {
  if (!validate()) return;
  const values = formValues();
  const settings = await saveSettings(changedSettings(values, formBaseline));
  formBaseline = values;
  const autoCheck = settings.autoCheck;

  // Let the active tab's content script react without needing a reload.
  chrome.runtime.sendMessage({ type: MSG.SET_AUTOCHECK, autoCheck }).catch(() => {});

  el('saved').classList.add('show');
  setTimeout(() => el('saved').classList.remove('show'), 1800);
}


// --- the works cited list ------------------------------------------------------
//
// The reader's own list, kept one press at a time from the side panel. This page
// shows it, lets them drop entries, and writes it out in the four ways someone
// actually wants it: on the clipboard, as a Word document, as rich text, as plain
// text. Nothing here reaches the network.

let keptSources = [];

function citationStyle() {
  const chosen = el('sourcesFormat')?.value;
  return isFormat(chosen) ? chosen : DEFAULT_FORMAT;
}

// A file the browser saves. An extension page can hand one over with a blob and a
// download link, which needs no permission; the link is created, clicked and
// revoked, because a page that leaks object URLs holds the data alive for as long
// as it is open.
function saveFile(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function sourcesStatus(text) {
  const status = el('sourcesStatus');
  if (!status) return;
  status.textContent = text;
  setTimeout(() => { status.textContent = ''; }, 2600);
}

function renderSources() {
  const box = el('sourcesList');
  if (!box) return;
  box.replaceChildren();

  if (!keptSources.length) {
    const none = document.createElement('div');
    none.className = 'none';
    none.textContent = 'Nothing kept yet. Open the side panel on a page worth citing and '
      + 'press "Add this page as a source".';
    box.appendChild(none);
    return;
  }

  const style = citationStyle();
  for (const source of keptSources) {
    const [citable] = citableSources([source]);
    const entry = document.createElement('div');
    entry.className = 'entry';

    const what = document.createElement('div');
    what.className = 'what';

    const cite = document.createElement('div');
    cite.className = 'cite';
    cite.textContent = formatCitation(citable, style);
    what.appendChild(cite);

    // Say what the entry could not say, because a reader who knows the author is
    // missing can go and find it, and one who does not will paste it as it is.
    const gaps = missingFields(citable);
    if (gaps.length) {
      const note = document.createElement('div');
      note.className = 'gaps';
      note.textContent = `The page did not state the ${gaps.join(' or the ')}.`;
      what.appendChild(note);
    }
    entry.appendChild(what);

    const drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'ghost';
    drop.textContent = 'Remove';
    drop.addEventListener('click', async () => {
      drop.disabled = true;
      const res = await chrome.runtime.sendMessage({ type: MSG.REMOVE_SOURCE, key: source.key }).catch(() => null);
      if (Array.isArray(res?.sources)) {
        keptSources = res.sources;
        renderSources();
      } else {
        drop.disabled = false;
        sourcesStatus('Could not remove that one; try again.');
      }
    });
    entry.appendChild(drop);
    box.appendChild(entry);
  }
}

function citedEntries() {
  const style = citationStyle();
  const citable = citableSources(keptSources);
  // Deduplicated and alphabetised by worksCited, then re-segmented so the file
  // formats keep their italics. Sorting on the rendered line is what "alphabetical"
  // means to the person reading it.
  const lines = worksCited(citable, style);
  const byLine = new Map(citable.map((s) => [formatCitation(s, style), s]));
  return { lines, segments: lines.map((line) => citationSegments(byLine.get(line), style)) };
}

async function wireSources() {
  const select = el('sourcesFormat');
  if (!select) return;

  for (const f of FORMATS) {
    const opt = document.createElement('option');
    opt.value = f.id;
    opt.textContent = f.label;
    select.appendChild(opt);
  }
  const settings = await getSettings();
  select.value = isFormat(settings.citationFormat) ? settings.citationFormat : DEFAULT_FORMAT;

  // The same choice the side panel uses, so changing it in either place changes both.
  select.addEventListener('change', () => {
    saveSettings({ citationFormat: select.value }).catch(() => {});
    renderSources();
  });

  el('copySources').addEventListener('click', async () => {
    const { lines } = citedEntries();
    if (!lines.length) return sourcesStatus('Nothing to copy yet.');
    try {
      await navigator.clipboard.writeText(worksCitedText(lines));
      sourcesStatus(`Copied ${lines.length} ${lines.length === 1 ? 'entry' : 'entries'}.`);
    } catch {
      sourcesStatus('The clipboard refused; try saving a file instead.');
    }
  });

  el('saveDocx').addEventListener('click', () => {
    const { segments, lines } = citedEntries();
    if (!lines.length) return sourcesStatus('Nothing to save yet.');
    saveFile('works-cited.docx', new Blob([worksCitedDocx(segments)], {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }));
    sourcesStatus('Saved.');
  });

  el('saveRtf').addEventListener('click', () => {
    const { segments, lines } = citedEntries();
    if (!lines.length) return sourcesStatus('Nothing to save yet.');
    saveFile('works-cited.rtf', new Blob([worksCitedRtf(segments)], { type: 'application/rtf' }));
    sourcesStatus('Saved.');
  });

  el('saveTxt').addEventListener('click', () => {
    const { lines } = citedEntries();
    if (!lines.length) return sourcesStatus('Nothing to save yet.');
    saveFile('works-cited.txt', new Blob([worksCitedText(lines)], { type: 'text/plain;charset=utf-8' }));
    sourcesStatus('Saved.');
  });

  el('clearSources').addEventListener('click', async () => {
    if (!keptSources.length) return sourcesStatus('The list is already empty.');
    const res = await chrome.runtime.sendMessage({ type: MSG.CLEAR_SOURCES }).catch(() => null);
    if (Array.isArray(res?.sources)) {
      keptSources = res.sources;
      renderSources();
      sourcesStatus('Removed.');
    } else {
      sourcesStatus('Could not clear the list; try again.');
    }
  });

  const res = await chrome.runtime.sendMessage({ type: MSG.LIST_SOURCES }).catch(() => null);
  keptSources = res?.sources || [];
  renderSources();
}

(async () => {
  fill(fields.searchProvider, Object.values(SEARCH_PROVIDERS));
  fill(fields.factCheckProvider, Object.values(FACTCHECK_PROVIDERS));

  // Hide the built-in AI option on browsers that don't actually expose it.
  const llmOptions = [];
  for (const p of Object.values(LLM_PROVIDERS)) {
    if (p.id === 'builtin' && !(await p.isAvailable())) continue;
    llmOptions.push(p);
  }
  fill(fields.llmProvider, llmOptions);

  const s = await getSettings();
  fields.autoCheck.checked = s.autoCheck;
  fields.threshold.value = s.threshold;
  fields.thresholdVal.textContent = Number(s.threshold).toFixed(2);
  fill(fields.browserSearchEngine, SEARCH_ENGINES);
  fields.browserSearchEngine.value = s.browserSearchEngine;
  fields.searchProvider.value = s.searchProvider;
  fields.searchApiKey.value = s.searchApiKey;
  fields.distillQueries.checked = Boolean(s.distillQueries);
  fields.faintFlags.checked = Boolean(s.faintFlags);
  fields.cacheResults.checked = s.cacheResults !== false;
  fill(fields.highlightStyle, HIGHLIGHT_STYLES);
  fill(fields.highlightColor, HIGHLIGHT_COLORS);
  fill(fields.highlightThickness, THICKNESS);
  fill(fields.panelTextSize, PANEL_SIZES);
  fields.highlightStyle.value = s.highlightStyle;
  fields.highlightColor.value = s.highlightColor;
  fields.highlightThickness.value = s.highlightThickness;
  fields.panelTextSize.value = s.panelTextSize;
  fields.showVideoOverlay.checked = s.showVideoOverlay !== false;
  fields.autoTranscript.checked = s.autoTranscript !== false;
  previewAppearance();
  for (const f of [fields.highlightStyle, fields.highlightColor, fields.highlightThickness]) {
    f.addEventListener('change', previewAppearance);
  }
  fields.readSources.checked = s.readSources !== false;
  fields.academicMode.checked = Boolean(s.academicMode);
  fields.privateSitesRule.checked = s.privateSitesRule !== false;
  fields.blockedDomains.value = (s.blockedDomains || []).join('\n');
  fields.allowedDomains.value = (s.allowedDomains || []).join('\n');
  fields.trustedDomains.value = (s.trustedDomains || []).join('\n');
  fields.distrustedDomains.value = (s.distrustedDomains || []).join('\n');
  // The comparison page is an extension page, so it can read the saved key itself.
  el('compareLink').href = chrome.runtime.getURL('tools/query-compare.html');
  el('compareLink').target = '_blank';
  fields.factCheckProvider.value = s.factCheckProvider;
  fields.factCheckApiKey.value = s.factCheckApiKey;
  fields.llmProvider.value = llmOptions.some((p) => p.id === s.llmProvider) ? s.llmProvider : 'none';
  fields.llmApiKey.value = s.llmApiKey;
  fields.llmModel.value = s.llmModel || '';
  fields.localLlmUrl.value = s.localLlmUrl;
  fields.localLlmModel.value = s.localLlmModel;
  syncLlmKeyVisibility();
  formBaseline = formValues();

  fields.threshold.addEventListener('input', () => {
    fields.thresholdVal.textContent = Number(fields.threshold.value).toFixed(2);
  });
  fields.llmProvider.addEventListener('change', syncLlmKeyVisibility);
  fields.factCheckProvider.addEventListener('change', syncLlmKeyVisibility);
  fields.searchProvider.addEventListener('change', syncLlmKeyVisibility);
  // Emptying the store is the worker's job: it owns the cache and its keys.
  el('clearCache').addEventListener('click', async () => {
    const status = el('cacheStatus');
    const res = await chrome.runtime.sendMessage({ type: MSG.CLEAR_CACHE }).catch(() => null);
    status.textContent = res?.ok ? 'Cleared.' : 'Could not clear; try again.';
    setTimeout(() => { status.textContent = ''; }, 2500);
  });
  await wireSources();
  el('save').addEventListener('click', save);
})();

// Wired before anything above is awaited: the tabs only switch panels, and the
// start-up work (asking the on-device model whether it exists, loading the works
// cited list) used to leave them dead for a second or two after the page opened.
wireTabs();
