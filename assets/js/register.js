/* assets/js/register.js - SmartProfitBinary Registration Handler */

document.addEventListener('DOMContentLoaded', function () {
    if (typeof redirectIfAuthenticated === 'function') {
        redirectIfAuthenticated();
    }
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
        text.style.color = '#94a3b8';
        return;
    }
    if (password.length < 6) {
        bar.classList.add('weak');
        text.textContent = 'Weak - Add more characters';
        text.style.color = '#ef4444';
    } else if (password.length < 8 || !(/[A-Z]/.test(password) && /[0-9]/.test(password))) {
        bar.classList.add('medium');
        text.textContent = 'Medium - Add uppercase & numbers';
        text.style.color = '#f59e0b';
    } else {
        bar.classList.add('strong');
        text.textContent = 'Strong password!';
        text.style.color = '#10b981';
    }
    const confirmPassword = document.getElementById('confirmPassword');
    if (confirmPassword && confirmPassword.value) checkPasswordMatch();
}

function checkPasswordMatch() {
    const password = document.getElementById('password').value;
    const confirm = document.getElementById('confirmPassword').value;
    const matchText = document.getElementById('matchText');
    if (!matchText) return;
    if (confirm && password !== confirm) {
        matchText.style.display = 'block';
    } else {
        matchText.style.display = 'none';
    }
}

function handleRegister(e) {
    e.preventDefault();
    const firstName = document.getElementById('firstName').value.trim();
    const lastName = document.getElementById('lastName').value.trim();
    const email = document.getElementById('email').value.trim();
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;
    const confirmPassword = document.getElementById('confirmPassword').value;
    const terms = document.getElementById('termsCheck');
    const errors = [];

    if (!firstName) errors.push('First Name is required.');
    if (!lastName) errors.push('Last Name is required.');
    if (!email) {
        errors.push('Email is required.');
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        errors.push('Invalid email format.');
    }
    if (!username) errors.push('Username is required.');
    else if (username.length < 3) errors.push('Username must be at least 3 characters.');
    if (!password) errors.push('Password is required.');
    else if (password.length < 8) errors.push('Password must be at least 8 characters.');
    if (password !== confirmPassword) errors.push('Passwords do not match.');
    if (terms && !terms.checked) errors.push('You must accept the Terms of Service.');

    if (errors.length > 0) {
        alert(errors.join('\n'));
        return;
    }

    if (typeof setSession === 'function') {
        setSession({
            name: `${firstName} ${lastName}`,
            email: email
        });
    } else {
        localStorage.setItem('smartprofit_user', JSON.stringify({
            name: `${firstName} ${lastName}`,
            email: email,
            loggedIn: true
        }));
    }

    alert('Account created successfully!\n\nWelcome to SmartProfitBinary, ' + firstName + '!');
    window.location.href = 'dashboard.html';
}