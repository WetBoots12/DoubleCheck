import test from 'node:test';
import assert from 'node:assert/strict';

import { originDomain, isSameSite, excludeOrigin, domainList } from './index.js';

test('originDomain strips www and lowercases', () => {
  assert.equal(originDomain('https://www.Reuters.com/world/some-article/'), 'reuters.com');
  assert.equal(originDomain('https://apnews.com/article/x'), 'apnews.com');
});

test('originDomain keeps non-www subdomains, since they are part of the identity', () => {
  assert.equal(originDomain('https://uk.reuters.com/x'), 'uk.reuters.com');
});

test('originDomain yields empty for unreadable input rather than throwing', () => {
  assert.equal(originDomain(''), '');
  assert.equal(originDomain('not a url'), '');
  assert.equal(originDomain(undefined), '');
});

// The case that matters: the article the user is reading must not be its own
// corroboration, and its subdomains count as the same site.
test('isSameSite matches the domain and its subdomains', () => {
  assert.equal(isSameSite('https://www.reuters.com/x', 'reuters.com'), true);
  assert.equal(isSameSite('https://uk.reuters.com/x', 'reuters.com'), true);
  assert.equal(isSameSite('https://reuters.com/x', 'reuters.com'), true);
});

test('isSameSite does not match lookalikes or unrelated sites', () => {
  assert.equal(isSameSite('https://notreuters.com/x', 'reuters.com'), false);
  assert.equal(isSameSite('https://reuters.com.evil.example/x', 'reuters.com'), false);
  assert.equal(isSameSite('https://apnews.com/x', 'reuters.com'), false);
});

test('isSameSite is false with no domain to compare against', () => {
  assert.equal(isSameSite('https://reuters.com/x', ''), false);
  assert.equal(isSameSite('https://reuters.com/x', undefined), false);
});

test('excludeOrigin drops results from the origin and keeps the rest in order', () => {
  const results = [
    { url: 'https://www.reuters.com/a', title: 'origin' },
    { url: 'https://apnews.com/b', title: 'ap' },
    { url: 'https://uk.reuters.com/c', title: 'origin sub' },
    { url: 'https://bbc.com/d', title: 'bbc' },
  ];
  assert.deepEqual(excludeOrigin(results, 'reuters.com').map((r) => r.title), ['ap', 'bbc']);
});

test('excludeOrigin passes everything through when there is no origin', () => {
  const results = [{ url: 'https://reuters.com/a' }, { url: 'https://apnews.com/b' }];
  assert.equal(excludeOrigin(results, '').length, 2);
  assert.equal(excludeOrigin(results, undefined).length, 2);
});

test('excludeOrigin tolerates results with a missing or malformed url', () => {
  const results = [{ url: '' }, { title: 'no url' }, { url: 'garbage' }, { url: 'https://apnews.com/x' }];
  assert.equal(excludeOrigin(results, 'reuters.com').length, 4);
});

// --- syndication: the portal and the wire that wrote the story are one source ------

test('results from any excluded publisher are dropped, not just the page being read', () => {
  const results = [
    { url: 'https://www.yahoo.com/news/jobs-report' },
    { url: 'https://www.reuters.com/markets/jobs-report' },
    { url: 'https://apnews.com/article/jobs' },
    { url: 'https://www.bbc.co.uk/news/business-1' },
  ];
  const kept = excludeOrigin(results, ['yahoo.com', 'reuters.com']);
  assert.deepEqual(kept.map((r) => new URL(r.url).hostname), ['apnews.com', 'www.bbc.co.uk']);
});

test('subdomains of an excluded publisher go too', () => {
  const results = [{ url: 'https://uk.reuters.com/x' }, { url: 'https://example.com/y' }];
  assert.equal(excludeOrigin(results, ['reuters.com']).length, 1);
});

test('a single domain still works, and empty exclusions keep everything', () => {
  const results = [{ url: 'https://a.com/1' }, { url: 'https://b.com/2' }];
  assert.equal(excludeOrigin(results, 'a.com').length, 1);
  assert.equal(excludeOrigin(results, []).length, 2);
  assert.equal(excludeOrigin(results, ['', null]).length, 2);
  assert.equal(excludeOrigin(results, '').length, 2);
});

test('domainList normalizes, drops blanks and de-duplicates', () => {
  assert.deepEqual(domainList(['Reuters.com', 'reuters.com', ' ', null, 'ap.org']), ['reuters.com', 'ap.org']);
  assert.deepEqual(domainList('BBC.co.uk'), ['bbc.co.uk']);
  assert.deepEqual(domainList(undefined), []);
});
