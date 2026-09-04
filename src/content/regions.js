// Deciding whether a region of a page is furniture or the article itself.
//
// The extension skips navigation, newsletter boxes, promos, share bars, players and
// recommendation rails. Some of those are recognisable only by their class names, so
// the rules match substrings: anything whose class contains "video", "promo",
// "share" and so on is treated as not-the-article.
//
// That is fine for a widget and disastrous for a container. Fox News wraps its
// stories in <article class="article-wrap has-video">, and "has-video" contains
// "video", so every paragraph of every story with a video in it was discarded: 284
// blocks examined, 284 excluded, nothing flagged. The class name was describing the
// article, not a player.
//
// The rule that fixes it is a size one, and it needs no site-specific knowledge: a
// region holding most of the article's text IS the article, whatever it calls
// itself. Furniture is small. A share bar, a newsletter box or a related rail is a
// fraction of the page it sits on, so only a small region may be excluded by name.
//
// Classic script, no imports, installing FCRegions the way segment.js installs
// FCSegment, because content scripts cannot use modules.

(function () {
  // Half the article. A related-articles rail on a news page is well under this;
  // a container wrapping the story is well over it.
  const SIDE_LIMIT = 0.5;

  // nodeChars: characters of text inside the region that matched an exclusion rule.
  // rootChars: characters of text in the article container being scanned.
  //
  // Returns true when the region is small enough to really be furniture. Unknown or
  // nonsensical sizes answer true, which keeps the old behaviour: a rule that named
  // a region still excludes it unless there is positive evidence it is the article.
  function isSideRegion(nodeChars, rootChars, limit = SIDE_LIMIT) {
    const node = Number(nodeChars);
    const root = Number(rootChars);
    if (!Number.isFinite(node) || !Number.isFinite(root) || root <= 0) return true;
    if (node <= 0) return true;
    return node / root < limit;
  }

  const api = { isSideRegion, SIDE_LIMIT };
  if (typeof globalThis !== 'undefined') globalThis.FCRegions = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
