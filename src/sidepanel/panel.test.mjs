import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { MSG, STATUS, DEFAULT_SETTINGS } from '../shared/messages.js';
import { THEMES, applyTheme } from '../shared/appearance.js';

// Execute the real panel code with its imports supplied as doubles. This tests
// routing and event behavior, not browser layout or extension API permissions.
const code = readFileSync(new URL('./panel.js', import.meta.url), 'utf8').replace(/^import .*;\r?$/gm, '');
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
async function panel(windowId = 1, initialTab = 10) {
  const sends = [];
  const renders = [];
  const ai = [];
  const events = {};
  let active = initialTab;
  let listener;
  let activated;
  let storageListener;
  let settingsReads = 0;
  const nodes = new Map();
  function element() {
    const on = {};
    const attrs = {};
    return { style: { setProperty() {} }, dataset: {}, classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(type, fn) { on[type] = fn; }, click() { on.click?.({ preventDefault() {} }); },
      replaceChildren() {}, appendChild() {}, append() {},
      setAttribute(k, v) { attrs[k] = String(v); }, getAttribute: (k) => attrs[k] ?? null,
      querySelectorAll: () => [], querySelector: () => null };
  }
  const context = vm.createContext({
    console, setTimeout, clearTimeout, URL, Set, Map,
    crypto: { randomUUID: () => 'panel-' + windowId }, MSG, STATUS,
    DEFAULT_FORMAT: 'mla', FORMATS: [], isFormat: () => true,
    getSettings: async () => { settingsReads++; return { ...DEFAULT_SETTINGS }; },
    saveSettings: async () => {}, panelTextSize: () => '14px',
    THEMES, applyTheme: (root, settings) => applyTheme(root, settings, null),
    getSearchProvider: () => ({ requiresKey: false }),
    getLlmProvider: () => ({}), LLM_PROVIDERS: {},
    document: {
      getElementById: (id) => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); },
      documentElement: element(), querySelectorAll: () => [], createElement: element, createElementNS: element,
      addEventListener: (name, fn) => { events[name] = fn; },
    },
    chrome: {
      windows: { getCurrent: async () => ({ id: windowId }) },
      tabs: { query: async () => [{ id: active }], onActivated: { addListener(fn) { activated = fn; } } },
      runtime: {
        onMessage: { addListener(fn) { listener = fn; } },
        sendMessage: async (msg) => { sends.push(msg); return { tabId: active, claims: [], page: null }; },
      },
      storage: { onChanged: { addListener(fn) { storageListener = fn; } } },
    },
    recordRender: (claims) => renders.push(claims), recordAi: (msg) => ai.push(msg),
  });
  new vm.Script(code + '\nrender = recordRender; runInPageLlm = recordAi;').runInContext(context);
  await settle();
  return { sends, renders, ai, events, send: listener, storage: storageListener, node: (id) => nodes.get(id),
    settingsReads: () => settingsReads,
    async activate(tabId, otherWindow = windowId) { active = tabId; activated({ tabId, windowId: otherWindow }); await settle(); },
  };
}

test('panel rejects other tabs and runs built-in AI only in its originating window', async () => {
  const p = await panel();
  p.send({ type: MSG.PANEL_UPDATE, tabId: 10, claims: [{ id: 'own' }] });
  p.send({ type: MSG.PANEL_UPDATE, tabId: 20, claims: [{ id: 'other' }] });
  p.send({ type: MSG.LLM_REQUEST, windowId: 2, tabId: 20 });
  p.send({ type: MSG.LLM_REQUEST, windowId: 1, tabId: 10 });
  await settle();
  assert.equal(p.renders.at(-1)[0].id, 'own');
  assert.equal(p.ai.length, 1);
  assert.equal(p.ai[0].windowId, 1);
  await p.activate(11);
  p.send({ type: MSG.PANEL_UPDATE, tabId: 10, claims: [{ id: 'late' }] });
  await settle();
  assert.equal(p.renders.at(-1).length, 0);
  assert.ok(p.sends.every((msg) => msg.windowId === 1));
});

test('interactive controls retain Enter and arrow keys; plain panel space can navigate', async () => {
  const p = await panel();
  let prevented = 0;
  for (const key of ['Enter', 'ArrowDown', 'ArrowUp']) {
    p.events.keydown({ key, target: { closest: () => ({}) }, preventDefault() { prevented++; } });
  }
  await settle();
  assert.equal(prevented, 0);
  assert.equal(p.sends.filter((msg) => msg.type === MSG.NAV_CLAIM).length, 0);
  p.events.keydown({ key: 'Enter', target: { closest: () => null }, preventDefault() { prevented++; } });
  await settle();
  assert.equal(prevented, 1);
  assert.equal(p.sends.at(-1).type, MSG.NAV_CLAIM);
});

test('tab-state storage writes do not reload panel settings', async () => {
  const p = await panel();
  const before = p.settingsReads();
  await p.storage({ 'tab:10': { newValue: {} } }, 'session');
  await p.storage({ 'fccache:test': { newValue: {} } }, 'local');
  assert.equal(p.settingsReads(), before);
  await p.storage({ fc_settings: { newValue: {} } }, 'local');
  assert.equal(p.settingsReads(), before + 1);
});

test('"Scan this site" sends Always, Default and Never, and a second press of the chosen one sends nothing', async () => {
  const p = await panel();
  p.send({ type: MSG.PAGE_STATUS, tabId: 10, domain: 'news.example', blocked: false, reason: null, rule: 'allow' });
  await settle();
  assert.equal(p.node('siteAllow').getAttribute('aria-pressed'), 'true');
  assert.equal(p.node('siteDefault').getAttribute('aria-pressed'), 'false');

  const rules = () => p.sends.filter((m) => m.type === MSG.SITE_RULE).map((m) => m.action);
  p.node('siteAllow').click(); // already chosen
  await settle();
  assert.deepEqual(rules(), [], 'pressing the chosen option again must not undo it');

  p.node('siteDefault').click();
  p.node('siteBlock').click();
  await settle();
  assert.deepEqual(rules(), ['clear', 'block']);
});

test('changing a setting that affects the page offers a rescan; panel-only changes do not', async () => {
  const p = await panel();
  const change = (before, after) => p.storage({ fc_settings: { oldValue: { ...DEFAULT_SETTINGS, ...before }, newValue: { ...DEFAULT_SETTINGS, ...after } } }, 'local');
  change({ theme: 'system' }, { theme: 'dark' });
  change({ citationFormat: 'mla' }, { citationFormat: 'apa' });
  await settle();
  assert.notEqual(p.node('stale').hidden, false, 'the theme and citation style apply at once');
  change({ threshold: 0.6 }, { threshold: 0.7 });
  await settle();
  assert.equal(p.node('stale').hidden, false);
});

test('the theme button steps System, Light, Dark and says which it is on', async () => {
  const p = await panel();
  const btn = p.node('themeToggle');
  assert.equal(btn.getAttribute('aria-label'), 'Theme: System');
  btn.click();
  assert.equal(btn.getAttribute('aria-label'), 'Theme: Light');
  btn.click();
  assert.equal(btn.getAttribute('aria-label'), 'Theme: Dark');
  btn.click();
  assert.equal(btn.getAttribute('aria-label'), 'Theme: System');
});
