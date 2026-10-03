import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

/* "Can't sign in?" on the login page: the real login.html markup and login.js against a stub client.
   Help pages (FAQ, contact) need an account, so the login page itself carries the self-serve fixes. */

async function boot({ signIn, resend } = {}) {
    const dom = new JSDOM(fs.readFileSync('pages/login.html', 'utf8'), { url: 'http://localhost/pages/login.html', runScripts: 'outside-only' });
    const { window } = dom;
    const calls = { resend: [] };
    const client = {
        auth: {
            signInWithPassword: async () => (signIn ? signIn() : { data: {}, error: null }),
            resend: async (args) => { calls.resend.push(args); return resend ? resend(args) : { data: {}, error: null }; },
        },
    };
    window.getSupabaseClient = async () => client;
    window.redirectIfAuthenticated = async () => {};
    window.eval(fs.readFileSync('assets/js/login.js', 'utf8'));
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
    const document = window.document;
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    return { window, document, calls, settle, help: document.querySelector('[data-signin-help]'), status: () => document.querySelector('[data-resend-status]').textContent };
}

test('the login page offers "Can\'t sign in?" with a password reset link and no link to signed-in help pages', async () => {
    const page = await boot();
    try {
        assert.equal(page.help.tagName, 'DETAILS');
        assert.equal(page.help.querySelector('summary').textContent, "Can't sign in?");
        assert.equal(page.help.open, false, 'the help starts collapsed');
        assert.ok(page.help.querySelector('a[href="forgot-password.html"]'));
        assert.equal(page.document.querySelector('a[href="faq.html"], a[href="contact.html"], a[href="blog.html"]'), null);
    } finally { page.window.close(); }
});

test('resending the confirmation email needs an address and never reveals whether an account exists', async () => {
    const page = await boot();
    try {
        const button = page.document.querySelector('[data-resend-confirmation]');
        button.click();
        await page.settle();
        assert.equal(page.calls.resend.length, 0, 'sent without an address');
        assert.match(page.status(), /Enter your email address/);
        page.document.getElementById('email').value = ' someone@example.com ';
        button.click();
        assert.equal(button.disabled, true, 'the button was not busy while sending');
        await page.settle(); await page.settle();
        assert.deepEqual(JSON.parse(JSON.stringify(page.calls.resend)), [{ type: 'signup', email: 'someone@example.com' }]);
        assert.equal(page.status(), 'If an account for someone@example.com is waiting for confirmation, a new email is on its way.');
        assert.equal(button.disabled, false);
    } finally { page.window.close(); }

    const limited = await boot({ resend: () => ({ data: null, error: { status: 429, message: 'Email rate limit exceeded' } }) });
    try {
        limited.document.getElementById('email').value = 'someone@example.com';
        limited.document.querySelector('[data-resend-confirmation]').click();
        await limited.settle(); await limited.settle();
        assert.match(limited.status(), /Too many emails/);
    } finally { limited.window.close(); }
});

test('signing in with an unconfirmed email explains it and opens the help', async () => {
    const page = await boot({ signIn: () => ({ data: null, error: { code: 'email_not_confirmed', message: 'Email not confirmed' } }) });
    try {
        page.document.getElementById('email').value = 'someone@example.com';
        page.document.getElementById('password').value = 'correct-horse-battery';
        const form = page.document.getElementById('loginForm');
        await page.window.handleLogin({ preventDefault() {}, currentTarget: form });
        assert.match(page.document.getElementById('loginStatus').textContent, /^Confirm your email address first/);
        assert.equal(page.help.open, true, 'the help did not open');
    } finally { page.window.close(); }
});
