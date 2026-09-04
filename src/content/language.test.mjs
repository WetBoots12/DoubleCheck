import test from 'node:test';
import assert from 'node:assert/strict';

import './language.js';
const { detect, primarySubtag, markerShare, languageName, MIN_WORDS } = globalThis.FCLanguage;

// Real prose, long enough to be judged. Short samples are deliberately inconclusive.
const ENGLISH = `The agency said that unemployment fell to 4.2 percent in the last quarter of the year,
which is the lowest it has been since the pandemic began. Officials from the department told reporters
that the figure was driven by hiring in the service sector, and they added that they expect the trend
to continue into the spring, although some economists have said that the numbers may be revised later.`;

const FRENCH = `Le gouvernement a annoncé que le taux de chômage avait diminué de quatre virgule deux
pour cent au cours du dernier trimestre, ce qui représente son niveau le plus bas depuis le début de la
pandémie. Les responsables du ministère ont déclaré aux journalistes que ce chiffre s'explique par les
embauches dans le secteur des services, et ils ont ajouté qu'ils espèrent voir cette tendance continuer.`;

const GERMAN = `Die Regierung teilte mit, dass die Arbeitslosenquote im letzten Quartal auf vier Komma
zwei Prozent gesunken sei, was den niedrigsten Stand seit Beginn der Pandemie darstellt. Beamte des
Ministeriums sagten den Journalisten, dass diese Zahl auf Neueinstellungen im Dienstleistungssektor
zurückzuführen sei, und sie fügten hinzu, dass sie mit einer Fortsetzung dieses Trends rechnen.`;

test('the declared language is believed when it is not English', () => {
  const r = detect('fr', FRENCH);
  assert.equal(r.english, false);
  assert.equal(r.language, 'fr');
  assert.equal(r.why, 'declared');
});

test('regional and oddly-cased tags are understood', () => {
  assert.equal(primarySubtag('en-GB'), 'en');
  assert.equal(primarySubtag('EN_us'), 'en');
  assert.equal(primarySubtag('pt-BR'), 'pt');
  assert.equal(detect('de-AT', GERMAN).english, false);
  assert.equal(detect('en-AU', ENGLISH).english, true);
});

test('a missing, empty or nonsense lang attribute is not treated as a foreign language', () => {
  for (const attr of [undefined, null, '', '   ', 'x-default', '???']) {
    assert.equal(primarySubtag(attr), null, `${attr} should not parse as a language`);
    assert.equal(detect(attr, ENGLISH).english, true);
  }
});

test('English text with no declaration is scanned', () => {
  const r = detect('', ENGLISH);
  assert.equal(r.english, true);
  assert.equal(r.why, 'unknown');
});

test('foreign text with no declaration is caught by the words themselves', () => {
  for (const [label, sample] of [['French', FRENCH], ['German', GERMAN]]) {
    const r = detect('', sample);
    assert.equal(r.english, false, `${label} should not be taken for English`);
    assert.equal(r.why, 'text');
  }
});

test('a template left on the wrong locale does not block a page that is plainly English', () => {
  const r = detect('es', ENGLISH);
  assert.equal(r.english, true);
  assert.equal(r.why, 'text');
});

test('a short sample is never enough to stop scanning', () => {
  // The failure that matters is a wrong "not English", which silently disables the
  // extension. Below the sample floor the answer is always: scan.
  assert.equal(detect('', 'Le chat est noir.').english, true);
  assert.equal(detect('', '').english, true);
  assert.equal(detect('', undefined).english, true);
  const shortFrench = FRENCH.split(/\s+/).slice(0, MIN_WORDS - 5).join(' ');
  assert.equal(detect('', shortFrench).english, true, 'too short to judge');
});

test('a declared foreign language stops scanning even on a short page', () => {
  // The page said so itself, so no sample is needed.
  assert.equal(detect('ja', 'こんにちは').english, false);
});

test('English peppered with quotes and names is still English', () => {
  const mixed = `${ENGLISH} The minister, Ursula von der Leyen, said "Wir schaffen das" during the
  press conference in Berlin, and the phrase was repeated by several outlets across the continent.`;
  assert.equal(detect('en', mixed).english, true);
  assert.equal(detect('', mixed).english, true);
});

test('text that overrules a declaration names no language, since it cannot know one', () => {
  // The words say only "not English". Reporting the declared 'en' here would put
  // "this page looks like it is in English" in the banner as the reason for not
  // reading it, which reads as a bug to the user.
  const r = detect('en', FRENCH);
  assert.equal(r.english, false);
  assert.equal(r.why, 'text');
  assert.equal(r.language, null);
  assert.equal(languageName(r.language), '');

  // A page that declared nothing behaves the same way.
  assert.equal(detect('', GERMAN).language, null);
});

test('markerShare reports the sample size so callers can see why', () => {
  const { share, count } = markerShare(ENGLISH);
  assert.ok(count >= MIN_WORDS, `expected a usable sample, got ${count} words`);
  assert.ok(share > 0.2, `English prose should be dense in function words, got ${share}`);
  assert.ok(markerShare(FRENCH).share < 0.06);
  assert.deepEqual(markerShare(''), { share: 0, count: 0 });
});

test('language names are readable, with a sane fallback', () => {
  assert.equal(languageName('fr'), 'French');
  assert.equal(languageName('zh'), 'Chinese');
  assert.equal(languageName('xx'), 'xx');
  assert.equal(languageName(null), '');
});
