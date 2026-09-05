import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateUrl, parseDomainList, normalizeDomain, applySiteRule, hostMatches, httpUrl } from './privacy.js';

const ok = (url, settings) => assert.equal(evaluateUrl(url, settings).blocked, false, `should scan ${url}`);
const blocked = (url, settings, reason) => {
  const r = evaluateUrl(url, settings);
  assert.equal(r.blocked, true, `should block ${url}`);
  if (reason) assert.equal(r.reason, reason, `reason for ${url}`);
};

// --- the user's own lists win --------------------------------------------------

test('a never-scan domain is blocked, subdomains included', () => {
  const s = { blockedDomains: ['example.com'] };
  blocked('https://www.example.com/news/story', s, 'user');
  blocked('https://sub.example.com/', s, 'user');
});

test('an always-scan domain overrides every built-in rule', () => {
  const s = { allowedDomains: ['chase.com'] };
  ok('https://secure.chase.com/account/login', s);
});

test('never-scan beats always-scan when both list the same domain', () => {
  const s = { blockedDomains: ['example.com'], allowedDomains: ['example.com'] };
  blocked('https://example.com/', s, 'user');
});

test('turning the built-in rule off scans a bank, but the user list still applies', () => {
  ok('https://secure.chase.com/', { privateSitesRule: false });
  blocked('https://example.com/', { privateSitesRule: false, blockedDomains: ['example.com'] }, 'user');
});

// --- built-in rules -------------------------------------------------------------

test('known sensitive domains are blocked by suffix', () => {
  blocked('https://secure.chase.com/', {}, 'builtin');
  blocked('https://www.paypal.com/myaccount', {}, 'builtin');
  blocked('https://mail.google.com/mail/u/0/', {}, 'builtin');
  blocked('https://www.irs.gov/', {}, 'builtin');
});

// The rule that matters most: whole-label matching, never substrings.
test('hostname keywords match whole labels only', () => {
  blocked('https://online-banking.example.com/', {}, 'builtin');
  blocked('https://patient.hospitalgroup.org/', {}, 'builtin');
  blocked('https://my.university.edu/', {}, 'builtin');
  ok('https://www.dailymail.co.uk/news/article', {});
  ok('https://www.healthline.com/health-news/story', {});
  ok('https://www.bankrate.com/banking/news', {});
  ok('https://www.investopedia.com/terms/i/inflation.asp', {});
  ok('https://www.taxfoundation.org/blog/', {});
});

test('path segments match whole segments only', () => {
  blocked('https://shop.example.com/checkout', {}, 'builtin');
  blocked('https://news.example.com/account/settings', {}, 'builtin');
  ok('https://news.example.com/2026/account-of-the-battle', {});
  ok('https://news.example.com/politics/login-fees-rise', {});
});

test('local and private-network addresses are blocked', () => {
  blocked('http://localhost:3000/', {}, 'local');
  blocked('http://192.168.1.10/admin', {}, 'local');
  blocked('http://10.0.0.5/', {}, 'local');
  blocked('http://172.20.0.1/', {}, 'local');
  blocked('http://wiki.internal/', {}, 'local');
  blocked('http://intranet/', {}, 'local');
});

test('non-http schemes and unparseable urls are unsupported', () => {
  blocked('file:///C:/Users/me/report.html', {}, 'unsupported');
  blocked('chrome://extensions', {}, 'unsupported');
  blocked('not a url', {}, 'unsupported');
  blocked('', {}, 'unsupported');
});

test('ordinary news sites scan', () => {
  ok('https://www.reuters.com/world/us/', {});
  ok('https://apnews.com/article/x', {});
  ok('https://en.wikipedia.org/wiki/Inflation', {});
  ok('https://www.youtube.com/watch?v=abc', {});
});

test('the result reports the domain and the standing rule for the thumbs buttons', () => {
  assert.deepEqual(evaluateUrl('https://www.reuters.com/x', {}).domain, 'reuters.com');
  assert.equal(evaluateUrl('https://reuters.com/x', { blockedDomains: ['reuters.com'] }).rule, 'block');
  assert.equal(evaluateUrl('https://reuters.com/x', { allowedDomains: ['reuters.com'] }).rule, 'allow');
  assert.equal(evaluateUrl('https://reuters.com/x', {}).rule, null);
});

// --- list parsing ----------------------------------------------------------------

test('normalizeDomain strips scheme, path, port and www, and lowercases', () => {
  assert.equal(normalizeDomain('https://www.Example.com:8443/path?q=1'), 'example.com');
  assert.equal(normalizeDomain('  news.site.org  '), 'news.site.org');
  assert.equal(normalizeDomain('# a comment'), '');
  assert.equal(normalizeDomain('not a domain!'), '');
  assert.equal(normalizeDomain(''), '');
});

test('parseDomainList takes one per line, ignores blanks and comments, and dedupes', () => {
  const text = 'example.com\n\n# banks\nhttps://www.chase.com/\nEXAMPLE.com\n  \n';
  assert.deepEqual(parseDomainList(text), ['example.com', 'chase.com']);
});

// --- thumbs up / thumbs down --------------------------------------------------------

test('applySiteRule moves a domain between the lists', () => {
  let s = { blockedDomains: [], allowedDomains: [] };
  s = { ...s, ...applySiteRule(s, 'news.example.com', 'block') };
  assert.deepEqual(s.blockedDomains, ['news.example.com']);
  s = { ...s, ...applySiteRule(s, 'news.example.com', 'allow') };
  assert.deepEqual(s.blockedDomains, []);
  assert.deepEqual(s.allowedDomains, ['news.example.com']);
});

test('repeating the current rule clears it', () => {
  let s = { blockedDomains: ['a.com'], allowedDomains: [] };
  s = { ...s, ...applySiteRule(s, 'a.com', 'block') };
  assert.deepEqual(s.blockedDomains, []);
  assert.deepEqual(s.allowedDomains, []);
});

test('applySiteRule normalizes the domain and ignores junk', () => {
  const s = applySiteRule({ blockedDomains: [], allowedDomains: [] }, 'https://WWW.Site.com/x', 'block');
  assert.deepEqual(s.blockedDomains, ['site.com']);
  const j = applySiteRule({ blockedDomains: ['keep.com'], allowedDomains: [] }, '!!!', 'block');
  assert.deepEqual(j.blockedDomains, ['keep.com']);
});

test('hostMatches is a suffix match on label boundaries', () => {
  assert.equal(hostMatches('secure.chase.com', 'chase.com'), true);
  assert.equal(hostMatches('chase.com', 'chase.com'), true);
  assert.equal(hostMatches('notchase.com', 'chase.com'), false);
  assert.equal(hostMatches('chase.com.evil.example', 'chase.com'), false);
});

// --- addresses the panel is willing to link to ---------------------------------

test('an ordinary web address survives, scheme and all', () => {
  assert.equal(httpUrl('https://apnews.com/article/abc'), 'https://apnews.com/article/abc');
  assert.equal(httpUrl('http://example.org/x?y=1'), 'http://example.org/x?y=1');
});

test('anything that is not http or https is refused', () => {
  // A provider that returned one of these would otherwise become a link in a panel
  // whose whole purpose is helping someone judge where a claim came from.
  for (const bad of [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'blob:https://example.com/abc',
    'file:///C:/Users/alice/Desktop',
    'chrome-extension://abc/panel.html',
    'vbscript:msgbox(1)',
  ]) {
    assert.equal(httpUrl(bad), '', bad);
  }
});

test('a bare DOI, an empty value or a missing one is refused rather than made relative', () => {
  // OpenAlex hands back w.doi, which is not always an address. Assigned to an href
  // it would resolve against the panel's own extension origin and go nowhere useful.
  assert.equal(httpUrl('10.1038/s41586-020-2649-2'), '');
  assert.equal(httpUrl(''), '');
  assert.equal(httpUrl(null), '');
  assert.equal(httpUrl(undefined), '');
  assert.equal(httpUrl({}), '');
});

// --- domains a page chose for us -----------------------------------------------
//
// normalizeDomain also cleans the publisher domains a page supplies through its
// canonical link and Open Graph URL. Those reach a search query as -site: terms on
// a request the user pays for, so what a page can put there is what this decides.

test('a domain a page invented is refused unless it could be a hostname', () => {
  assert.equal(normalizeDomain('apnews.com'), 'apnews.com');
  assert.equal(normalizeDomain('https://www.reuters.com/world/'), 'reuters.com');

  // An attempt to write the query rather than name a site.
  assert.equal(normalizeDomain('evil.com -site:apnews.com OR secret'), '');
  assert.equal(normalizeDomain('evil.com"'), '');

  // A hostname is at most 253 characters, and a page can build a longer one.
  assert.equal(normalizeDomain(`${'a'.repeat(300)}.example`), '');
  assert.equal(normalizeDomain(`${'a'.repeat(240)}.example`), `${'a'.repeat(240)}.example`);
});
