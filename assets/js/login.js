document.addEventListener('DOMContentLoaded', () => redirectIfAuthenticated());

async function handleLogin(event) {
    event.preventDefault();
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    const submit = event.currentTarget.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
        const { error } = await (await getSupabaseClient()).auth.signInWithPassword({ email, password });
        if (error) throw error;
        const redirect = new URLSearchParams(window.location.search).get('redirect');
        window.location.assign(redirect && /^[a-z0-9-]+\.html$/i.test(redirect) ? redirect : 'dashboard.html');
    } catch (error) {
        alert(error.message || 'Unable to sign in. Check your email and password.');
        submit.disabled = false;
    }
}
