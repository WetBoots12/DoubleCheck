import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HIGHLIGHT_STYLES, HIGHLIGHT_COLORS, THICKNESS, PANEL_SIZES,
  DEFAULT_APPEARANCE, highlightVars, highlightStyleName, panelTextSize, applyAppearance,
} from './appearance.js';

// Stands in for a document root: the two things applyAppearance touches.
function fakeRoot() {
  const props = new Map();
  const attrs = new Map();
  return {
    props,
    attrs,
    style: { setProperty: (k, v) => props.set(k, v) },
    setAttribute: (k, v) => attrs.set(k, v),
  };
}

test('the defaults name real options', () => {
  assert.ok(HIGHLIGHT_STYLES.some((s) => s.id === DEFAULT_APPEARANCE.highlightStyle));
  assert.ok(HIGHLIGHT_COLORS.some((c) => c.id === DEFAULT_APPEARANCE.highlightColor));
  assert.ok(THICKNESS.some((t) => t.id === DEFAULT_APPEARANCE.highlightThickness));
  assert.ok(PANEL_SIZES.some((p) => p.id === DEFAULT_APPEARANCE.panelTextSize));
  assert.equal(DEFAULT_APPEARANCE.showVideoOverlay, true);
});

test('a chosen colour and thickness become the variables the stylesheet reads', () => {
  const vars = highlightVars({ highlightColor: 'blue', highlightThickness: 'thick' });
  assert.equal(vars['--fc-color'], '#3d7ea6');
  assert.equal(vars['--fc-line'], '3px');
  assert.ok(vars['--fc-color-checked'], 'the checked colour must be set too');
});

test('every colour offers a distinct pair, so checked and unchecked never look alike', () => {
  for (const c of HIGHLIGHT_COLORS) {
    assert.notEqual(c.unchecked, c.checked, `${c.id} uses one colour for both states`);
    assert.match(c.unchecked, /^#[0-9a-f]{6}$/i, `${c.id} unchecked is not a hex colour`);
    assert.match(c.checked, /^#[0-9a-f]{6}$/i, `${c.id} checked is not a hex colour`);
  }
});

test('an unknown or missing choice falls back to the default rather than breaking the page', () => {
  const vars = highlightVars({ highlightColor: 'chartreuse', highlightThickness: 'enormous' });
  assert.equal(vars['--fc-color'], '#c8963e');
  assert.equal(vars['--fc-line'], '2px');
  assert.deepEqual(highlightVars(), highlightVars({}));
  assert.equal(highlightStyleName({ highlightStyle: 'nonsense' }), 'both');
  assert.equal(panelTextSize({ panelTextSize: 'gigantic' }), '13px');
  assert.equal(panelTextSize(), '13px');
});

test('applying writes the variables and the style attribute the stylesheet keys off', () => {
  const root = fakeRoot();
  applyAppearance(root, { highlightColor: 'violet', highlightStyle: 'underline', highlightThickness: 'thin' });
  assert.equal(root.props.get('--fc-color'), '#7a5ea8');
  assert.equal(root.props.get('--fc-line'), '1px');
  assert.equal(root.attrs.get('data-fc-style'), 'underline');
});

test('applying to nothing, or to something without a style, does not throw', () => {
  applyAppearance(null, {});
  applyAppearance(undefined);
  applyAppearance({}, { highlightColor: 'blue' });
});

test('the panel size choices are real CSS lengths and differ from each other', () => {
  const sizes = PANEL_SIZES.map((p) => p.px);
  assert.equal(new Set(sizes).size, sizes.length, 'two sizes are the same');
  for (const px of sizes) assert.match(px, /^\d+px$/);
});

test('turning off page marks still leaves a style name, not an empty attribute', () => {
  assert.equal(highlightStyleName({ highlightStyle: 'none' }), 'none');
});

test('the theme setting becomes data-theme, and System removes it', async () => {
  const { themeChoice, applyTheme, THEMES } = await import('./appearance.js');
  assert.deepEqual(THEMES.map((t) => t.id), ['system', 'light', 'dark']);
  assert.equal(themeChoice({ theme: 'dark' }), 'dark');
  assert.equal(themeChoice({ theme: 'system' }), null);
  assert.equal(themeChoice({ theme: 'purple' }), null, 'an unknown value follows the system');

  const kept = new Map();
  const storage = { setItem: (k, v) => kept.set(k, v), removeItem: (k) => kept.delete(k) };
  const root = { dataset: {} };
  applyTheme(root, { theme: 'light' }, storage);
  assert.equal(root.dataset.theme, 'light');
  assert.equal(kept.get('dc-theme'), 'light', 'remembered so the next page paints in it');
  applyTheme(root, { theme: 'system' }, storage);
  assert.equal(root.dataset.theme, undefined);
  assert.equal(kept.has('dc-theme'), false);
});

test('a page that cannot write storage still takes the theme', async () => {
  const { applyTheme } = await import('./appearance.js');
  const root = { dataset: {} };
  applyTheme(root, { theme: 'dark' }, { setItem() { throw new Error('denied'); }, removeItem() {} });
  assert.equal(root.dataset.theme, 'dark');
});
