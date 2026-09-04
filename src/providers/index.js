// Pluggable provider layer. Nothing outside this folder talks to a vendor directly.
//
//   SearchProvider: { id, label, search(query, apiKey, { excludeDomain }) -> SearchResult[] }
//   LLMProvider:    { id, label, isAvailable(), crossReference(claim, results, apiKey, opts) -> Analysis }
//   Analysis:       { verdict, confidence, summary, agreement, dispute, perspectives[] }
//   SearchResult:   { title, url, source, snippet? }

export class ProviderError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind; // 'noKey' | 'rateLimited' | 'network' | 'unknown'
  }
}

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

async function fetchJson(url, init) {
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new ProviderError('network', err.message);
  }
  if (res.status === 401 || res.status === 403) throw new ProviderError('noKey', 'Invalid or missing API key');
  if (res.status === 429) throw new ProviderError('rateLimited', 'Rate limited by provider');
  if (!res.ok) throw new ProviderError('unknown', `Provider returned ${res.status}`);
  return res.json();
}

// --- Source exclusion -------------------------------------------------------
// Searching for a sentence verbatim tends to return the very article it came from
// as the top hit, so the panel would cite the page the user is reading as its own
// corroboration. The page's domain is excluded in the query where the engine
// supports it, and always filtered out of the results, which is the part that is
// guaranteed to work.

export function originDomain(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function isSameSite(url, domain) {
  if (!domain) return false;
  const host = originDomain(url);
  return host === domain || host.endsWith(`.${domain}`);
}

export function excludeOrigin(results, domain) {
  return domain ? results.filter((r) => !isSameSite(r.url, domain)) : results;
}

function withExclusion(query, domain) {
  return domain ? `${query} -site:${domain}` : query;
}

// Fetch more than are shown, so excluding the origin still leaves a full set.
const FETCH_COUNT = 10;
const SHOW_COUNT = 5;

// --- Search providers -------------------------------------------------------

const serpapi = {
  id: 'serpapi',
  label: 'SerpAPI (Google results)',
  async search(query, apiKey, opts = {}) {
    if (!apiKey) throw new ProviderError('noKey', 'No search API key configured');
    const q = withExclusion(query, opts.excludeDomain);
    const url = `https://serpapi.com/search.json?engine=google&num=${FETCH_COUNT}&q=${encodeURIComponent(q)}&api_key=${encodeURIComponent(apiKey)}`;
    const data = await fetchJson(url);
    const mapped = (data.organic_results || []).map((r) => ({
      title: r.title,
      url: r.link,
      source: r.source || domainOf(r.link || ''),
      snippet: r.snippet,
    }));
    return excludeOrigin(mapped, opts.excludeDomain).slice(0, SHOW_COUNT);
  },
};

const brave = {
  id: 'brave',
  label: 'Brave Search API',
  // Brave documents site: and minus-term exclusion; -site: is not documented, so it
  // is sent as a best effort and the client-side filter does the real work.
  async search(query, apiKey, opts = {}) {
    if (!apiKey) throw new ProviderError('noKey', 'No search API key configured');
    const q = withExclusion(query, opts.excludeDomain);
    const url = `https://api.search.brave.com/res/v1/web/search?count=${FETCH_COUNT}&q=${encodeURIComponent(q)}`;
    const data = await fetchJson(url, {
      headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
    });
    const mapped = (data.web?.results || []).map((r) => ({
      title: r.title,
      url: r.url,
      source: domainOf(r.url || ''),
      snippet: r.description,
    }));
    return excludeOrigin(mapped, opts.excludeDomain).slice(0, SHOW_COUNT);
  },
};

// --- Fact-check providers ---------------------------------------------------
// Verdicts published by real fact-checking organisations, which outrank anything a
// language model infers from snippets. Shown alongside search results.

// Long sentences rarely match anything in a fact-check index, which is keyed to
// short claim wordings. Falling back to the most distinctive words turns a miss
// into a hit often enough to be worth the second call.
const STOPWORDS = new Set(('a an the and or but if then than that this these those of in on at to for with '
  + "from by as is are was were be been being it its he she they we you i his her their our your not "
  + 'no do does did has have had will would could should may might can said says according also more most '
  + 'about into over under after before during while when where who whom which what how why').split(' '));

export function keywordQuery(sentence, limit = 8) {
  // Keeps decimals and hyphenated words whole, so "4.2" does not split into "4"
  // and "2", and "twenty-year" stays one token.
  const words = (sentence.toLowerCase().match(/[a-z0-9]+(?:[.'-][a-z0-9]+)*/g) || [])
    // A digit earns its place whatever its length: "15" and "4.2" are the most
    // distinctive parts of a factual claim, and a length rule threw them away.
    .filter((w) => (/\d/.test(w) || w.length > 2) && !STOPWORDS.has(w));
  // Numbers and long words carry the most signal in a factual claim.
  const ranked = [...new Set(words)].sort((a, b) => {
    const score = (w) => (/\d/.test(w) ? 100 : 0) + w.length;
    return score(b) - score(a);
  });
  return ranked.slice(0, limit).join(' ');
}

// --- Search query formation -------------------------------------------------
// A long news sentence with a lead-in attribution ("Treasury Secretary Janet Yellen
// told reporters on Tuesday that ...") often returns nothing useful from a web
// search. This strips the attribution and, for long sentences, keeps only the
// distinctive words in their original order, since engines reward proximity.
// Off by default until measured; see tools/query-compare.html.

const ATTRIBUTION_VERBS =
  'said|says|told|announced|reported|stated|claimed|confirmed|noted|added|wrote|argued|warned|insisted|suggested|estimated';

const ATTRIBUTION_PATTERNS = [
  // "According to the report, ..."
  /^according to [^,]{1,80},\s+/i,
  // "Treasury Secretary Janet Yellen told reporters on Tuesday that ..."
  // Backslashes are doubled: inside a template literal a single \s is just "s".
  new RegExp(`^(?:[A-Z][\\w.'-]*\\s+){1,8}(?:${ATTRIBUTION_VERBS})(?:\\s+reporters|\\s+the\\s+\\w+)?(?:\\s+on\\s+\\w+day)?(?:\\s+that)?[,:]?\\s+`),
  // "Officials said that ..." / "The U.S. government said that ..."
  new RegExp(`^(?:[\\w.]+\\s+){1,4}(?:${ATTRIBUTION_VERBS})\\s+that\\s+`, 'i'),
];

// Only strips when what remains is still a substantial clause, so a short quote
// such as "He said no." is never gutted.
export function stripAttribution(sentence) {
  const s = (sentence || '').trim();
  for (const re of ATTRIBUTION_PATTERNS) {
    const stripped = s.replace(re, '');
    if (stripped !== s && stripped.split(/\s+/).length >= 5) return stripped;
  }
  return s;
}

const MAX_VERBATIM_WORDS = 15;
const DISTILLED_BUDGET = 12;

export function searchQuery(sentence) {
  const base = stripAttribution(sentence).replace(/\s+/g, ' ').trim();
  if (!base) return '';
  if (base.split(' ').length <= MAX_VERBATIM_WORDS) return base;

  // Quoted phrases are kept whole and first: they are the most searchable part.
  const quoted = base.match(/"[^"]{3,80}"/g) || [];
  const rest = quoted.reduce((t, q) => t.replace(q, ' '), base);
  const kept = (rest.toLowerCase().match(/[a-z0-9]+(?:[.'-][a-z0-9]+)*/g) || [])
    .filter((w) => (/\d/.test(w) || w.length > 2) && !STOPWORDS.has(w));
  const budget = Math.max(4, DISTILLED_BUDGET - quoted.length * 2);
  return [...quoted, ...kept.slice(0, budget)].join(' ').trim();
}

export function mapClaimReviews(data, limit = 5) {
  const out = [];
  for (const claim of data?.claims || []) {
    for (const review of claim.claimReview || []) {
      out.push({
        claim: claim.text || '',
        claimant: claim.claimant || '',
        publisher: review.publisher?.name || review.publisher?.site || 'Unknown publisher',
        url: review.url || '',
        title: review.title || '',
        rating: review.textualRating || '',
        reviewDate: (review.reviewDate || '').slice(0, 10),
      });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

const noFactCheck = {
  id: 'none',
  label: 'None',
  async lookup() {
    return [];
  },
};

const googleFactCheck = {
  id: 'google',
  label: 'Google Fact Check Tools (free key)',
  async lookup(sentence, apiKey) {
    if (!apiKey) throw new ProviderError('noKey', 'No fact-check API key configured');
    const base = 'https://factchecktools.googleapis.com/v1alpha1/claims:search';
    const call = async (query) => {
      const url = `${base}?query=${encodeURIComponent(query)}&languageCode=en&pageSize=10&key=${encodeURIComponent(apiKey)}`;
      return mapClaimReviews(await fetchJson(url));
    };

    let results = await call(sentence);
    if (!results.length) {
      const keywords = keywordQuery(sentence);
      if (keywords && keywords !== sentence.toLowerCase()) results = await call(keywords);
    }
    return results;
  },
};

export const FACTCHECK_PROVIDERS = { none: noFactCheck, google: googleFactCheck };

export function getFactCheckProvider(id) {
  return FACTCHECK_PROVIDERS[id] || noFactCheck;
}

// --- LLM providers ----------------------------------------------------------

// Undated aliases track the current release of each model; date-suffixed IDs pin
// a snapshot and go stale. Users may override either from the options page.
const ANTHROPIC_DEFAULT_MODEL = 'claude-haiku-4-5';
const OPENAI_DEFAULT_MODEL = 'gpt-4o-mini';

function crossReferencePrompt(claim, results) {
  const sources = results
    .map((r, i) => `[${i + 1}] ${r.source} — ${r.title}\n${r.snippet || ''}`)
    .join('\n\n');
  return `A claim was made in something the user is reading or watching. Using ONLY the search results below, assess it and reply with JSON and nothing else.

Reply in exactly this shape:
{
  "verdict": "supported" | "mixed" | "not_supported" | "unclear",
  "confidence": 0.0 to 1.0,
  "summary": "2-3 sentences on what the sources indicate, citing them as [1], [2]",
  "agreement": "what the sources agree on, or empty string",
  "dispute": "where sources disagree or what they leave unanswered, or empty string",
  "perspectives": [{ "source": "domain name", "lean": "left" | "center" | "right" | "unclear" }]
}

Rules:
- "unclear" is the correct verdict when the sources do not actually address the claim. Never assert a verdict the sources do not support.
- Base "summary", "agreement", and "dispute" only on the search results, never on your own knowledge of the topic.
- "perspectives" is your own rough estimate of each outlet's editorial lean, for showing the spread of coverage. Use "unclear" whenever you are unsure. This is not an authoritative rating.
- Lower "confidence" when sources are few, weak, or off-topic.

CLAIM: ${claim}

SEARCH RESULTS:
${sources}`;
}

const VERDICTS = new Set(['supported', 'mixed', 'not_supported', 'unclear']);

// Models vary in how well they honor "JSON only" — small local models and on-device
// models especially. Recover the object when it is wrapped in prose or a code fence,
// and degrade to a plain summary rather than failing when it cannot be parsed.
export function parseAnalysis(raw) {
  const text = (raw || '').trim();
  const fallback = { verdict: 'unclear', confidence: null, summary: text, agreement: '', dispute: '', perspectives: [] };
  if (!text) return fallback;

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return fallback;

  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return fallback;
  }

  const confidence = Number(parsed.confidence);
  return {
    verdict: VERDICTS.has(parsed.verdict) ? parsed.verdict : 'unclear',
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : null,
    summary: typeof parsed.summary === 'string' ? parsed.summary : text,
    agreement: typeof parsed.agreement === 'string' ? parsed.agreement : '',
    dispute: typeof parsed.dispute === 'string' ? parsed.dispute : '',
    perspectives: Array.isArray(parsed.perspectives)
      ? parsed.perspectives
          .filter((p) => p && typeof p.source === 'string')
          .map((p) => ({
            source: p.source,
            lean: ['left', 'center', 'right'].includes(p.lean) ? p.lean : 'unclear',
          }))
          .slice(0, 8)
      : [],
  };
}

const noLlm = {
  id: 'none',
  label: 'None (search results only)',
  async isAvailable() {
    return true;
  },
  async crossReference() {
    return null;
  },
};

const anthropic = {
  id: 'anthropic',
  label: 'Anthropic API (your key)',
  async isAvailable() {
    return true;
  },
  async crossReference(claim, results, apiKey, opts = {}) {
    if (!apiKey) throw new ProviderError('noKey', 'No LLM API key configured');
    const data = await fetchJson('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: opts.model || ANTHROPIC_DEFAULT_MODEL,
        max_tokens: 700,
        messages: [{ role: 'user', content: crossReferencePrompt(claim, results) }],
      }),
    });
    return parseAnalysis((data.content || []).map((b) => b.text || '').join(''));
  },
};

const openai = {
  id: 'openai',
  label: 'OpenAI-compatible API (your key)',
  async isAvailable() {
    return true;
  },
  async crossReference(claim, results, apiKey, opts = {}) {
    if (!apiKey) throw new ProviderError('noKey', 'No LLM API key configured');
    const data = await fetchJson('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: opts.model || OPENAI_DEFAULT_MODEL,
        max_tokens: 700,
        messages: [{ role: 'user', content: crossReferencePrompt(claim, results) }],
      }),
    });
    return parseAnalysis(data.choices?.[0]?.message?.content || '');
  },
};

// Chrome's on-device Gemini Nano via the Prompt API (Chrome 138+). The global is
// `LanguageModel`; availability() reports unavailable / downloadable / downloading /
// available. It needs a document context, so `runsInPage` tells the background worker
// to hand this off to the side panel rather than calling it itself.
const builtin = {
  id: 'builtin',
  label: "Chrome built-in AI — Gemini Nano (no key needed)",
  runsInPage: true,
  async isAvailable() {
    try {
      if (typeof LanguageModel === 'undefined') return false;
      const a = await LanguageModel.availability();
      return Boolean(a) && a !== 'unavailable';
    } catch {
      return false;
    }
  },
  async crossReference(claim, results) {
    if (typeof LanguageModel === 'undefined') {
      throw new ProviderError('unknown', 'This browser has no built-in AI model');
    }
    let session;
    try {
      // A 'downloadable' model downloads on first create(); this can take a while.
      session = await LanguageModel.create();
      const out = await session.prompt(crossReferencePrompt(claim, results));
      return parseAnalysis(out);
    } catch (err) {
      throw new ProviderError('unknown', err.message);
    } finally {
      session?.destroy?.();
    }
  },
};

// Any OpenAI-compatible endpoint running on the user's own machine (Ollama, LM Studio,
// llama.cpp). Needs no key, and gives Brave and other browsers without an on-device
// model the same no-key experience. Brave's own Leo assistant has no extension API.
const local = {
  id: 'local',
  label: 'Local model — Ollama / LM Studio (no key needed)',
  async isAvailable() {
    return true;
  },
  async crossReference(claim, results, _apiKey, opts = {}) {
    const base = (opts.url || 'http://localhost:11434/v1').replace(/\/+$/, '');
    const data = await fetchJson(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: opts.model || 'llama3.1',
        max_tokens: 700,
        messages: [{ role: 'user', content: crossReferencePrompt(claim, results) }],
      }),
    });
    return parseAnalysis(data.choices?.[0]?.message?.content || '');
  },
};

export const SEARCH_PROVIDERS = { serpapi, brave };
export const LLM_PROVIDERS = { none: noLlm, builtin, local, anthropic, openai };

export function getSearchProvider(id) {
  return SEARCH_PROVIDERS[id] || serpapi;
}

export function getLlmProvider(id) {
  return LLM_PROVIDERS[id] || noLlm;
}
