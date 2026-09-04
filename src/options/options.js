import { getSettings, saveSettings, MSG } from '../shared/messages.js';
import { SEARCH_PROVIDERS, LLM_PROVIDERS } from '../providers/index.js';

const el = (id) => document.getElementById(id);
const fields = {
  autoCheck: el('autoCheck'),
  threshold: el('threshold'),
  thresholdVal: el('thresholdVal'),
  searchProvider: el('searchProvider'),
  searchApiKey: el('searchApiKey'),
  llmProvider: el('llmProvider'),
  llmApiKey: el('llmApiKey'),
  llmKeyField: el('llmKeyField'),
};

// Providers that need no key of their own (browser's built-in AI, or no summary at all).
const KEYLESS_LLM = new Set(['none', 'builtin']);

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
  fields.llmKeyField.style.display = KEYLESS_LLM.has(fields.llmProvider.value) ? 'none' : '';
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
    searchApiKey: fields.searchApiKey.value.trim(),
    llmProvider: fields.llmProvider.value,
    llmApiKey: KEYLESS_LLM.has(fields.llmProvider.value) ? '' : fields.llmApiKey.value.trim(),
  });

  // Let the active tab's content script react without needing a reload.
  chrome.runtime.sendMessage({ type: MSG.SET_AUTOCHECK, autoCheck }).catch(() => {});

  el('saved').classList.add('show');
  setTimeout(() => el('saved').classList.remove('show'), 1800);
}

(async () => {
  fill(fields.searchProvider, Object.values(SEARCH_PROVIDERS));

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
  fields.llmProvider.value = llmOptions.some((p) => p.id === s.llmProvider) ? s.llmProvider : 'none';
  fields.llmApiKey.value = s.llmApiKey;
  syncLlmKeyVisibility();

  fields.threshold.addEventListener('input', () => {
    fields.thresholdVal.textContent = Number(fields.threshold.value).toFixed(2);
  });
  fields.llmProvider.addEventListener('change', syncLlmKeyVisibility);
  el('save').addEventListener('click', save);
})();
