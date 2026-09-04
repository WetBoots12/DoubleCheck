// Pluggable provider layer. Nothing outside this folder talks to a vendor directly.
//
//   SearchProvider: { id, label, search(query, apiKey) -> SearchResult[] }
//   LLMProvider:    { id, label, isAvailable(), crossReference(claim, results, apiKey) -> string }
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

// --- Search providers -------------------------------------------------------

const serpapi = {
  id: 'serpapi',
  label: 'SerpAPI (Google results)',
  async search(query, apiKey) {
    if (!apiKey) throw new ProviderError('noKey', 'No search API key configured');
    const url = `https://serpapi.com/search.json?engine=google&num=5&q=${encodeURIComponent(query)}&api_key=${encodeURIComponent(apiKey)}`;
    const data = await fetchJson(url);
    return (data.organic_results || []).slice(0, 5).map((r) => ({
      title: r.title,
      url: r.link,
      source: r.source || domainOf(r.link || ''),
      snippet: r.snippet,
    }));
  },
};

const brave = {
  id: 'brave',
  label: 'Brave Search API',
  async search(query, apiKey) {
    if (!apiKey) throw new ProviderError('noKey', 'No search API key configured');
    const url = `https://api.search.brave.com/res/v1/web/search?count=5&q=${encodeURIComponent(query)}`;
    const data = await fetchJson(url, {
      headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
    });
    return (data.web?.results || []).slice(0, 5).map((r) => ({
      title: r.title,
      url: r.url,
      source: domainOf(r.url || ''),
      snippet: r.description,
    }));
  },
};

// --- LLM providers ----------------------------------------------------------

function crossReferencePrompt(claim, results) {
  const sources = results
    .map((r, i) => `[${i + 1}] ${r.source} — ${r.title}\n${r.snippet || ''}`)
    .join('\n\n');
  return `A claim was made in something the user is reading or watching. Using only the search results below, say in 2-4 sentences what the sources indicate about it. If the sources do not address the claim, say so plainly. Do not assert a verdict the sources do not support. Cite sources as [1], [2].

CLAIM: ${claim}

SEARCH RESULTS:
${sources}`;
}

const noLlm = {
  id: 'none',
  label: 'None (search results only)',
  async isAvailable() {
    return true;
  },
  async crossReference() {
    return '';
  },
};

const anthropic = {
  id: 'anthropic',
  label: 'Anthropic API (your key)',
  async isAvailable() {
    return true;
  },
  async crossReference(claim, results, apiKey) {
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
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{ role: 'user', content: crossReferencePrompt(claim, results) }],
      }),
    });
    return (data.content || []).map((b) => b.text || '').join('').trim();
  },
};

const openai = {
  id: 'openai',
  label: 'OpenAI-compatible API (your key)',
  async isAvailable() {
    return true;
  },
  async crossReference(claim, results, apiKey) {
    if (!apiKey) throw new ProviderError('noKey', 'No LLM API key configured');
    const data = await fetchJson('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 300,
        messages: [{ role: 'user', content: crossReferencePrompt(claim, results) }],
      }),
    });
    return data.choices?.[0]?.message?.content?.trim() || '';
  },
};

// Chrome's on-device Prompt API. Surface has moved around (window.ai -> LanguageModel);
// feature-detect both and hide the option entirely when neither is present.
const builtin = {
  id: 'builtin',
  label: "This browser's built-in AI (no key needed)",
  async isAvailable() {
    try {
      if (typeof LanguageModel !== 'undefined') {
        const a = await LanguageModel.availability();
        return a && a !== 'unavailable';
      }
      return typeof self.ai?.languageModel !== 'undefined';
    } catch {
      return false;
    }
  },
  async crossReference(claim, results) {
    try {
      const session =
        typeof LanguageModel !== 'undefined'
          ? await LanguageModel.create()
          : await self.ai.languageModel.create();
      const out = await session.prompt(crossReferencePrompt(claim, results));
      session.destroy?.();
      return (out || '').trim();
    } catch (err) {
      throw new ProviderError('unknown', err.message);
    }
  },
};

export const SEARCH_PROVIDERS = { serpapi, brave };
export const LLM_PROVIDERS = { none: noLlm, builtin, anthropic, openai };

export function getSearchProvider(id) {
  return SEARCH_PROVIDERS[id] || serpapi;
}

export function getLlmProvider(id) {
  return LLM_PROVIDERS[id] || noLlm;
}
