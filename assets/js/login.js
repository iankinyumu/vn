/* assets/js/login.js - SmartProfitBinary Sign-In Handler */

document.addEventListener('DOMContentLoaded', () => redirectIfAuthenticated());

const LOGIN_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function showLoginStatus(message, isError) {
    const status = document.getElementById('loginStatus');
    if (!status) return;
    status.textContent = message;
    status.style.color = isError ? '#ef4444' : '#10b981';
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
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    const rememberInput = document.getElementById('rememberMe');
    const rememberSession = Boolean(rememberInput && rememberInput.checked);
    const submit = event.currentTarget.querySelector('button[type="submit"]');

    const errors = validateLoginCredentials(email, password);
    if (errors.length > 0) {
        showLoginStatus(errors.join(' '), true);
        return;
    }

    submit.disabled = true;
    showLoginStatus('Signing you in…', false);
    try {
        const client = await getSupabaseClient({ rememberSession });
        const { error } = await client.auth.signInWithPassword({ email, password });
        if (error) throw error;
        const redirect = new URLSearchParams(window.location.search).get('redirect');
        window.location.assign(redirect && /^[a-z0-9-]+\.html$/i.test(redirect) ? redirect : 'dashboard.html');
    } catch (error) {
        showLoginStatus(
            isRateLimitError(error)
                ? 'Sign-ins are temporarily rate-limited. Please wait a moment before trying again, or reset your password.'
                : (error.message || 'Unable to sign in. Check your email and password.'),
            true
        );
        submit.disabled = false;
    }
}
