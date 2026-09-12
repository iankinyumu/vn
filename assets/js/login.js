/* assets/js/login.js - SmartProfitBinary Login Handler */

document.addEventListener('DOMContentLoaded', function () {
    if (typeof redirectIfAuthenticated === 'function') {
        redirectIfAuthenticated();
    }
});

function handleLogin(e) {
    e.preventDefault();
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    
    if (!email || !password) {
        alert('Please fill in all fields.');
        return;
    }
    if (password.length < 8) {
        alert('Password must be at least 8 characters.');
        return;
    }

    const displayName = email.split('@')[0];
    const capitalizedName = displayName.charAt(0).toUpperCase() + displayName.slice(1);

    // Save session in localStorage
    if (typeof setSession === 'function') {
        setSession({
            name: capitalizedName,
            email: email
        });
    } else {
        localStorage.setItem('smartprofit_user', JSON.stringify({
            name: capitalizedName,
            email: email,
            loggedIn: true
        }));
    }

    // Check redirect parameter
    const urlParams = new URLSearchParams(window.location.search);
    const redirectUrl = urlParams.get('redirect') || 'dashboard.html';
    window.location.href = redirectUrl;
}