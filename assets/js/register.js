/* assets/js/register.js - SmartProfitBinary Registration Handler */

// The legal documents a new account accepts; bump it when terms.html, privacy.html or risk.html change.
const LEGAL_VERSION = '2026-10-03';
const NAME_PATTERN = /^[\p{L}\p{M}][\p{L}\p{M}' .-]{0,49}$/u;
const USERNAME_PATTERN = /^[A-Za-z0-9_.]{3,30}$/;

document.addEventListener('DOMContentLoaded', function () {
    if (typeof redirectIfAuthenticated === 'function') {
        redirectIfAuthenticated();
    }
    document.getElementById('registerForm')?.addEventListener('submit', handleRegister);
    document.getElementById('password')?.addEventListener('input', checkPasswordStrength);
    const confirmInput = document.getElementById('confirmPassword');
    if (confirmInput) {
        confirmInput.addEventListener('input', checkPasswordMatch);
    }
});

function checkPasswordStrength() {
    const password = document.getElementById('password').value;
    const bar = document.getElementById('strengthBar');
    const text = document.getElementById('strengthText');
    if (!bar || !text) return;
    bar.className = 'strength-bar';
    if (password.length === 0) {
        bar.style.width = '0%';
        text.textContent = 'Min 8 characters';
        text.style.color = 'var(--label-2)';
        return;
    }
    if (password.length < 6) {
        bar.classList.add('weak');
        text.textContent = 'Weak - Add more characters';
        text.style.color = 'var(--negative)';
    } else if (password.length < 8 || !(/[A-Z]/.test(password) && /[0-9]/.test(password))) {
        bar.classList.add('medium');
        text.textContent = 'Medium - Add uppercase & numbers';
        text.style.color = 'var(--caution)';
    } else {
        bar.classList.add('strong');
        text.textContent = 'Strong password!';
        text.style.color = 'var(--positive)';
    }
    const confirmPassword = document.getElementById('confirmPassword');
    if (confirmPassword && confirmPassword.value) checkPasswordMatch();
}

function checkPasswordMatch() {
    const password = document.getElementById('password').value;
    const confirm = document.getElementById('confirmPassword').value;
    const matchText = document.getElementById('matchText');
    if (!matchText) return;
    const mismatch = Boolean(confirm) && password !== confirm;
    matchText.hidden = !mismatch;
    document.getElementById('confirmPassword').setAttribute('aria-invalid', String(mismatch));
}

async function handleRegister(e) {
    e.preventDefault();
    const clean = window.smartProfitForms?.clean || ((value, max) => String(value).trim().slice(0, max));
    const firstName = clean(document.getElementById('firstName').value, 50);
    const lastName = clean(document.getElementById('lastName').value, 50);
    const email = clean(document.getElementById('email').value, 254).toLowerCase();
    const username = clean(document.getElementById('username').value, 30);
    const password = document.getElementById('password').value;
    const confirmPassword = document.getElementById('confirmPassword').value;
    const terms = document.getElementById('termsCheck');
    const status = document.getElementById('registerStatus');
    const showStatus = (message, isError) => {
        if (!status) return;
        status.textContent = message;
        status.style.color = isError ? 'var(--negative)' : 'var(--label)';
    };
    const errors = [];
    const invalid = [];
    const fail = (id, message) => { errors.push(message); invalid.push(id); };

    if (!firstName) fail('firstName', 'First Name is required.');
    else if (!NAME_PATTERN.test(firstName)) fail('firstName', 'First Name can use letters, spaces, hyphens and apostrophes only.');
    if (!lastName) fail('lastName', 'Last Name is required.');
    else if (!NAME_PATTERN.test(lastName)) fail('lastName', 'Last Name can use letters, spaces, hyphens and apostrophes only.');
    if (!email) {
        fail('email', 'Email is required.');
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        fail('email', 'Invalid email format.');
    }
    if (!username) fail('username', 'Username is required.');
    else if (username.length < 3) fail('username', 'Username must be at least 3 characters.');
    else if (!USERNAME_PATTERN.test(username)) fail('username', 'Username can use letters, numbers, dots and underscores only.');
    if (!password) fail('password', 'Password is required.');
    else if (password.length < 8) fail('password', 'Password must be at least 8 characters.');
    else if (password.length > 72) fail('password', 'Password must be 72 characters or fewer.');
    if (password !== confirmPassword) fail('confirmPassword', 'Passwords do not match.');
    if (terms && !terms.checked) fail('termsCheck', 'Confirm you are 18 or older and accept the Terms and Conditions and Privacy Policy.');

    for (const id of ['firstName', 'lastName', 'email', 'username', 'password', 'confirmPassword', 'termsCheck']) {
        document.getElementById(id)?.setAttribute('aria-invalid', String(invalid.includes(id)));
    }
    if (errors.length > 0) {
        showStatus(errors.join(' '), true);
        document.getElementById(invalid[0])?.focus();
        return;
    }

    // Supabase Auth limits sign-ups per IP; this only stops a tab from hammering it.
    const forms = window.smartProfitForms;
    const limit = forms ? forms.limiter('signup', { max: 5, windowMs: 10 * 60000, lockMs: 10 * 60000 }) : null;
    const wait = limit ? limit.wait() : 0;
    if (wait) {
        showStatus(`Too many sign-up attempts from this browser. Try again in ${forms.waitText(wait)}.`, true);
        return;
    }
    if (limit) limit.record();

    const submit = e.currentTarget.querySelector('button[type="submit"]');
    submit.disabled = true;
    showStatus('Creating your account…', false);
    try {
        const { data, error } = await (await getSupabaseClient()).auth.signUp({
            email,
            password,
            options: {
                // A random plush character becomes the profile picture; it can be changed on the profile page.
                data: { display_name: `${firstName} ${lastName}`, username, terms_version: LEGAL_VERSION, terms_accepted_at: new Date().toISOString(), ...(window.smartProfitAvatars ? { avatar: window.smartProfitAvatars.random() } : {}) }
            }
        });
        if (error) throw error;
        if (data.session) {
            // A new account goes straight into account setup.
            window.location.assign('onboarding.html');
            return;
        }
        showStatus('Account created. You can now sign in.', false);
        window.location.assign('login.html');
    } catch (error) {
        const rateLimited = error?.status === 429 || /rate limit|too many requests|email rate/i.test(error?.message || '');
        showStatus(
            rateLimited
                ? 'Signups are temporarily rate-limited by the email service. Please wait before trying again, or contact support to enable transactional email.'
                : (error.message || 'Unable to create your account.'),
            true
        );
        submit.disabled = false;
    }
}
