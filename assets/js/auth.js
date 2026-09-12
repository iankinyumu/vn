/* assets/js/auth.js - SmartProfitBinary Authentication & Session Manager */

const AUTH_STORAGE_KEY = 'smartprofit_user';

function isAuthenticated() {
    try {
        const user = localStorage.getItem(AUTH_STORAGE_KEY);
        return !!user && JSON.parse(user).loggedIn === true;
    } catch (e) {
        return false;
    }
}

function getUser() {
    try {
        const user = localStorage.getItem(AUTH_STORAGE_KEY);
        return user ? JSON.parse(user) : null;
    } catch (e) {
        return null;
    }
}

function setSession(userData) {
    const session = {
        name: userData.name || 'Trader',
        email: userData.email || 'trader@smartprofitbinary.com',
        loggedIn: true,
        loginTime: new Date().toISOString()
    };
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session));
}

function logout() {
    localStorage.removeItem(AUTH_STORAGE_KEY);
    window.location.href = 'index.html';
}

function requireAuth() {
    if (!isAuthenticated()) {
        const currentPath = window.location.pathname.split('/').pop() || 'dashboard.html';
        window.location.href = `login.html?redirect=${encodeURIComponent(currentPath)}`;
    }
}

function redirectIfAuthenticated() {
    if (isAuthenticated()) {
        window.location.href = 'dashboard.html';
    }
}

function initNavbarAuth() {
    const nav = document.getElementById('mainNav');
    if (!nav) return;

    const navList = nav.querySelector('.navbar-nav');
    if (!navList) return;

    // Some pages, such as the public landing page, must keep their visitor
    // navigation even when a session exists in this browser.
    const loggedIn = isAuthenticated() && nav.dataset.authMode !== 'public';
    const user = getUser();
    const currentPage = window.location.pathname.split('/').pop() || 'index.html';

    if (loggedIn) {
        // Authenticated user navigation
        navList.innerHTML = `
            <li class="nav-item"><a class="nav-link ${currentPage === 'dashboard.html' ? 'active' : ''}" href="dashboard.html">Dashboard</a></li>
            <li class="nav-item"><a class="nav-link ${currentPage === 'trade.html' ? 'active' : ''}" href="trade.html">Trade</a></li>
            <li class="nav-item"><a class="nav-link ${currentPage === 'profile.html' ? 'active' : ''}" href="profile.html">Profile</a></li>
            <li class="nav-item nav-account"><span>${user ? user.name : 'Account'}</span></li>
            <li class="nav-item"><a class="nav-link nav-signout" href="#" onclick="logout(); return false;">Sign out</a></li>
        `;
    } else {
        // Public visitor navigation
        navList.innerHTML = `
            <li class="nav-item"><a class="nav-link ${currentPage === 'index.html' ? 'active' : ''}" href="index.html">Home</a></li>
            <li class="nav-item"><a class="nav-link ${currentPage === 'about.html' ? 'active' : ''}" href="about.html">About</a></li>
            <li class="nav-item"><a class="nav-link ${currentPage === 'blog.html' || currentPage === 'blog-single.html' ? 'active' : ''}" href="blog.html">Blog</a></li>
            <li class="nav-item"><a class="nav-link ${currentPage === 'contact.html' ? 'active' : ''}" href="contact.html">Contact</a></li>
            <li class="nav-item"><a class="nav-link ${currentPage === 'faq.html' ? 'active' : ''}" href="faq.html">FAQ</a></li>
            <li class="nav-item ms-2"><a href="login.html" class="btn btn-outline-light btn-sm rounded-pill px-3">Sign In</a></li>
            <li class="nav-item ms-1"><a href="register.html" class="btn btn-premium-primary btn-sm rounded-pill px-3">Register</a></li>
        `;
    }
}

document.addEventListener('DOMContentLoaded', function () {
    initNavbarAuth();

    // Forgot password form logic
    const forgotForm = document.getElementById('forgotForm');
    if (forgotForm) {
        forgotForm.addEventListener('submit', function (e) {
            e.preventDefault();
            const email = document.getElementById('email').value.trim();
            const errorMsg = document.getElementById('errorMsg');
            const errorText = document.getElementById('errorText');
            const resetBtn = document.getElementById('resetBtn');
            const spinner = document.getElementById('spinner');
            if (errorMsg) errorMsg.style.display = 'none';
            if (!email) {
                if (errorText) errorText.textContent = 'Please enter your email address.';
                if (errorMsg) errorMsg.style.display = 'flex';
                return;
            }
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                if (errorText) errorText.textContent = 'Please enter a valid email address.';
                if (errorMsg) errorMsg.style.display = 'flex';
                return;
            }
            if (resetBtn) resetBtn.disabled = true;
            if (spinner) spinner.style.display = 'inline-block';
            setTimeout(function () {
                if (resetBtn) resetBtn.disabled = false;
                if (spinner) spinner.style.display = 'none';
                const formSec = document.getElementById('formSection');
                if (formSec) formSec.style.display = 'none';
                const sentEmail = document.getElementById('sentEmail');
                if (sentEmail) sentEmail.textContent = email;
                const successMsg = document.getElementById('successMsg');
                if (successMsg) successMsg.style.display = 'block';
            }, 1200);
        });
    }

    const tryAgainLink = document.getElementById('tryAgainLink');
    if (tryAgainLink) {
        tryAgainLink.addEventListener('click', function (e) {
            e.preventDefault();
            const formSec = document.getElementById('formSection');
            if (formSec) formSec.style.display = 'block';
            const successMsg = document.getElementById('successMsg');
            if (successMsg) successMsg.style.display = 'none';
            const emailInput = document.getElementById('email');
            if (emailInput) emailInput.value = '';
            const errorMsg = document.getElementById('errorMsg');
            if (errorMsg) errorMsg.style.display = 'none';
        });
    }
});
