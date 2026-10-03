/* Shared form hygiene for the sign-in, sign-up and reset forms.

   clean() normalises what a person typed before it leaves the browser: Unicode NFC, no control or
   invisible formatting characters, single spaces, trimmed and capped. It is hygiene, not the
   defence against XSS: pages render every stored value with textContent, and the database checks
   its own inputs. Passwords are never cleaned, only length-checked.

   limiter() slows repeated attempts in this tab (failed sign-ins, reset and confirmation emails).
   The real limits are server-side (Supabase Auth rate limits and the RPC checks); this one only
   saves people from hitting them and explains the wait. It lives in sessionStorage, which is
   essential storage under the cookie policy. */
(function () {
    'use strict';

    // C0 and C1 controls, zero-width and bidirectional formatting characters.
    var INVISIBLE = /[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

    function clean(value, max) {
        var text = String(value == null ? '' : value);
        if (text.normalize) text = text.normalize('NFC');
        text = text.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
        return max ? text.slice(0, max) : text;
    }

    function read(key) {
        try { return JSON.parse(window.sessionStorage.getItem(key)) || { at: [], until: 0 }; } catch (_) { return { at: [], until: 0 }; }
    }

    function write(key, state) {
        try { window.sessionStorage.setItem(key, JSON.stringify(state)); } catch (_) { /* Private mode: the server limits still apply. */ }
    }

    // max attempts within windowMs, then a pause of lockMs.
    function limiter(name, options) {
        var key = 'smartprofit:limit:' + name;
        var max = options.max, windowMs = options.windowMs, lockMs = options.lockMs;
        return {
            // Milliseconds left in the pause, or 0 when another attempt is allowed.
            wait: function () { return Math.max(0, read(key).until - Date.now()); },
            record: function () {
                var now = Date.now();
                var state = read(key);
                state.at = state.at.filter(function (time) { return now - time < windowMs; }).concat(now);
                if (state.at.length >= max) { state.until = now + lockMs; state.at = []; }
                write(key, state);
            },
            reset: function () { try { window.sessionStorage.removeItem(key); } catch (_) { /* Nothing to clear. */ } }
        };
    }

    function waitText(ms) {
        var minutes = Math.ceil(ms / 60000);
        return minutes <= 1 ? 'about a minute' : minutes + ' minutes';
    }

    window.smartProfitForms = Object.freeze({ clean: clean, limiter: limiter, waitText: waitText });
})();
