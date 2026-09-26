// What goes into the store zip. The build refuses to write a zip with a dangling
// reference; these tests keep the list itself honest as files are added and moved.

import test from 'node:test';
import assert from 'node:assert/strict';
import { packageFiles, missingReferences } from './package.mjs';

const files = packageFiles();

test('everything the manifest, pages and scripts refer to is in the package', () => {
  assert.deepEqual(missingReferences(files), []);
});

test('the pieces the extension cannot run without are included', () => {
  for (const f of ['manifest.json', 'classifier/model/model.json', 'src/background/index.js',
    'src/sidepanel/panel.html', 'src/options/options.html', 'src/options/support-qr.png',
    'src/icons/icon-16.png', 'src/icons/icon-32.png', 'src/icons/icon-48.png', 'src/icons/icon-128.png']) {
    assert.ok(files.includes(f), `missing ${f}`);
  }
});

test('the licence and the dataset credit travel with the model', () => {
  assert.ok(files.includes('LICENSE'));
  assert.ok(files.includes('ATTRIBUTION.md'));
});

test('no tests, training data, developer pages or docs are shipped', () => {
  const stray = files.filter((f) => /\.test\.m?js$/.test(f) || /^(tools|docs|classifier\/train|classifier\/eval)\//.test(f)
    || f === 'qr-code-coffee.png' || f.endsWith('.md') && f !== 'ATTRIBUTION.md');
  assert.deepEqual(stray, []);
});
