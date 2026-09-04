import { getSettings, saveSettings, MSG } from '../shared/messages.js';
import { SEARCH_PROVIDERS, LLM_PROVIDERS, FACTCHECK_PROVIDERS } from '../providers/index.js';
import { parseDomainList } from '../shared/privacy.js';
import {
  HIGHLIGHT_STYLES, HIGHLIGHT_COLORS, THICKNESS, PANEL_SIZES, applyAppearance,
} from '../shared/appearance.js';

const el = (id) => document.getElementById(id);

// Three panels behind one page: the guide, the settings, and the credits. The guide
// is first and open by default, because someone opening this page for the first time
// needs to know what the extension does before changing how it does it.
const TABS = ['guide', 'settings', 'credits'];

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
  distillQueries: el('distillQueries'),
  cacheResults: el('cacheResults'),
  highlightStyle: el('highlightStyle'),
  highlightColor: el('highlightColor'),
  highlightThickness: el('highlightThickness'),
  panelTextSize: el('panelTextSize'),
  showVideoOverlay: el('showVideoOverlay'),
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

async function save() {
  if (!validate()) return;

  const autoCheck = fields.autoCheck.checked;
  await saveSettings({
    autoCheck,
    threshold: Number(fields.threshold.value),
    searchProvider: fields.searchProvider.value,
    factCheckProvider: fields.factCheckProvider.value,
    factCheckApiKey: fields.factCheckApiKey.value.trim(),
    searchApiKey: fields.searchApiKey.value.trim(),
    distillQueries: fields.distillQueries.checked,
    cacheResults: fields.cacheResults.checked,
    highlightStyle: fields.highlightStyle.value,
    highlightColor: fields.highlightColor.value,
    highlightThickness: fields.highlightThickness.value,
    panelTextSize: fields.panelTextSize.value,
    showVideoOverlay: fields.showVideoOverlay.checked,
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
  });

  // Let the active tab's content script react without needing a reload.
  chrome.runtime.sendMessage({ type: MSG.SET_AUTOCHECK, autoCheck }).catch(() => {});

  el('saved').classList.add('show');
  setTimeout(() => el('saved').classList.remove('show'), 1800);
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
  fields.searchProvider.value = s.searchProvider;
  fields.searchApiKey.value = s.searchApiKey;
  fields.distillQueries.checked = Boolean(s.distillQueries);
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
  wireTabs();
  el('save').addEventListener('click', save);
})();
