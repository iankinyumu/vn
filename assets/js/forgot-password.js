document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('forgotForm');
    if (!form) return;
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const email = document.getElementById('email').value.trim();
        const button = document.getElementById('resetBtn');
        const spinner = document.getElementById('spinner');
        const errorMessage = document.getElementById('errorMsg');
        const errorText = document.getElementById('errorText');
        errorMessage.style.display = 'none';
        button.disabled = true;
        spinner.style.display = 'inline-block';
        try {
            const { error } = await (await getSupabaseClient()).auth.resetPasswordForEmail(email, {
                redirectTo: new URL('login.html', window.location.href).href
            });
            if (error) throw error;
            document.getElementById('formSection').style.display = 'none';
            document.getElementById('sentEmail').textContent = email;
            document.getElementById('successMsg').style.display = 'block';
        } catch (error) {
            errorText.textContent = error.message || 'Unable to send a reset email.';
            errorMessage.style.display = 'flex';
            button.disabled = false;
            spinner.style.display = 'none';
        }
    });
});
