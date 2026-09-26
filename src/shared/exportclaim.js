// Turning a claim and what was found about it into text a person can paste.
//
// The panel is where a check happens and nowhere is where it goes. What a reader
// actually does with a fact-check is put it somewhere else: into a reply, a message,
// a document, a note to themselves. Without a way out, everything found here is
// retyped by hand or lost when the tab closes.
//
// Markdown, because it pastes usefully into the places people paste: as formatted
// text where markdown is understood, and as readable plain text where it is not.
//
// The wording is careful for the same reason the panel's is. This is a record of
// what sources said, not a verdict on whether the claim is true, and text that
// leaves the extension is exactly the text most likely to be quoted back without
// the surrounding context that would have made that clear.

import { httpUrl } from './privacy.js';

const VERDICT_WORDS = {
  supported: 'Sources support this claim',
  not_supported: 'Sources do not support this claim',
  mixed: 'Sources disagree',
  unclear: 'No clear position from the sources',
};

function clean(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

// A link, or the plain title when the address is not one we would link to.
function link(title, url) {
  const safe = httpUrl(url);
  const label = clean(title) || safe || 'untitled';
  return safe ? `[${label}](${safe})` : label;
}

export function claimToMarkdown(claim, opts = {}) {
  const c = claim || {};
  const lines = [];

  lines.push(`> ${clean(c.text) || '(no text)'}`);
  lines.push('');

  const where = clean(opts.pageTitle) || clean(opts.pageUrl);
  if (where) lines.push(`Found on ${opts.pageUrl ? link(where, opts.pageUrl) : where}`);
  if (c.ts != null && Number.isFinite(Number(c.ts))) {
    const t = Math.max(0, Math.floor(Number(c.ts)));
    lines.push(`At ${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')} in the video`);
  }
  if (where || c.ts != null) lines.push('');

  const factChecks = Array.isArray(c.factChecks) ? c.factChecks : [];
  if (factChecks.length) {
    lines.push('**Published fact-checks**');
    for (const f of factChecks) {
      const rating = clean(f.rating) || 'rated';
      const by = clean(f.publisher);
      lines.push(`- ${rating}${by ? ` (${by})` : ''}: ${link(f.title || f.claim || f.url, f.url)}`);
    }
    lines.push('');
  }

  const e = c.evidence;
  if (e && Array.isArray(e.lines) && e.lines.length) {
    lines.push('**What the sources amount to**');
    if (e.verdict && VERDICT_WORDS[e.verdict] && e.position != null) {
      lines.push(`- ${VERDICT_WORDS[e.verdict]}`);
    }
    for (const l of e.lines) lines.push(`- ${clean(l)}`);
    lines.push('');
  }

  const results = Array.isArray(c.results) ? c.results : [];
  if (results.length) {
    lines.push('**Sources**');
    for (const r of results) {
      lines.push(`- ${link(r.title || r.url, r.url)}`);
      const note = clean(r.excerpt || r.snippet);
      if (note) lines.push(`  ${note}`);
    }
    lines.push('');
  }

  const scholar = Array.isArray(c.scholar) ? c.scholar : [];
  if (scholar.length) {
    lines.push('**Peer-reviewed work (OpenAlex)**');
    for (const w of scholar) {
      const bits = [clean(w.venue), clean(w.year)].filter(Boolean).join(', ');
      lines.push(`- ${link(w.title || w.url, w.url)}${bits ? ` — ${bits}` : ''}`);
    }
    lines.push('');
  }

  const summary = clean(c.analysis?.summary);
  if (summary) {
    lines.push('**AI summary**');
    lines.push(summary);
    lines.push('');
  }

  // Always last, and never omitted. Text pasted elsewhere loses the panel around it,
  // and this is the sentence that stops a list of links reading as a ruling.
  lines.push('---');
  lines.push('Gathered with Double Check, which finds sources rather than deciding '
    + 'what is true. Read them before repeating any of this.');

  return lines.join('\n');
}
