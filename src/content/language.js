// Is this page in English?
//
// The classifier's vocabulary is English: 20,000 terms learned from English
// sentences. Handed French or German text it does not fail loudly, it scores
// erratically, and erratic scores mean claims flagged for no reason on a page the
// tool cannot help with. Better to say so and stay out of the way.
//
// Two signals, in order:
//
//   the declared language  <html lang="fr"> is the page telling us plainly. Sites
//                          that bother to set it are usually right about it.
//   the text itself        a page with no lang attribute, or one left at "en" by a
//                          template while the article is in Spanish, is judged on
//                          the share of common English function words. Those words
//                          are short, frequent and near-impossible to avoid in real
//                          English prose, and rare in other languages.
//
// The bias throughout is towards scanning: a wrong "not English" silently disables
// the extension on a page it could have helped with, which is the worse error. So
// the text check only overrides a missing or English declaration when the sample is
// long enough to mean something and the verdict is not close.
//
// Classic script, no imports, installing FCLanguage the way segment.js installs
// FCSegment, because content scripts cannot use modules.

(function () {
  // Function words: articles, pronouns, prepositions, auxiliaries. Deliberately not
  // topic words, so the test does not depend on what the page is about.
  const ENGLISH_MARKERS = new Set(('the of and to in a is that for it was on with as be by at this from '
    + 'or an are but not have has had they he she we you his her their its will would there been '
    + 'which who what when where how all more can said about than into over after also do does did '
    + 'says if then them these those our your out up no so some other new one two')
    .split(' '));

  const MIN_WORDS = 40;      // below this a sample proves nothing
  const CLEAR_ENGLISH = 0.16; // typical English prose runs far above this
  const CLEAR_OTHER = 0.06;   // below this, English is not what we are reading

  function words(text) {
    return (String(text || '').toLowerCase().match(/[\p{L}']+/gu) || []);
  }

  // Share of the sample made of English function words.
  function markerShare(text) {
    const w = words(text);
    if (!w.length) return { share: 0, count: 0 };
    let hits = 0;
    for (const t of w) if (ENGLISH_MARKERS.has(t)) hits++;
    return { share: hits / w.length, count: w.length };
  }

  // "en", "en-GB", "EN_us" -> "en". Anything unparseable -> null.
  function primarySubtag(lang) {
    const tag = String(lang || '').trim().toLowerCase().replace('_', '-');
    if (!tag) return null;
    const first = tag.split('-')[0];
    return /^[a-z]{2,3}$/.test(first) ? first : null;
  }

  // Returns { english, language, why }:
  //   why 'declared'  the page said so, either way
  //   why 'text'      the words decided it
  //   why 'unknown'   nothing conclusive, so we scan, which is the safe default
  function detect(langAttr, sampleText) {
    const declared = primarySubtag(langAttr);
    const { share, count } = markerShare(sampleText);

    // A page declaring a language other than English is taken at its word, unless
    // the text is emphatically English anyway (a template left on the wrong locale).
    if (declared && declared !== 'en') {
      if (count >= MIN_WORDS && share >= CLEAR_ENGLISH) {
        return { english: true, language: 'en', why: 'text' };
      }
      return { english: false, language: declared, why: 'declared' };
    }

    // Declared English, or nothing declared. Only a long and clearly un-English
    // sample overrides that, so the failure mode stays "scan anyway".
    //
    // The language is reported as null even when the page declared English: the
    // text is what overruled the declaration, and the words say only "not English",
    // never which language it is. Naming it 'en' here would put "this page looks
    // like it is in English" in the banner as the reason for not reading it.
    if (count >= MIN_WORDS && share <= CLEAR_OTHER) {
      return { english: false, language: null, why: 'text' };
    }

    return { english: true, language: declared || null, why: declared ? 'declared' : 'unknown' };
  }

  // For the banner: "French" reads better than "fr". Only the languages a user is
  // likely to meet; anything else falls back to the code, and then to a plain phrase.
  const NAMES = {
    ar: 'Arabic', bn: 'Bengali', cs: 'Czech', da: 'Danish', de: 'German', el: 'Greek',
    es: 'Spanish', fa: 'Persian', fi: 'Finnish', fr: 'French', he: 'Hebrew', hi: 'Hindi',
    hu: 'Hungarian', id: 'Indonesian', it: 'Italian', ja: 'Japanese', ko: 'Korean',
    nl: 'Dutch', no: 'Norwegian', pl: 'Polish', pt: 'Portuguese', ro: 'Romanian',
    ru: 'Russian', sv: 'Swedish', th: 'Thai', tr: 'Turkish', uk: 'Ukrainian',
    vi: 'Vietnamese', zh: 'Chinese',
  };

  function languageName(code) {
    if (!code) return '';
    return NAMES[code] || code;
  }

  const api = { detect, primarySubtag, markerShare, languageName, MIN_WORDS };
  if (typeof globalThis !== 'undefined') globalThis.FCLanguage = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
