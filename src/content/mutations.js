// Deciding when a changing page is worth re-scanning.
//
// Two separate problems, both about the cost of scanning rather than what gets
// scanned:
//
//   triage    Most mutations on a modern page carry no reading material: a class
//             toggled on a menu, an ad slot swapping itself out, a player's own
//             timers. Scanning is the expensive half, so look at what actually
//             arrived before scheduling one.
//
//   pacing    A plain debounce waits for quiet. A live blog, a ticker or a feed
//             that never goes quiet would then never be scanned at all, so there
//             is a ceiling past which a scan happens anyway.
//
// Both are pure: the DOM enters through small callbacks and the clock and timers
// are injected, so this runs under node --test with plain objects. Classic script,
// no imports, because content scripts cannot use modules; it installs FCMutations
// the way segment.js installs FCSegment.

(function () {
  const ELEMENT_NODE = 1;
  const TEXT_NODE = 3;

  // Enough characters to be a sentence rather than a label, a timestamp or an icon.
  const MIN_TEXT = 20;

  function textOf(node) {
    if (!node) return '';
    if (node.nodeType === TEXT_NODE) return node.nodeValue || '';
    if (node.nodeType === ELEMENT_NODE) return node.textContent || '';
    return '';
  }

  // Did this batch of mutation records bring in anything readable?
  // isExcluded(element) reports the page's own nav/promo/player regions, and
  // isOurs(element) the highlight wrappers this extension adds, which must never
  // trigger a scan of their own.
  function worthScanning(records, opts) {
    const o = opts || {};
    const isExcluded = o.isExcluded || (() => false);
    const isOurs = o.isOurs || (() => false);
    const min = o.minText ?? MIN_TEXT;

    for (const r of records || []) {
      if (r.type && r.type !== 'childList') continue;
      for (const node of r.addedNodes || []) {
        if (textOf(node).trim().length < min) continue;
        const host = node.nodeType === ELEMENT_NODE ? node : node.parentElement;
        if (!host) continue;
        if (isOurs(host)) continue;
        if (isExcluded(host)) continue;
        return true;
      }
    }
    return false;
  }

  // Debounce with a ceiling. Quiet for quietMs runs the work; a burst that never
  // goes quiet runs it anyway once maxWaitMs has passed since the burst began.
  function createScheduler(run, opts) {
    const o = opts || {};
    const quietMs = o.quietMs ?? 800;
    const maxWaitMs = o.maxWaitMs ?? 5000;
    const now = o.now || (() => Date.now());
    const setTimer = o.setTimer || setTimeout;
    const clearTimer = o.clearTimer || clearTimeout;

    let timer = null;
    let burstStarted = 0;

    function fire() {
      clearTimer(timer);
      timer = null;
      burstStarted = 0;
      run();
    }

    function schedule() {
      const t = now();
      if (!burstStarted) burstStarted = t;
      if (t - burstStarted >= maxWaitMs) {
        fire();
        return;
      }
      clearTimer(timer);
      timer = setTimer(fire, quietMs);
    }

    schedule.cancel = () => {
      clearTimer(timer);
      timer = null;
      burstStarted = 0;
    };
    return schedule;
  }

  const api = { worthScanning, createScheduler };
  if (typeof globalThis !== 'undefined') globalThis.FCMutations = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
