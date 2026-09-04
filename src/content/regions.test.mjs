import test from 'node:test';
import assert from 'node:assert/strict';

import './regions.js';
const { isSideRegion, SIDE_LIMIT } = globalThis.FCRegions;

test('a small named region really is furniture', () => {
  // A share bar, a newsletter box, a related rail: a fraction of the article.
  assert.equal(isSideRegion(300, 10000), true);
  assert.equal(isSideRegion(1200, 10000), true);
});

test('a container holding most of the article is the article, whatever it is called', () => {
  // The Fox News case: <article class="article-wrap has-video"> around the whole
  // story. "has-video" matched the player rule and discarded every paragraph.
  assert.equal(isSideRegion(9500, 10000), false);
  assert.equal(isSideRegion(6000, 10000), false);
});

test('the boundary is half the article', () => {
  assert.equal(SIDE_LIMIT, 0.5);
  assert.equal(isSideRegion(4999, 10000), true);
  assert.equal(isSideRegion(5000, 10000), false, 'exactly half counts as the article');
});

test('an unknown size keeps the old behaviour, which is to exclude', () => {
  // Positive evidence is required to overrule a rule that named the region.
  for (const [node, root] of [[undefined, 10000], [null, 10000], [NaN, 10000], ['x', 10000]]) {
    assert.equal(isSideRegion(node, root), true, `${node} should not rescue the region`);
  }
});

test('an empty or unmeasurable article does not turn every region into the article', () => {
  assert.equal(isSideRegion(500, 0), true);
  assert.equal(isSideRegion(500, undefined), true);
  assert.equal(isSideRegion(500, -1), true);
  assert.equal(isSideRegion(0, 10000), true, 'a region with no text is furniture by definition');
});

test('the limit can be tightened or loosened by the caller', () => {
  assert.equal(isSideRegion(3000, 10000, 0.2), false, 'a stricter limit keeps more of the page');
  assert.equal(isSideRegion(3000, 10000, 0.9), true);
});
