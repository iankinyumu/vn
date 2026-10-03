/* Appearance: System (the default, follows the device live), Light or Dark. The
   choice is kept per browser and applied in <head> before the stylesheets paint.
   data-bs-theme on <html> drives both Bootstrap and tokens.css; without this
   script pages stay dark. The shell's Appearance menu calls
   window.smartProfitAppearance.set(); other tabs follow through the storage event. */
(function () {
    'use strict';
    var KEY = 'smartprofit:appearance';
    var CHOICES = ['system', 'light', 'dark'];
    var query = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
    var memory = 'system';
    // Appearance is a preference: it persists only with consent (consent.js, loaded first).
    function prefs() { return (window.smartProfitConsent && window.smartProfitConsent.store) || window.localStorage; }

    function preference() {
        try {
            var value = prefs().getItem(KEY);
            return CHOICES.indexOf(value) > 0 ? value : (value === null ? memory : 'system');
        } catch (_) {
            return memory;
        }
    }

    function apply() {
        var choice = preference();
        var light = choice === 'system' ? Boolean(query && query.matches) : choice === 'light';
        var root = document.documentElement;
        root.setAttribute('data-bs-theme', light ? 'light' : 'dark');
        root.setAttribute('data-appearance', choice);
        window.dispatchEvent(new CustomEvent('smartprofit:appearance', { detail: { preference: choice, theme: light ? 'light' : 'dark' } }));
    }

    function set(choice) {
        if (CHOICES.indexOf(choice) < 0) return;
        memory = choice;
        try {
            if (choice === 'system') prefs().removeItem(KEY);
            else prefs().setItem(KEY, choice);
        } catch (_) { /* Private windows keep the choice for this page only. */ }
        apply();
    }

    apply();
    if (query && query.addEventListener) query.addEventListener('change', apply);
    window.addEventListener('storage', function (event) { if (event.key === KEY) apply(); });
    window.smartProfitAppearance = Object.freeze({ get: preference, set: set, choices: CHOICES });
})();
