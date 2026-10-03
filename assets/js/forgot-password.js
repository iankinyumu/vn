document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('forgotForm');
    if (!form) return;
    const formSection = document.getElementById('formSection');
    const successMessage = document.getElementById('successMsg');
    const emailInput = document.getElementById('email');
    const button = document.getElementById('resetBtn');
    const spinner = document.getElementById('spinner');
    const errorMessage = document.getElementById('errorMsg');
    const errorText = document.getElementById('errorText');
    const forms = window.smartProfitForms;
    // Supabase Auth limits reset emails per hour; this stops one tab from using them all up.
    const limit = forms ? forms.limiter('password-reset', { max: 3, windowMs: 15 * 60000, lockMs: 15 * 60000 }) : null;

    const showError = (message) => {
        errorText.textContent = message;
        errorMessage.style.display = 'flex';
    };

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const email = forms ? forms.clean(emailInput.value, 254) : emailInput.value.trim();
        errorMessage.style.display = 'none';
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            emailInput.setAttribute('aria-invalid', 'true');
            showError('Enter the email address you signed up with.');
            emailInput.focus();
            return;
        }
        emailInput.setAttribute('aria-invalid', 'false');
        const wait = limit ? limit.wait() : 0;
        if (wait) {
            showError(`Several reset emails were sent already. Check your inbox and spam folder, or try again in ${forms.waitText(wait)}.`);
            return;
        }
        if (limit) limit.record();
        button.disabled = true;
        button.setAttribute('aria-busy', 'true');
        spinner.style.display = 'inline-block';
        try {
            const { error } = await (await getSupabaseClient()).auth.resetPasswordForEmail(email, {
                redirectTo: new URL('login.html', window.location.href).href
            });
            if (error) throw error;
            formSection.style.display = 'none';
            document.getElementById('sentEmail').textContent = email;
            successMessage.style.display = 'block';
            document.getElementById('successTitle')?.focus();
        } catch (error) {
            const rateLimited = error?.status === 429 || /rate limit|too many/i.test(error?.message || '');
            showError(rateLimited ? 'Too many reset emails were requested. Wait a few minutes, then try again.' : (error.message || 'Unable to send a reset email.'));
        } finally {
            button.disabled = false;
            button.removeAttribute('aria-busy');
            spinner.style.display = 'none';
        }
    });

    // "Try again" goes back to the form with the address still filled in.
    document.getElementById('tryAgainLink')?.addEventListener('click', () => {
        successMessage.style.display = 'none';
        formSection.style.display = '';
        emailInput.focus();
    });
});
