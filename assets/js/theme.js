/* Appearance follows the system setting, live (HIG Dark Mode: no app-specific
   appearance setting). Loaded in <head> before the stylesheets apply, so the
   first paint is already in the right appearance. data-bs-theme drives both
   Bootstrap and tokens.css; without this script pages stay dark. */
(function () {
    'use strict';
    var query = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
    function apply() { document.documentElement.setAttribute('data-bs-theme', query && query.matches ? 'light' : 'dark'); }
    apply();
    if (query && query.addEventListener) query.addEventListener('change', apply);
})();
