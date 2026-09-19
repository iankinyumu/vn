import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

/* Sign-in must validate and report the same way sign-up does. Before these
 * changes login.js handed the trimmed email straight to Supabase and pushed any
 * failure into a browser alert(), which shows the raw provider string. These
 * tests drive the real login.js against a stub client and assert what the
 * customer actually sees, with no live network. */

const SKELETON = `<!DOCTYPE html><html><body>
    <form id="loginForm">
        <input id="email" type="email">
        <input id="password" type="password">
        <input id="rememberMe" type="checkbox">
        <button type="submit">Sign In</button>
    </form>
    <p id="loginStatus" role="status" aria-live="polite"></p>
</body></html>`;

const EMAIL_PATTERN_SOURCE = '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$';

async function settle() {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

async function bootLoginPage({ signIn } = {}) {
    const dom = new JSDOM(SKELETON, { url: 'http://localhost/pages/login.html', runScripts: 'outside-only' });
    const { window } = dom;
    const calls = { clientOptions: [], signIn: [] };
    const alerts = [];

    const client = {
        auth: {
            signInWithPassword: async (credentials) => {
                calls.signIn.push(credentials);
                return signIn ? signIn(credentials) : { data: { session: { access_token: 'token' } }, error: null };
            }
        }
    };

    window.getSupabaseClient = async (options) => {
        calls.clientOptions.push(options);
        return client;
    };
    // The page redirects away when a session already exists; irrelevant here.
    window.redirectIfAuthenticated = async () => {};
    window.alert = (message) => alerts.push(message);

    window.eval(fs.readFileSync('assets/js/login.js', 'utf8'));
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
    await settle();

    const document = window.document;
    const form = document.getElementById('loginForm');
    return {
        window, document, form,
        status: document.getElementById('loginStatus'),
        calls, alerts,
        setCredentials(email, password, remember) {
            document.getElementById('email').value = email;
            document.getElementById('password').value = password;
            document.getElementById('rememberMe').checked = Boolean(remember);
        },
        submit: () => window.handleLogin({ preventDefault() {}, currentTarget: form })
    };
}

test('an invalid email is rejected before any Supabase call is attempted', async () => {
    const page = await bootLoginPage();
    page.setCredentials('not-an-email', 'correct-horse-battery');
    await page.submit();

    assert.equal(page.calls.clientOptions.length, 0, 'no client may be requested for a malformed address');
    assert.equal(page.calls.signIn.length, 0, 'signInWithPassword must not be reached');
    assert.match(page.status.textContent, /Invalid email format/);
    assert.equal(page.alerts.length, 0, 'validation must never surface as an alert');
    page.window.close();
});

test('an empty password is rejected before any Supabase call is attempted', async () => {
    const page = await bootLoginPage();
    page.setCredentials('trader@example.com', '');
    await page.submit();

    assert.equal(page.calls.clientOptions.length, 0);
    assert.equal(page.calls.signIn.length, 0);
    assert.match(page.status.textContent, /Password is required/);
    assert.equal(page.alerts.length, 0);
    page.window.close();
});

test('both empty fields are reported together in the inline status', async () => {
    const page = await bootLoginPage();
    page.setCredentials('', '');
    await page.submit();

    assert.match(page.status.textContent, /Email is required/);
    assert.match(page.status.textContent, /Password is required/);
    assert.equal(page.calls.signIn.length, 0);
    page.window.close();
});

test('a rate-limited sign-in shows a friendly message, not the raw Supabase text', async () => {
    const raw = 'Email rate limit exceeded';
    const page = await bootLoginPage({
        signIn: async () => ({ data: null, error: Object.assign(new Error(raw), { status: 429 }) })
    });
    page.setCredentials('trader@example.com', 'correct-horse-battery');
    await page.submit();

    assert.equal(page.calls.signIn.length, 1, 'a valid submission must reach Supabase');
    assert.match(page.status.textContent, /rate-limited/i);
    assert.ok(!page.status.textContent.includes(raw), 'the raw provider string must not be shown');
    assert.equal(page.alerts.length, 0);
    page.window.close();
});

test('a rate-limit signalled only by message text is still recognised', async () => {
    const page = await bootLoginPage({
        signIn: async () => ({ data: null, error: new Error('Too many requests, please try again later') })
    });
    page.setCredentials('trader@example.com', 'correct-horse-battery');
    await page.submit();

    assert.match(page.status.textContent, /rate-limited/i);
    assert.equal(page.alerts.length, 0);
    page.window.close();
});

test('an ordinary sign-in failure is shown inline and never in an alert', async () => {
    const page = await bootLoginPage({
        signIn: async () => ({ data: null, error: new Error('Invalid login credentials') })
    });
    page.setCredentials('trader@example.com', 'wrong-password');
    await page.submit();

    assert.match(page.status.textContent, /Invalid login credentials/);
    assert.equal(page.alerts.length, 0, 'browser alert() must no longer be the failure path');
    page.window.close();
});

test('the remember-me checkbox is read at submit time and passed to the client', async () => {
    const failingSignIn = async () => ({ data: null, error: new Error('stop before navigation') });

    const unchecked = await bootLoginPage({ signIn: failingSignIn });
    unchecked.setCredentials('trader@example.com', 'correct-horse-battery', false);
    await unchecked.submit();
    // The options object is built inside the page realm, so assert its field
    // directly rather than by structural equality across realms.
    assert.equal(unchecked.calls.clientOptions[0].rememberSession, false);
    unchecked.window.close();

    const checked = await bootLoginPage({ signIn: failingSignIn });
    checked.setCredentials('trader@example.com', 'correct-horse-battery', true);
    await checked.submit();
    assert.equal(checked.calls.clientOptions[0].rememberSession, true);
    checked.window.close();
});

test('login.js validates with the same email pattern as register.js', () => {
    const login = fs.readFileSync('assets/js/login.js', 'utf8');
    const register = fs.readFileSync('assets/js/register.js', 'utf8');

    assert.ok(register.includes(EMAIL_PATTERN_SOURCE), 'register.js is the reference implementation');
    assert.ok(login.includes(EMAIL_PATTERN_SOURCE), 'login.js must reuse the same pattern');
    assert.ok(!login.includes('alert('), 'the raw alert(error.message) failure path must be gone');
});

test('login.html drops the placeholder social buttons and keeps the status element', () => {
    const html = fs.readFileSync('pages/login.html', 'utf8');

    assert.ok(!html.includes('social-btn'), 'the non-functional OAuth buttons must be deleted');
    assert.ok(!html.includes('or continue with'), 'the divider left behind by those buttons must be deleted');
    assert.ok(!/onclick="alert\(/.test(html), 'no control may fall back to a browser alert');
    assert.match(html, /id="loginStatus"/, 'the inline status element must exist');
    assert.match(html, /id="rememberMe"/, 'the remember-me checkbox must be identifiable');
});
