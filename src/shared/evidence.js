// Evidence scoring: what the thermometer is actually based on.
//
// The model's self-reported "confidence" is gone. Language models are poorly
// calibrated at rating themselves, and a percentage lent that number an authority
// it had not earned. In its place, a score built from things that can be measured
// or at least inspected:
//
//   relevance   lexical overlap between the claim and each source, computed here;
//   verbiage    hedging, opinion and sensational language in each source, computed here;
//   source tier a short, visible, user-editable classification of the outlet;
//   stance      per source, supports / contradicts / unrelated, judged by the AI when
//               it ran, which is a far more grounded task than one global number;
//   fact-checks a published verdict, when one exists, which outranks everything.
//
// Everything that goes into the number is also returned as plain-language lines
// for the panel, so the reading is explainable rather than opaque. Pure: no DOM,
// no network, no chrome.*.

import { temporalFit, isMismatch } from './dates.js';
import { compareQuantities } from './numbers.js';

const STOPWORDS = new Set(('a an the and or but if then than that this these those of in on at to for with '
  + 'from by as is are was were be been being it its he she they we you i his her their our your not '
  + 'no do does did has have had will would could should may might can said says according also more most '
  + 'about into over under after before during while when where who whom which what how why').split(' '));

export function tokens(text) {
  return (String(text || '').toLowerCase().match(/[a-z0-9]+(?:[.'-][a-z0-9]+)*/g) || [])
    .filter((w) => (/\d/.test(w) || w.length > 2) && !STOPWORDS.has(w));
}

// Share of the claim's distinctive words that appear in the source text, with
// numbers counting double because they are what a factual claim turns on.
export function relevance(claim, text) {
  const want = [...new Set(tokens(claim))];
  if (!want.length) return 0;
  const have = new Set(tokens(text));
  let total = 0;
  let hit = 0;
  for (const w of want) {
    const weight = /\d/.test(w) ? 2 : 1;
    total += weight;
    if (have.has(w)) hit += weight;
  }
  return total ? hit / total : 0;
}

const HEDGES = /\b(allegedly|reportedly|purportedly|supposedly|rumou?red|unconfirmed|unverified|may have|might have|could have|possibly|appears to|seems to|suggests|sources say|according to sources)\b/i;
const OPINION = /\b(i think|i believe|in my opinion|we believe|op-ed|opinion|editorial|commentary|column)\b/i;
const SENSATIONAL = /\b(shocking|unbelievable|bombshell|slams|destroys|outrageous|insane|epic|you won't believe|mind-blowing|exposed)\b/i;

// Flags describing how a source talks, plus a penalty 0..1 for the weight.
export function verbiage(text) {
  const t = String(text || '');
  const hedged = HEDGES.test(t);
  const opinion = OPINION.test(t);
  const shouting = (t.match(/\b[A-Z]{4,}\b/g) || []).length >= 2 || (t.match(/!/g) || []).length >= 2;
  const sensational = SENSATIONAL.test(t) || shouting;
  const penalty = Math.min(1, (hedged ? 0.35 : 0) + (opinion ? 0.35 : 0) + (sensational ? 0.4 : 0));
  return { hedged, opinion, sensational, penalty };
}

// --- source tiers -------------------------------------------------------------
// Deliberately short and visible. Not a media-ratings service and not affiliated
// with one; the user can override any domain from the options page.

export const TIER_DOMAINS = {
  wire: ['reuters.com', 'apnews.com', 'afp.com', 'bloomberg.com', 'upi.com', 'pa.media'],
  public: ['bbc.com', 'bbc.co.uk', 'npr.org', 'pbs.org', 'cbc.ca', 'abc.net.au', 'dw.com', 'france24.com', 'rte.ie', 'nhk.or.jp'],
  gov: ['who.int', 'un.org', 'oecd.org', 'imf.org', 'worldbank.org', 'europa.eu', 'ec.europa.eu'],
  factcheck: ['snopes.com', 'politifact.com', 'fullfact.org', 'factcheck.org', 'factcheck.afp.com', 'leadstories.com', 'checkyourfact.com', 'truthorfiction.com'],
  major: ['nytimes.com', 'wsj.com', 'washingtonpost.com', 'theguardian.com', 'ft.com', 'economist.com', 'latimes.com', 'theatlantic.com', 'newyorker.com', 'time.com', 'cnn.com', 'nbcnews.com', 'cbsnews.com', 'abcnews.go.com', 'foxnews.com', 'usatoday.com', 'politico.com', 'axios.com', 'thehill.com', 'telegraph.co.uk', 'independent.co.uk', 'aljazeera.com', 'lemonde.fr', 'spiegel.de'],
  encyclopedia: ['wikipedia.org', 'britannica.com'],
  weak: ['blogspot.com', 'wordpress.com', 'medium.com', 'substack.com', 'facebook.com', 'twitter.com', 'x.com', 'tiktok.com', 'reddit.com', 'quora.com', 'youtube.com', 'pinterest.com', 'tumblr.com', 'rumble.com', 'bitchute.com', 'infowars.com', 'naturalnews.com', 'beforeitsnews.com'],
};

export const TIER_WEIGHT = {
  trusted: 1.0, academic: 1.0, factcheck: 1.0, wire: 1.0,
  gov: 0.95, public: 0.95, major: 0.85, encyclopedia: 0.6, unknown: 0.5, weak: 0.25, distrusted: 0.25,
};

export const TIER_LABEL = {
  trusted: 'trusted (your list)', distrusted: 'weak (your list)', academic: 'academic', factcheck: 'fact-checker',
  wire: 'wire service', gov: 'government or intergovernmental', public: 'public broadcaster',
  major: 'major outlet', encyclopedia: 'encyclopedia', unknown: 'unrated source', weak: 'weak source',
};

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function matches(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

// tiers: { trusted: string[], distrusted: string[] } from the user's settings.
export function sourceTier(source, tiers = {}) {
  const host = hostOf(source?.url);
  if (!host) return 'unknown';
  if ((tiers.distrusted || []).some((d) => matches(host, d))) return 'distrusted';
  if ((tiers.trusted || []).some((d) => matches(host, d))) return 'trusted';
  if (source.academic) return 'academic';
  for (const [tier, domains] of Object.entries(TIER_DOMAINS)) {
    if (domains.some((d) => matches(host, d))) return tier;
  }
  if (/\.gov(\.[a-z]{2})?$/.test(host) || /\.gc\.ca$/.test(host)) return 'gov';
  return 'unknown';
}

// A published rating's own words, mapped to a tone. Negations and mixed first, so
// "not true" is not true and "Half True" is mixed. Shared with the panel.
export function ratingTone(rating) {
  const r = String(rating || '').toLowerCase();
  if (/\b(false|untrue|not true|fake|incorrect|inaccurate|wrong|pants on fire|debunked|no evidence|misleading)\b/.test(r)) return 'false';
  if (/\b(mixture|mixed|partly|half|unproven|outdated|context)\b/.test(r)) return 'mixed';
  if (/\b(true|correct|accurate|confirmed)\b/.test(r)) return 'true';
  return 'unknown';
}

const RELEVANT = 0.15;
const POSITION = { not_supported: 8, mixed: 50, supported: 92 };

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// A source out of step with the claim's period still counts, but for less. It is
// not wrong, it is answering about a different time, and the panel says so.
const TEMPORAL_PENALTY = 0.5;

// sources: [{ url, title, snippet, excerpt?, date?, academic? }]; stances: { [index]: 'supports' | 'contradicts' | 'unrelated' }
// (index is 1-based, as the prompt numbers them); factChecks: [{ publisher, rating }];
// tiers: { trusted, distrusted }.
export function scoreEvidence(claim, sources = [], { stances = null, factChecks = [], tiers = {}, now = null } = {}) {
  const rows = sources.map((s, i) => {
    // The excerpt read from the page when there is one, the search snippet when
    // there is not. A snippet is 150 characters and often cuts off the very number
    // the claim turns on, which used to read as "this source says nothing".
    const text = `${s.title || ''} ${s.excerpt || s.snippet || ''}`;
    const rel = relevance(claim, text);
    const tier = sourceTier(s, tiers);
    const v = verbiage(text);
    const stance = stances ? (stances[i + 1] || stances[String(i + 1)] || null) : null;
    // "Crime is at an all-time low" was true of some year, and a search will
    // happily return the year it was true of. A page cannot report on a year it
    // predates, and a page from long ago is weak evidence about the present.
    // Overlap only ever notices agreement: "inflation" and "percent" matching
    // makes a source look relevant even when its figure flatly contradicts the
    // claim's. That is the case worth pointing out, so the figures are compared.
    const figures = compareQuantities(claim, text);

    const time = temporalFit(claim, s.date, now ? { now } : {});
    const timePenalty = isMismatch(time.status) ? TEMPORAL_PENALTY : 1;
    const weight = TIER_WEIGHT[tier] * (1 - 0.5 * v.penalty) * rel * timePenalty;
    return {
      index: i + 1,
      url: s.url,
      tier,
      relevance: rel,
      verbiage: v,
      stance,
      time,
      figures,
      weight,
      relevant: rel >= RELEVANT,
    };
  });

  const relevant = rows.filter((r) => r.relevant);
  const lines = [];

  if (!sources.length) {
    return { quality: 0, position: null, verdict: 'unclear', support: null, rows, lines: ['No sources were found.'] };
  }
  lines.push(`${relevant.length} of ${plural(sources.length, 'source')} address the claim`);

  // Credibility: relevance-weighted mean of tier weights over relevant sources.
  const relSum = relevant.reduce((a, r) => a + r.relevance, 0);
  const credibility = relSum ? relevant.reduce((a, r) => a + TIER_WEIGHT[r.tier] * r.relevance, 0) / relSum : 0;
  const tierCounts = {};
  for (const r of relevant) tierCounts[r.tier] = (tierCounts[r.tier] || 0) + 1;
  if (relevant.length) {
    lines.push('sources: ' + Object.entries(tierCounts).map(([t, n]) => `${n} ${TIER_LABEL[t]}`).join(', '));
  }

  const conflicting = relevant.filter((r) => r.figures.status === 'conflicts');
  if (conflicting.length) {
    // Stated as a disagreement between two texts, never as a verdict: the source
    // may be about another month or another country, or may itself be wrong.
    lines.push(`${plural(conflicting.length, 'source')} give a different figure: ${conflicting[0].figures.note}`);
  }

  const dated = relevant.filter((r) => isMismatch(r.time.status));
  if (dated.length) {
    lines.push(`${plural(dated.length, 'source')} out of step with the claim's date: ${dated[0].time.note}`);
  }

  const hedged = relevant.filter((r) => r.verbiage.hedged).length;
  const opinion = relevant.filter((r) => r.verbiage.opinion).length;
  const sensational = relevant.filter((r) => r.verbiage.sensational).length;
  const language = [];
  if (hedged) language.push(`${hedged} hedged`);
  if (opinion) language.push(`${opinion} opinion`);
  if (sensational) language.push(`${sensational} sensational`);
  if (language.length) lines.push('language: ' + language.join(', '));
  const cleanFraction = relevant.length ? 1 - (hedged + opinion + sensational) / (3 * relevant.length) : 1;

  const coverage = Math.min(relevant.length, 3) / 3;
  const quality = Math.round(100 * coverage * (0.6 * credibility + 0.4 * cleanFraction)) / 100;

  // Stance, when the AI judged each source.
  let support = null;
  let verdict = 'unclear';
  const judged = relevant.filter((r) => r.stance === 'supports' || r.stance === 'contradicts');
  if (judged.length) {
    const total = judged.reduce((a, r) => a + r.weight, 0);
    const forIt = judged.filter((r) => r.stance === 'supports').reduce((a, r) => a + r.weight, 0);
    const against = judged.filter((r) => r.stance === 'contradicts').reduce((a, r) => a + r.weight, 0);
    support = total ? (forIt - against) / total : 0;
    const nFor = judged.filter((r) => r.stance === 'supports').length;
    const nAgainst = judged.length - nFor;
    lines.push(`${nFor} support, ${nAgainst} contradict`);
    verdict = support > 0.4 ? 'supported' : support < -0.4 ? 'not_supported' : 'mixed';
  } else if (stances) {
    lines.push('no source takes a clear position');
  }

  // A published fact-check outranks everything above.
  const toned = (factChecks || []).map((f) => ({ ...f, tone: ratingTone(f.rating) })).filter((f) => f.tone !== 'unknown');
  if (toned.length) {
    const f = toned[0];
    verdict = f.tone === 'true' ? 'supported' : f.tone === 'false' ? 'not_supported' : 'mixed';
    lines.unshift(`published fact-check: ${f.rating} (${f.publisher})`);
  }

  const position = toned.length || judged.length
    ? Math.round(support != null && !toned.length ? 50 + 42 * support : POSITION[verdict])
    : null;

  return { quality, position, verdict, support, rows, lines };
}
