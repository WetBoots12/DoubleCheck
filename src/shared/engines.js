// Search engines, and how each one wants to be asked.
//
// The "Search in browser" button hands a claim to a search engine the user already
// uses. Engines do not read a query the same way, and the differences are large
// enough to change what comes back, so the query is shaped for the engine rather
// than one shape being sent everywhere.
//
// What the differences actually are, checked against the engines' own
// documentation and, where they would answer an automated request, measured:
//
//   Google    Quotation marks mean an exact phrase. Queries are capped at 32 words,
//             which nothing here approaches. (Google Guide; Google Search help.)
//   Bing      Quotation marks mean an exact phrase, terms are implicitly ANDed, and
//             AND / OR / NOT work in capitals with parentheses. Yahoo is Bing.
//             Measured: two quoted phrases still returned a full page of results.
//   DuckDuckGo Supports quotes, +, -, site:, intitle:, inurl:, filetype:, but says
//             plainly in its own help that "advanced syntax isn't operating 100%
//             correctly on all queries". Measured: the same claim with two quoted
//             phrases returned 2 results, and with one returned 5. So: one phrase.
//   Brave     Same operators, and its help calls them "experimental and in the
//             early stage of development". Treated like DuckDuckGo.
//   Perplexity and other answer engines want a question in ordinary words. Their
//             own guidance is to write full, context-rich questions rather than
//             short keyword queries, so a keyword-and-quotes query is the wrong
//             shape entirely.
//
// When the engine is unknown, because the user is on their browser's default and
// has not said which it is, the conservative shape goes out: one quoted phrase,
// which every engine above handles, and plain keywords.
//
// Pure data and string building. No DOM, no network, no chrome.*.

export const QUERY_STYLES = {
  // maxPhrases: how many quoted phrases the engine takes without over-constraining.
  plain: { maxPhrases: 1, question: false },
  phrase: { maxPhrases: 2, question: false },
  lenient: { maxPhrases: 1, question: false },
  question: { maxPhrases: 0, question: true },
};

// url null means "whatever the browser is set to", opened through chrome.search
// rather than by building an address, which is the only way to honour a default
// this extension cannot see.
// Addresses were opened in a real browser rather than copied from memory. Bing,
// DuckDuckGo, Yahoo and Brave returned results for exactly these query strings.
// Startpage answers on /do/search and not on /sp/search, which is why that one is
// written the way it is. Google, Ecosia and Mojeek show anti-automation pages to a
// controlled browser, so their addresses are the documented forms and are unverified
// here; Kagi needs its user to be signed in, which its own users are.
export const SEARCH_ENGINES = [
  { id: 'default', label: "My browser's default search engine", url: null, style: 'plain' },
  { id: 'google', label: 'Google', url: 'https://www.google.com/search?q=', style: 'phrase' },
  { id: 'bing', label: 'Bing', url: 'https://www.bing.com/search?q=', style: 'phrase' },
  { id: 'duckduckgo', label: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=', style: 'lenient' },
  { id: 'brave', label: 'Brave Search', url: 'https://search.brave.com/search?q=', style: 'lenient' },
  { id: 'yahoo', label: 'Yahoo', url: 'https://search.yahoo.com/search?p=', style: 'phrase' },
  { id: 'ecosia', label: 'Ecosia', url: 'https://www.ecosia.org/search?q=', style: 'phrase' },
  { id: 'startpage', label: 'Startpage', url: 'https://www.startpage.com/do/search?query=', style: 'phrase' },
  { id: 'mojeek', label: 'Mojeek', url: 'https://www.mojeek.com/search?q=', style: 'lenient' },
  { id: 'yandex', label: 'Yandex', url: 'https://yandex.com/search/?text=', style: 'phrase' },
  { id: 'kagi', label: 'Kagi', url: 'https://kagi.com/search?q=', style: 'phrase' },
  { id: 'perplexity', label: 'Perplexity', url: 'https://www.perplexity.ai/search/new?q=', style: 'question' },
];

export function getEngine(id) {
  return SEARCH_ENGINES.find((e) => e.id === id) || SEARCH_ENGINES[0];
}

export function engineStyle(id) {
  const style = QUERY_STYLES[getEngine(id).style];
  return style || QUERY_STYLES.plain;
}

// The address to open, or '' when the browser's own default should be used.
export function searchUrl(id, query) {
  const engine = getEngine(id);
  if (!engine.url) return '';
  return engine.url + encodeURIComponent(String(query || ''));
}
