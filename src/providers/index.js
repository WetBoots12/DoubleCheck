// Pluggable provider layer. Nothing outside this folder talks to a vendor directly.
//
//   SearchProvider: { id, label, search(query, apiKey) -> SearchResult[] }
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
  async crossReference(claim, results, apiKey) {
    if (!apiKey) throw new ProviderError('noKey', 'No LLM API key configured');
    const data = await fetchJson('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
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
