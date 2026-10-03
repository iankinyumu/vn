/* assets/js/login.js - SmartProfitBinary Sign-In Handler */

document.addEventListener('DOMContentLoaded', () => {
    redirectIfAuthenticated();
    document.getElementById('loginForm')?.addEventListener('submit', handleLogin);
});

const LOGIN_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Five failed sign-ins in ten minutes pause this tab for five; Supabase Auth keeps its own per-IP limit.
function loginLimiter() {
    return window.smartProfitForms ? window.smartProfitForms.limiter('signin', { max: 5, windowMs: 10 * 60000, lockMs: 5 * 60000 }) : null;
}

function showLoginStatus(message, isError) {
    const status = document.getElementById('loginStatus');
    if (!status) return;
    status.textContent = message;
    status.style.color = isError ? 'var(--negative)' : 'var(--label)';
}

function validateLoginCredentials(email, password) {
    const errors = [];
    if (!email) {
        errors.push('Email is required.');
    } else if (!LOGIN_EMAIL_PATTERN.test(email)) {
        errors.push('Invalid email format.');
    }
    if (!password) errors.push('Password is required.');
    return errors;
}

function isRateLimitError(error) {
    return error?.status === 429 || /rate limit|too many requests/i.test(error?.message || '');
}

async function handleLogin(event) {
    event.preventDefault();
    const rawEmail = document.getElementById('email').value;
    const email = window.smartProfitForms ? window.smartProfitForms.clean(rawEmail, 254) : rawEmail.trim();
    const password = document.getElementById('password').value;
    const rememberInput = document.getElementById('rememberMe');
    const rememberSession = Boolean(rememberInput && rememberInput.checked);
    const submit = event.currentTarget.querySelector('button[type="submit"]');

    const errors = validateLoginCredentials(email, password);
    if (errors.length > 0) {
        showLoginStatus(errors.join(' '), true);
        return;
    }

    const limit = loginLimiter();
    const wait = limit ? limit.wait() : 0;
    if (wait) {
        showLoginStatus(`Too many failed sign-ins from this browser. Wait ${window.smartProfitForms.waitText(wait)}, then try again, or reset your password.`, true);
        return;
    }

    submit.disabled = true;
    showLoginStatus('Signing you in…', false);
    try {
        const client = await getSupabaseClient({ rememberSession });
        const { error } = await client.auth.signInWithPassword({ email, password });
        if (error) throw error;
        if (limit) limit.reset();
        const redirect = new URLSearchParams(window.location.search).get('redirect');
        window.location.assign(redirect && /^[a-z0-9-]+\.html$/i.test(redirect) ? redirect : 'dashboard.html');
    } catch (error) {
        const unconfirmed = isUnconfirmedError(error);
        if (limit && !unconfirmed) limit.record();
        showLoginStatus(
            isRateLimitError(error)
                ? 'Sign-ins are temporarily rate-limited. Please wait a moment before trying again, or reset your password.'
                : unconfirmed
                    ? 'Confirm your email address first. Open "Can\'t sign in?" below to send the confirmation email again.'
                    : (error.message || 'Unable to sign in. Check your email and password.'),
            true
        );
        if (unconfirmed) { const help = document.querySelector('[data-signin-help]'); if (help) help.open = true; }
        submit.disabled = false;
    }
}

function isUnconfirmedError(error) {
    return error?.code === 'email_not_confirmed' || /email not confirmed/i.test(error?.message || '');
}

/* "Can't sign in?": resends the sign-up confirmation email to the address in the form. The reply is
   the same whether or not an account is waiting, so the page never reveals who has an account. */
async function resendConfirmation(button) {
    const status = document.querySelector('[data-resend-status]');
    const email = document.getElementById('email').value.trim();
    if (!LOGIN_EMAIL_PATTERN.test(email)) {
        status.textContent = 'Enter your email address in the form above first.';
        document.getElementById('email').focus();
        return;
    }
    const forms = window.smartProfitForms;
    const limit = forms ? forms.limiter('resend-confirmation', { max: 3, windowMs: 15 * 60000, lockMs: 15 * 60000 }) : null;
    const wait = limit ? limit.wait() : 0;
    if (wait) { status.textContent = `Several emails were sent already. Check your inbox and spam folder, or try again in ${forms.waitText(wait)}.`; return; }
    if (limit) limit.record();
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    status.textContent = 'Sending…';
    try {
        const client = await getSupabaseClient();
        const { error } = await client.auth.resend({ type: 'signup', email });
        if (error && isRateLimitError(error)) { status.textContent = 'Too many emails were sent just now. Wait a few minutes, then try again.'; return; }
        status.textContent = `If an account for ${email} is waiting for confirmation, a new email is on its way.`;
    } catch (_) {
        status.textContent = 'The email could not be sent. Check your connection and try again.';
    } finally {
        button.disabled = false;
        button.removeAttribute('aria-busy');
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const resend = document.querySelector('[data-resend-confirmation]');
    if (!resend || resend.dataset.bound) return;
    resend.dataset.bound = 'true';
    resend.addEventListener('click', () => resendConfirmation(resend));
});
