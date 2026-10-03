/* Cookie and storage consent (see pages/cookies.html).

   SmartProfit sets no advertising or analytics cookies. What it keeps on a device falls into two
   groups:
   - Essential: the sign-in session, short-lived account caches, sign-in attempt limits and this
     consent record. These are needed for the service and are always on.
   - Preferences: settings the person picks (appearance, side panel width, chart style, trade
     popups, the trade companion, dismissed notices). These persist only with consent.

   Scripts read and write preference keys through window.smartProfitConsent.store. With consent it
   is localStorage; without it, an in-memory store, so a setting still works on the current page
   but is forgotten when the page closes. This script loads in <head>, before theme.js, on every
   page; the banner is built once the body exists. */
(function () {
    'use strict';

    var KEY = 'smartprofit:consent';
    var VERSION = 1;
    // Every localStorage key that only holds a preference. Clearing consent removes them.
    var PREFERENCE_KEYS = [
        'smartprofit:appearance',
        'smartprofit:rail-expanded',
        'smartprofit:trade-toasts',
        'smartprofit:companion',
        'smartprofit:chart',
        'smartprofit:engine-notice-dismissed'
    ];
    var SCRIPT_SRC = document.currentScript ? document.currentScript.src : '';
    var listeners = [];

    /* The choice itself is a first-party cookie, sp_consent, for 12 months: "v1.preferences" or
       "v1.essential", then the time it was made. It is essential (it remembers the answer), is
       never sent to another site (SameSite=Lax) and carries no identifier. A localStorage copy
       keeps choices made before the cookie existed. */
    var COOKIE = 'sp_consent';
    var COOKIE_MAX_AGE = 365 * 24 * 60 * 60;

    function readCookie() {
        var match = document.cookie.match(/(?:^|;\s*)sp_consent=v(\d+)\.(preferences|essential)\.(\d+)/);
        if (!match || Number(match[1]) !== VERSION) return null;
        return { v: VERSION, preferences: match[2] === 'preferences', at: new Date(Number(match[3])).toISOString() };
    }

    function writeCookie(value) {
        var secure = window.location.protocol === 'https:' ? '; Secure' : '';
        document.cookie = COOKIE + '=' + value + '; Max-Age=' + COOKIE_MAX_AGE + '; Path=/; SameSite=Lax' + secure;
    }

    function readRecord() {
        var fromCookie = readCookie();
        if (fromCookie) return fromCookie;
        try {
            var stored = JSON.parse(window.localStorage.getItem(KEY));
            if (!stored || stored.v !== VERSION) return null;
            writeCookie('v' + VERSION + '.' + (stored.preferences ? 'preferences' : 'essential') + '.' + (Date.parse(stored.at) || Date.now()));
            return stored;
        } catch (_) { return null; }
    }

    var record = readRecord();

    function allows(category) {
        if (category === 'essential') return true;
        return Boolean(record && record[category] === true);
    }

    // A Storage-shaped facade for preference keys.
    var memory = {};
    var store = Object.freeze({
        getItem: function (key) {
            if (allows('preferences')) { try { return window.localStorage.getItem(key); } catch (_) { /* fall through */ } }
            return Object.prototype.hasOwnProperty.call(memory, key) ? memory[key] : null;
        },
        setItem: function (key, value) {
            memory[key] = String(value);
            if (allows('preferences')) { try { window.localStorage.setItem(key, String(value)); } catch (_) { /* memory keeps it */ } }
        },
        removeItem: function (key) {
            delete memory[key];
            try { window.localStorage.removeItem(key); } catch (_) { /* nothing stored */ }
        }
    });

    function clearPreferences() {
        PREFERENCE_KEYS.forEach(function (key) {
            try {
                var value = window.localStorage.getItem(key);
                // Keep the setting for this page, but take it off the device.
                if (value !== null) memory[key] = value;
                window.localStorage.removeItem(key);
            } catch (_) { /* nothing stored */ }
        });
    }

    function save(choices) {
        var preferences = Boolean(choices && choices.preferences);
        var now = Date.now();
        record = { v: VERSION, preferences: preferences, at: new Date(now).toISOString() };
        writeCookie('v' + VERSION + '.' + (preferences ? 'preferences' : 'essential') + '.' + now);
        try { window.localStorage.setItem(KEY, JSON.stringify(record)); } catch (_) { /* The cookie still holds it. */ }
        if (preferences) {
            // Settings chosen before consent move from memory to the device.
            Object.keys(memory).forEach(function (key) { try { window.localStorage.setItem(key, memory[key]); } catch (_) { /* memory keeps it */ } });
        } else {
            clearPreferences();
        }
        hideBanner();
        listeners.forEach(function (listener) { try { listener(record); } catch (_) { /* One listener cannot block the rest. */ } });
        window.dispatchEvent(new CustomEvent('smartprofit:consent', { detail: { preferences: preferences } }));
    }

    // No choice yet means no preference storage: anything already there from before consent existed is kept in memory only.
    if (!record) clearPreferences();

    /* ---- Banner -------------------------------------------------------------------------- */

    var banner = null;
    var lastFocus = null;

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function ensureStyles() {
        if (document.querySelector('link[data-consent-css]')) return;
        var link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = new URL('../css/consent.css', SCRIPT_SRC || window.location.href).href;
        link.dataset.consentCss = '';
        document.head.append(link);
    }

    function policyHref() {
        // Pages all live in one folder, so a relative link works from any of them.
        return 'cookies.html';
    }

    function buildBanner() {
        var section = el('section', 'consent-banner');
        section.setAttribute('aria-labelledby', 'consentTitle');
        section.dataset.consentBanner = '';
        var copy = el('div', 'consent-copy');
        var title = el('h2', 'consent-title', 'Cookies and storage');
        title.id = 'consentTitle';
        title.tabIndex = -1;
        var text = el('p', 'consent-text', 'We keep your sign-in session and security records on this device because the site needs them. With your permission we also remember settings you choose, such as appearance. We use no advertising or analytics cookies. ');
        var link = el('a', null, 'Read the cookie policy');
        link.href = policyHref();
        text.append(link, document.createTextNode('.'));
        copy.append(title, text);
        var actions = el('div', 'consent-actions');
        // Both choices are equal: same style, same size, same number of steps.
        var essential = el('button', 'consent-btn', 'Essential only');
        essential.type = 'button';
        essential.dataset.consentChoice = 'essential';
        var all = el('button', 'consent-btn', 'Allow preferences');
        all.type = 'button';
        all.dataset.consentChoice = 'preferences';
        essential.addEventListener('click', function () { save({ preferences: false }); });
        all.addEventListener('click', function () { save({ preferences: true }); });
        actions.append(essential, all);
        section.append(copy, actions);
        return section;
    }

    function reserveSpace() {
        if (!banner || banner.hidden) { document.documentElement.style.removeProperty('--consent-space'); return; }
        document.documentElement.style.setProperty('--consent-space', banner.offsetHeight + 'px');
    }

    function showBanner(focus) {
        ensureStyles();
        if (!banner) {
            banner = buildBanner();
            document.body.append(banner);
            window.addEventListener('resize', reserveSpace);
        }
        lastFocus = focus ? document.activeElement : null;
        banner.hidden = false;
        document.documentElement.classList.add('has-consent-banner');
        reserveSpace();
        if (focus) banner.querySelector('#consentTitle').focus();
    }

    function hideBanner() {
        if (!banner || banner.hidden) return;
        var hadFocus = banner.contains(document.activeElement);
        banner.hidden = true;
        document.documentElement.classList.remove('has-consent-banner');
        reserveSpace();
        if (hadFocus && lastFocus && lastFocus.isConnected) lastFocus.focus();
    }

    /* ---- Settings controls ----------------------------------------------------------------
       Any element with data-consent-open reopens the banner (the footer's "Cookie settings").
       A [data-consent-settings] form on the cookie policy page shows and saves the choice. */

    function wireSettings() {
        document.addEventListener('click', function (event) {
            var opener = event.target.closest && event.target.closest('[data-consent-open]');
            if (!opener) return;
            event.preventDefault();
            showBanner(true);
        });
        var form = document.querySelector('[data-consent-settings]');
        if (!form) return;
        var box = form.querySelector('[data-consent-preferences]');
        var status = form.querySelector('[data-consent-status]');
        var sync = function () {
            if (box) box.checked = allows('preferences');
            if (status) status.textContent = record
                ? (record.preferences ? 'Your settings are remembered on this device.' : 'Only essential storage is used. Your settings last until you close the page.')
                : 'You have not made a choice yet. Until you do, only essential storage is used.';
        };
        form.addEventListener('submit', function (event) {
            event.preventDefault();
            save({ preferences: Boolean(box && box.checked) });
            sync();
            if (status) status.textContent = 'Saved. ' + status.textContent;
        });
        listeners.push(sync);
        sync();
    }

    function boot() {
        wireSettings();
        if (!record) showBanner(false);
    }

    window.smartProfitConsent = Object.freeze({
        allows: allows,
        store: store,
        get: function () { return record ? { preferences: record.preferences, at: record.at } : null; },
        save: save,
        open: function () { showBanner(true); },
        onChange: function (listener) { if (typeof listener === 'function') listeners.push(listener); },
        preferenceKeys: PREFERENCE_KEYS.slice()
    });

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
    else boot();
})();
