/* assets/js/staff-login.js - sign-in handler for the staff console.
 *
 * Runs against the isolated staff client only. A credential that authenticates
 * successfully but carries no staff role is signed straight back out: the staff
 * client is never left holding a session that the console would refuse, so a
 * customer account cannot occupy the staff session slot.
 */
(function () {
    'use strict';

    var GENERIC_FAILURE = 'Sign-in failed. Check your email and password, then try again.';
    var NOT_STAFF = 'This account does not have staff access.';

    function describe(error) {
        var message = error && error.message ? error.message : '';
        if (message === 'not_staff' || message === 'forbidden') return NOT_STAFF;
        if (/invalid login credentials/i.test(message)) return 'Check your email and password, then try again.';
        if (/email not confirmed/i.test(message)) return 'Confirm your email address before signing in.';
        if (/rate limit|too many/i.test(message)) return 'Too many attempts. Wait a moment and try again.';
        return GENERIC_FAILURE;
    }

    function safeRedirect(value) {
        return value && /^[a-z0-9-]+\.html$/i.test(value) ? value : 'admin.html';
    }

    function setStatus(text, tone) {
        var status = document.getElementById('staffLoginStatus');
        if (!status) return;
        status.textContent = text;
        status.className = tone === 'error' ? 'staff-login-status is-error' : 'staff-login-status';
    }

    window.handleStaffLogin = async function handleStaffLogin(event) {
        event.preventDefault();
        var emailInput = document.getElementById('email');
        var passwordInput = document.getElementById('password');
        var submit = event.currentTarget.querySelector('button[type="submit"]');
        var email = window.smartProfitForms ? window.smartProfitForms.clean(emailInput.value, 254) : emailInput.value.trim();
        var password = passwordInput.value;
        // Five failures in ten minutes pause this tab for ten; Supabase Auth limits sign-ins per IP as well.
        var limit = window.smartProfitForms ? window.smartProfitForms.limiter('staff-signin', { max: 5, windowMs: 10 * 60000, lockMs: 10 * 60000 }) : null;
        var wait = limit ? limit.wait() : 0;
        if (wait) {
            setStatus('Too many failed sign-ins from this browser. Try again in ' + window.smartProfitForms.waitText(wait) + '.', 'error');
            return;
        }

        submit.disabled = true;
        setStatus('Verifying staff access…', 'info');
        try {
            var client = await window.getStaffSupabaseClient();
            var signIn = await client.auth.signInWithPassword({ email: email, password: password });
            if (signIn.error) throw signIn.error;

            // Authority is decided by the server, not by the fact that a password
            // was accepted.
            var context = await client.rpc('get_staff_context');
            if (context.error) throw context.error;
            if (!context.data || !context.data.role) throw new Error('not_staff');

            if (limit) limit.reset();
            window.location.assign(safeRedirect(new URLSearchParams(window.location.search).get('redirect')));
        } catch (error) {
            // Leave no session behind for an account the console would reject.
            await window.staffSignOut();
            if (limit) limit.record();
            passwordInput.value = '';
            setStatus(describe(error), 'error');
            submit.disabled = false;
        }
    };

    document.addEventListener('DOMContentLoaded', function () {
        if (typeof window.redirectIfStaffAuthenticated === 'function') window.redirectIfStaffAuthenticated();
        var form = document.getElementById('staffLoginForm');
        if (form) form.addEventListener('submit', window.handleStaffLogin);
    });
})();
