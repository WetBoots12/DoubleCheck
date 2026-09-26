// Applies the reader's chosen theme before the page paints.
//
// The choice is a setting in chrome.storage, which is asynchronous: waiting for it
// would draw a light page and then snap it dark. So the pages keep a copy of the
// choice in localStorage, which can be read synchronously here, and write it back
// whenever the setting changes (see applyTheme in shared/appearance.js). Loaded as a
// plain script in <head>, before the stylesheets are used; extension pages may not
// run inline scripts, which is why this is a file.
(function () {
  try {
    const theme = localStorage.getItem('dc-theme');
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  } catch { /* storage unavailable: the system theme applies */ }
})();
