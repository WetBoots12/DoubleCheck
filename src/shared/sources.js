// The reader's own list of sources: what they chose to keep, in the order they kept
// it, ready to become a works cited page.
//
// This is the only thing in the extension that deliberately outlives a browser
// session, which is why the rules around it are stricter than anywhere else. It is
// built by hand, one press at a time. Nothing reads browsing history, and no
// permission to do so is requested. A page the private-site rules flag never enters
// it, and unlike scanning there is no per-site override: scanning is transient and
// local, while this is a record on disk, so it gets the stricter test.
//
// Pure list logic; the storage that holds it lives in the worker.

export const SOURCE_LIMIT = 500;

function tidy(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

// Two addresses that differ only in tracking parameters or a fragment are the same
// source, and a reader who saves a page twice should not get two entries.
export function sourceKey(url) {
  try {
    const u = new URL(String(url));
    u.hash = '';
    for (const p of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_cid|mc_eid|ref|ref_src|igshid|s_cid|cmpid)/i.test(p)) u.searchParams.delete(p);
    }
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    return u.toString().replace(/\/$/, '');
  } catch {
    return tidy(url);
  }
}

// A stored source. Only the fields a citation needs, plus when it was kept, so the
// list can be shown newest first without inventing an order.
export function makeSource(input, now = Date.now()) {
  // A default parameter covers undefined and not null, and both reach here from a
  // worker reading a message body.
  const src = input || {};
  const url = tidy(src.url);
  if (!url) return null;
  return {
    key: sourceKey(url),
    url,
    kind: src.kind === 'article' ? 'article' : 'web',
    title: tidy(src.title),
    siteName: tidy(src.siteName),
    authors: (src.authors || [])
      .map((a) => (a && typeof a === 'object' ? { ...a, name: tidy(a.name) } : tidy(a)))
      .filter((a) => (typeof a === 'string' ? a : a.name)),
    date: tidy(src.date),
    doi: tidy(src.doi),
    venue: tidy(src.venue),
    // The day it was kept, which is what MLA and Harvard call the access date.
    accessed: tidy(src.accessed) || new Date(now).toISOString().slice(0, 10),
    addedAt: now,
  };
}

// Add, or replace what is already there for the same address.
//
// Replacing rather than ignoring is deliberate: a reader pressing the button again
// on a page they already kept is usually doing it because something is wrong with
// the entry, and re-reading the page is the cheapest way to fix it.
export function addSource(list, record, limit = SOURCE_LIMIT) {
  if (!record?.key) return { list: list || [], added: false, replaced: false };

  const rest = (list || []).filter((s) => s.key !== record.key);
  const replaced = rest.length !== (list || []).length;

  // Newest first, and the oldest fall off the end. Unbounded, this would grow in the
  // same ten megabytes that hold the API keys and the cache.
  return { list: [record, ...rest].slice(0, limit), added: true, replaced };
}

export function removeSource(list, key) {
  return (list || []).filter((s) => s.key !== key);
}

export function hasSource(list, url) {
  const key = sourceKey(url);
  return (list || []).some((s) => s.key === key);
}

// The stored shape is already what shared/citation.js consumes, apart from the
// bookkeeping fields, which it ignores.
export function citableSources(list) {
  return (list || []).map((s) => ({
    kind: s.kind,
    title: s.title,
    url: s.url,
    siteName: s.siteName,
    authors: s.authors || [],
    date: s.date,
    doi: s.doi,
    venue: s.venue,
    accessed: s.accessed,
  }));
}
