// Diagnostic for the video content script. Paste this whole file into DevTools on a
// YouTube watch page (F12, Console tab) and let it run for ~30 seconds while the video
// plays with captions turned on.
//
// It mirrors what src/content/video/index.js does, without needing the extension
// loaded, and prints what the content script would have seen. Use it to tell whether a
// problem is in reading captions or somewhere later in the pipeline.

(() => {
  const seen = new Set();
  const shipped = [];
  let buffer = '';
  let lastCue = '';
  let bufferStart = 0;
  let ticks = 0;

  const video = () => document.querySelector('video');
  const now = () => video()?.currentTime || 0;

  console.log('%c[probe] starting', 'font-weight:bold');
  console.log('[probe] video element:', !!video());
  console.log('[probe] captions button:', !!document.querySelector('.ytp-subtitles-button'),
    'pressed:', document.querySelector('.ytp-subtitles-button')?.getAttribute('aria-pressed'));
  console.log('[probe] caption segments right now:', document.querySelectorAll('.ytp-caption-segment').length);
  console.log('[probe] transcript segments right now:', document.querySelectorAll('ytd-transcript-segment-renderer').length,
    '(open the transcript from the description to populate these)');
  try {
    document.createElement('div').innerHTML = '<b></b>';
    console.log('[probe] Trusted Types: not enforced on this page');
  } catch (e) {
    console.warn('[probe] Trusted Types ENFORCED: any innerHTML assignment throws here.', e.message);
  }
  if (!document.querySelectorAll('.ytp-caption-segment').length) {
    console.warn('[probe] No caption segments visible. Turn captions ON (the CC button) and rerun.');
  }

  function ship(sentences, ts) {
    for (const s of sentences) {
      const t = s.trim();
      const k = t.toLowerCase();
      if (t.length < 30 || seen.has(k)) continue;
      seen.add(k);
      shipped.push({ ts: Math.round(ts), text: t });
      console.log(`[probe] sentence @${Math.round(ts)}s:`, t);
    }
  }

  const timer = setInterval(() => {
    ticks++;
    const seg = document.querySelectorAll('.ytp-caption-segment');
    if (seg.length) {
      const text = [...seg].map((s) => s.textContent).join(' ').replace(/\s+/g, ' ').trim();
      if (text && text !== lastCue) {
        lastCue = text;
        if (!buffer) bufferStart = now();
        buffer = `${buffer} ${text}`.replace(/\s+/g, ' ').trim();

        const parts = buffer.split(/(?<=[.!?])\s+/);
        if (parts.length > 1) {
          ship(parts.slice(0, -1), bufferStart);
          buffer = parts[parts.length - 1];
          bufferStart = now();
        } else if (buffer.split(/\s+/).length > 45) {
          ship([buffer], bufferStart);
          buffer = '';
          bufferStart = now();
        }
      }
    }

    if (ticks === 30) {
      clearInterval(timer);
      console.log('%c[probe] done after 30s', 'font-weight:bold');
      console.log(`[probe] sentences produced: ${shipped.length}`);
      console.log('[probe] leftover buffer:', buffer || '(empty)');
      if (!shipped.length) {
        console.warn(
          '[probe] Nothing produced. Either captions are off, the video has none, or ' +
          'YouTube changed the .ytp-caption-segment class this script relies on.'
        );
      }
      window.__fcProbe = shipped;
      console.log('[probe] full list available as window.__fcProbe');
    }
  }, 1000);
})();
