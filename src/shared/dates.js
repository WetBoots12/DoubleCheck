// When a source was published, and whether that matters for the claim.
//
// A claim about the present is not corroborated by a page from years ago. "Crime is
// at an all-time low" and "unemployment is 3.5 percent" were both true of some year,
// and a search will happily return the year they were true of. The evidence score
// treated that page exactly like one published this week.
//
// Two conservative rules, because a wrongly discounted source is a real cost:
//
//   a dated claim   a source published before the year the claim is about cannot be
//                   reporting on it. A later source can, so only earlier ones count
//                   against it.
//   a present claim a claim with no year, phrased as something true now, is weakly
//                   served by a page more than about eighteen months old.
//
// Anything undated is left alone rather than penalised: most of the web does not
// say when it was written, and silence is not evidence of age.
//
// Pure: no DOM, no network, and the clock is injected in the comparisons.

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

const MIN_YEAR = 1990;
const MAX_AHEAD_MS = 1000 * 60 * 60 * 24 * 2; // a couple of days for time zones

// Accepts what search providers and pages actually put in these fields: ISO stamps,
// "Mar 3, 2024", "3 March 2024", "2024/03/03" and bare years. Returns a Date or null.
export function parseDate(value, opts = {}) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  const now = opts.now ? new Date(opts.now) : new Date();
  const text = String(value || '').trim();
  if (!text) return null;

  let d = null;

  // No trailing \b: in "2024-03-03T09:00:00Z" the day is followed by a letter, which
  // is not a word boundary, so the whole stamp used to fall through to the bare year.
  const iso = text.match(/(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/);
  if (iso) d = new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3]));

  if (!d) {
    const slash = text.match(/(?<!\d)(\d{4})\/(\d{1,2})\/(\d{1,2})(?!\d)/);
    if (slash) d = new Date(Date.UTC(+slash[1], +slash[2] - 1, +slash[3]));
  }

  if (!d) {
    // "Mar 3, 2024" and "March 3 2024"
    const named = text.match(/\b([a-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/i);
    if (named && MONTHS[named[1].slice(0, 3).toLowerCase()] !== undefined) {
      d = new Date(Date.UTC(+named[3], MONTHS[named[1].slice(0, 3).toLowerCase()], +named[2]));
    }
  }

  if (!d) {
    // "3 March 2024"
    const dayFirst = text.match(/\b(\d{1,2})\s+([a-z]{3,9})\.?,?\s+(\d{4})\b/i);
    if (dayFirst && MONTHS[dayFirst[2].slice(0, 3).toLowerCase()] !== undefined) {
      d = new Date(Date.UTC(+dayFirst[3], MONTHS[dayFirst[2].slice(0, 3).toLowerCase()], +dayFirst[1]));
    }
  }

  if (!d) {
    // A bare year, which is all some sources give.
    const bare = text.match(/\b(19|20)\d{2}\b/);
    if (bare) d = new Date(Date.UTC(+bare[0], 0, 1));
  }

  if (!d || !Number.isFinite(d.getTime())) return null;
  const year = d.getUTCFullYear();
  if (year < MIN_YEAR) return null;
  if (d.getTime() > now.getTime() + MAX_AHEAD_MS) return null; // a date in the future is a parse error
  return d;
}

// Phrases that put a claim in the present rather than in a stated year.
const PRESENT = /\b(now|today|currently|at present|this year|these days|so far this year|to date|all[- ]time (high|low)|record (high|low|number|level)|the highest ever|the lowest ever|has never been)\b/i;

// What period the claim is about: a year it names, or the present.
export function claimTimeframe(claim) {
  const text = String(claim || '');
  const years = (text.match(/\b(?:19|20)\d{2}\b/g) || []).map(Number).filter((y) => y >= MIN_YEAR);
  const year = years.length ? Math.max(...years) : null;
  return { year, current: !year && PRESENT.test(text) };
}

const CURRENT_CLAIM_MAX_MS = 1000 * 60 * 60 * 24 * 548; // about eighteen months

// How well a source's date fits the claim.
//   'unknown'  no date, so no opinion
//   'fits'     the source could be reporting on the period in question
//   'predates' published before the year the claim is about
//   'stale'    a claim about now, answered by a page well in the past
export function temporalFit(claim, sourceDate, opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();
  const date = parseDate(sourceDate, { now });
  if (!date) return { status: 'unknown', date: null, note: '' };

  const frame = claimTimeframe(claim);
  const year = date.getUTCFullYear();

  if (frame.year && year < frame.year) {
    return {
      status: 'predates',
      date,
      note: `published in ${year}, before the ${frame.year} this claim is about`,
    };
  }

  if (frame.current && now.getTime() - date.getTime() > CURRENT_CLAIM_MAX_MS) {
    return {
      status: 'stale',
      date,
      note: `from ${year}, while the claim is about the present`,
    };
  }

  return { status: 'fits', date, note: '' };
}

export function isMismatch(status) {
  return status === 'predates' || status === 'stale';
}

// Publication dates as pages actually declare them, in the order they are worth
// trusting. Used on the pages fetched for their text, so the date comes from the
// publisher rather than from a search provider's guess.
const META_DATE = [
  /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']article:published_time["']/i,
  /<meta[^>]+name=["'](?:date|pubdate|publish-date|publication_date|dc\.date)["'][^>]+content=["']([^"']+)["']/i,
  /<time[^>]+datetime=["']([^"']+)["']/i,
  /"datePublished"\s*:\s*"([^"]+)"/i,
];

export function publishedDateFromHtml(html, opts = {}) {
  const text = String(html || '');
  for (const pattern of META_DATE) {
    const m = text.match(pattern);
    const parsed = m ? parseDate(m[1], opts) : null;
    if (parsed) return parsed.toISOString();
  }
  return '';
}
