import test from 'node:test';
import assert from 'node:assert/strict';

import { citeTemplate, refToSource, passages, refsForClaim } from './wikirefs.js';

// Wikitext in the shapes real articles use, taken from how the Inflation and Great
// Barrier Reef articles are actually written.
const ARTICLE = `
The Great Barrier Reef is the world's largest coral reef system.<ref>{{cite web |url=https://www.gbrmpa.gov.au/ |title=About the Reef |website=Great Barrier Reef Marine Park Authority |date=2020}}</ref>

Coral cover has fallen sharply. A study found the reef had lost half of its corals since 1995 as sea temperatures rose.<ref>{{cite news |last=Smith |first=Jane |title=Great Barrier Reef has lost half of its corals since 1995 |url=https://www.bbc.com/news/world-australia-54533971 |work=[[BBC News]] |date=14 October 2020}}</ref><ref name="wapo">{{cite news |title=Reef has lost half its corals |url=https://www.washingtonpost.com/x |newspaper=The Washington Post |date=2020-10-14}}</ref>

Tourism contributes billions to the regional economy each year.<ref>{{cite journal |last1=Roe |first1=John |last2=Poe |first2=Ann |title=Valuing reef tourism |journal=Marine Policy |doi=10.1016/j.marpol.2019.01.001 |year=2019}}</ref>

An older section, written before templates were common.<ref>[https://www.aims.gov.au/report Long-term monitoring report]</ref>

A reference with nothing usable in it at all.<ref name="bare" />
`;

// --- reading a citation template ------------------------------------------------------

test('a cite template is read into its parameters', () => {
  const params = citeTemplate('{{cite news |last=Smith |first=Jane |title=A headline |url=https://x.example |date=2020}}');
  assert.equal(params.kind, 'news');
  assert.equal(params.title, 'A headline');
  assert.equal(params.url, 'https://x.example');
  assert.equal(params.last, 'Smith');
});

test('a wiki link inside a parameter becomes its plain text', () => {
  const params = citeTemplate('{{cite web |work=[[Office for National Statistics|the ONS]] |publisher=[[BBC]]}}');
  assert.equal(params.work, 'the ONS');
  assert.equal(params.publisher, 'BBC');
});

test('a pipe inside a nested link does not split the parameters', () => {
  // The whole reason for walking the string rather than splitting on every pipe.
  const params = citeTemplate('{{cite web |title=A [[Page|with a pipe]] in it |url=https://x.example}}');
  assert.equal(params.title, 'A with a pipe in it');
  assert.equal(params.url, 'https://x.example');
});

test('something that is not a template is not read as one', () => {
  assert.equal(citeTemplate('just some prose'), null);
  assert.equal(citeTemplate('{{cite web |title=unclosed'), null);
});

// --- turning a reference into a source ---------------------------------------------------

test('a news reference carries its title, address, publisher, author and date', () => {
  const s = refToSource('{{cite news |last=Smith |first=Jane |title=A headline |url=https://x.example |work=BBC News |date=14 October 2020}}');
  assert.equal(s.title, 'A headline');
  assert.equal(s.url, 'https://x.example');
  assert.equal(s.siteName, 'BBC News');
  assert.deepEqual(s.authors, ['Jane Smith']);
  assert.equal(s.date, '14 October 2020');
  assert.equal(s.kind, 'web');
});

test('a journal reference is a journal article, and its DOI becomes its address', () => {
  const s = refToSource('{{cite journal |last1=Roe |first1=John |last2=Poe |first2=Ann |title=Valuing reef tourism |journal=Marine Policy |doi=10.1016/j.marpol.2019.01.001 |year=2019}}');
  assert.equal(s.kind, 'article');
  assert.equal(s.venue, 'Marine Policy');
  assert.deepEqual(s.authors, ['John Roe', 'Ann Poe']);
  assert.equal(s.url, 'https://doi.org/10.1016/j.marpol.2019.01.001');
  assert.equal(s.date, '2019');
});

test('several authors are read however the template chose to say it', () => {
  assert.deepEqual(refToSource('{{cite web |author=Jane Doe |title=T |url=https://x.example}}').authors, ['Jane Doe']);
  assert.deepEqual(refToSource('{{cite web |author1=A One |author2=B Two |title=T |url=https://x.example}}').authors, ['A One', 'B Two']);
});

test('a bare external link, which is how older references were written', () => {
  const s = refToSource('[https://www.aims.gov.au/report Long-term monitoring report]');
  assert.equal(s.url, 'https://www.aims.gov.au/report');
  assert.equal(s.title, 'Long-term monitoring report');
});

test('a reference with nothing usable yields nothing rather than an empty entry', () => {
  assert.equal(refToSource('<ref name="bare" />'), null);
  assert.equal(refToSource('{{Harvnb|Romer|2019}}'), null);
  assert.equal(refToSource(''), null);
});

// --- finding the passage, and its references -----------------------------------------------

test('only passages that carry references are considered', () => {
  const found = passages(ARTICLE);
  assert.ok(found.length >= 4, `found ${found.length}`);
  assert.ok(found.every((p) => p.refs.length > 0));
  assert.ok(found.every((p) => !p.text.includes('<ref')), 'the reference markup is not part of the text');
});

test('the sources returned are the ones cited for the claim, not for the topic', () => {
  const refs = refsForClaim(
    'The Great Barrier Reef has lost half its coral cover since 1995.',
    ARTICLE,
    { limit: 3, article: 'Great Barrier Reef' },
  );

  assert.ok(refs.length >= 2);
  const urls = refs.map((r) => r.url);
  assert.ok(urls.includes('https://www.bbc.com/news/world-australia-54533971'), JSON.stringify(urls));
  assert.ok(urls.includes('https://www.washingtonpost.com/x'), JSON.stringify(urls));
});

test('a claim about something else in the article gets that section instead', () => {
  const refs = refsForClaim('Reef tourism is worth billions to the regional economy.', ARTICLE, { limit: 2 });
  assert.equal(refs[0].url, 'https://doi.org/10.1016/j.marpol.2019.01.001', JSON.stringify(refs.map((r) => r.url)));
});

test('every source says where it came from and what it was cited for', () => {
  const [first] = refsForClaim('coral cover lost half since 1995', ARTICLE, { limit: 1, article: 'Great Barrier Reef' });
  assert.match(first.snippet, /^Cited by Wikipedia's article on Great Barrier Reef, for: /);
  assert.equal(first.fromWikipedia, true);
});

test('the same source cited twice appears once', () => {
  const twice = `${ARTICLE}\n\nAnd again, elsewhere.<ref>{{cite news |title=Great Barrier Reef has lost half of its corals since 1995 |url=https://www.bbc.com/news/world-australia-54533971 |work=BBC News}}</ref>`;
  const refs = refsForClaim('coral cover lost half since 1995', twice, { limit: 8 });
  const bbc = refs.filter((r) => r.url.includes('bbc.com'));
  assert.equal(bbc.length, 1);
});

test('an article with no references yields nothing rather than throwing', () => {
  assert.deepEqual(refsForClaim('anything', 'Plain prose with no citations at all.', {}), []);
  assert.deepEqual(refsForClaim('anything', '', {}), []);
  assert.deepEqual(refsForClaim('', ARTICLE, {}), []);
  assert.deepEqual(refsForClaim('anything', null, {}), []);
});

// --- cost -------------------------------------------------------------------------------

test('a hostile article cannot make this expensive', () => {
  // This runs on text fetched from the web, on the thread the whole extension shares.
  for (const shape of ['<ref>', '{{cite web ', '[[', '<ref>{{cite web |title=']) {
    const nasty = shape.repeat(40000);
    const started = Date.now();
    refsForClaim('inflation figures', nasty, { limit: 5 });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1500, `${shape.trim()} took ${elapsed}ms`);
  }
});

test('a very long article is read in a reasonable time', () => {
  const long = ARTICLE.repeat(400);
  const started = Date.now();
  const refs = refsForClaim('coral cover lost half since 1995', long, { limit: 5 });
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started}ms`);
  assert.ok(refs.length > 0);
});

// --- across the claims on one page ---------------------------------------------------
// Two flags on one page about one conflict both find the same article, and the article
// offers the same few references for both, so the panel showed the same sources twice.
// A source already under another flag gives way to the next one that bears on the
// claim, and is only shown again when nothing else does.

test('a source already shown under another claim gives way to the next one that fits', () => {
  const claim = 'The Great Barrier Reef has lost half its coral cover since 1995.';
  const first = refsForClaim(claim, ARTICLE, { limit: 1 });
  assert.equal(first.length, 1);
  const second = refsForClaim(claim, ARTICLE, { limit: 1, avoid: [first[0].url] });
  assert.equal(second.length, 1);
  assert.notEqual(second[0].url, first[0].url, JSON.stringify(second));
  assert.ok(/bbc\.com|washingtonpost\.com/.test(second[0].url), 'still one the article cites for this claim');
});

test('when nothing else bears on the claim, the shown source is shown again rather than nothing', () => {
  const claim = 'Reef tourism is worth billions to the regional economy.';
  const [only] = refsForClaim(claim, ARTICLE, { limit: 1 });
  const again = refsForClaim(claim, ARTICLE, { limit: 1, avoid: [only.url] });
  assert.ok(again.length >= 1);
});
