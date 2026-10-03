import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';

/* Legal pages, the sign-up acceptance tick, cookie consent, form hygiene and the
 * security headers. Static checks read the shipped files; behaviour checks run the
 * real scripts in jsdom with no network. */

const pages = fs.readdirSync('pages').filter((name) => name.endsWith('.html'));
const read = (path) => fs.readFileSync(path, 'utf8');
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('the four legal documents exist as public pages with one h1 and the shared shell', () => {
    for (const name of ['terms.html', 'privacy.html', 'cookies.html', 'risk.html']) {
        const html = read(`pages/${name}`);
        const document = new JSDOM(html).window.document;
        assert.equal(document.querySelectorAll('h1').length, 1, `${name} has one h1`);
        assert.ok(document.querySelector('main'), `${name} has a main landmark`);
        assert.equal(document.body.dataset.shellSurface, 'public', `${name} is public, readable before sign-in`);
        assert.ok(html.includes('assets/js/shell.js') && html.includes('data-shell-footer'), `${name} uses the shared shell`);
        assert.ok(!html.includes('requireAuth'), `${name} must not require sign-in`);
        assert.match(html, /Version 2026-10-03/, `${name} states its version`);
    }
});

test('sign-up requires an explicit, unticked acceptance with working links to the documents', () => {
    const document = new JSDOM(read('pages/register.html')).window.document;
    const box = document.getElementById('termsCheck');
    assert.ok(box && box.type === 'checkbox' && box.required && !box.checked, 'an unticked required checkbox');
    assert.match(document.querySelector('label[for="termsCheck"]').textContent, /18 or older/);
    const links = [...document.querySelectorAll('#termsLinks a')].map((a) => a.getAttribute('href'));
    assert.deepEqual(links, ['terms.html', 'privacy.html', 'risk.html']);
    for (const anchor of document.querySelectorAll('#termsLinks a')) assert.equal(anchor.rel, 'noopener');
    assert.equal(box.getAttribute('aria-describedby'), 'termsLinks');
});

test('no page has dead "#" links or inline event handlers', () => {
    for (const name of pages) {
        const html = read(`pages/${name}`);
        assert.ok(!/href="#"/.test(html), `${name} has an href="#" link`);
        assert.ok(!/\son[a-z]+="/i.test(html), `${name} has an inline event handler (blocked by the CSP)`);
    }
});

test('every page loads consent.js before theme.js, and every CDN tag carries an integrity hash', () => {
    for (const name of pages) {
        const html = read(`pages/${name}`);
        const consent = html.indexOf('assets/js/consent.js');
        assert.ok(consent > 0 && consent < html.indexOf('assets/js/theme.js'), `${name} loads consent.js first`);
        for (const tag of html.match(/<(?:link|script)[^>]*https:\/\/cdnjs[^>]*>/g) || []) {
            assert.match(tag, /integrity="sha384-[A-Za-z0-9+/=]+" crossorigin="anonymous"/, `${name}: ${tag.slice(0, 80)}`);
        }
    }
    for (const script of ['assets/js/auth.js', 'assets/js/staff-auth.js']) {
        const source = read(script);
        assert.match(source, /supabase-js@2\.\d+\.\d+\/dist\/umd\/supabase\.js/, `${script} pins supabase-js to one release`);
        assert.match(source, /sha384-[A-Za-z0-9+/=]{64}/, `${script} checks supabase-js with SRI`);
    }
});

test('the footers link every legal page and offer cookie settings', () => {
    const dom = new JSDOM('<!doctype html><body data-shell-surface="public"><div data-shell-header></div><div data-shell-footer></div></body>', { runScripts: 'outside-only', url: 'https://example.test/pages/index.html' });
    dom.window.eval(read('assets/js/shell.js'));
    dom.window.smartProfitShell.mount();
    const footer = dom.window.document.querySelector('[data-shell-footer]');
    for (const href of ['terms.html', 'privacy.html', 'cookies.html', 'risk.html']) assert.ok(footer.querySelector(`a[href="${href}"]`), `public footer links ${href}`);
    assert.ok(footer.querySelector('button[data-consent-open]'), 'public footer has Cookie settings');
    assert.equal(footer.querySelectorAll('h6').length, 0, 'footer headings no longer skip levels');

    const app = new JSDOM('<!doctype html><body data-shell-surface="app"><div data-shell-footer></div></body>', { runScripts: 'outside-only', url: 'https://example.test/pages/dashboard.html' });
    app.window.eval(read('assets/js/shell.js'));
    app.window.smartProfitShell.mount();
    const appFooter = app.window.document.querySelector('[data-shell-footer]');
    for (const href of ['terms.html', 'privacy.html', 'cookies.html', 'risk.html']) assert.ok(appFooter.querySelector(`a[href="${href}"]`), `app footer links ${href}`);
    assert.ok(appFooter.querySelector('button[data-consent-open]'));
});

async function consentPage(stored = {}) {
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'https://example.test/pages/index.html', runScripts: 'outside-only' });
    for (const [key, value] of Object.entries(stored)) dom.window.localStorage.setItem(key, value);
    dom.window.eval(read('assets/js/consent.js'));
    if (dom.window.document.readyState === 'loading') await new Promise((resolve) => dom.window.document.addEventListener('DOMContentLoaded', resolve, { once: true }));
    return dom.window;
}

test('without a choice, the banner shows and preferences are not written to the device', async () => {
    const window = await consentPage({ 'smartprofit:appearance': 'light' });
    const banner = window.document.querySelector('[data-consent-banner]');
    assert.ok(banner && !banner.hidden, 'the banner asks');
    const [essential, all] = banner.querySelectorAll('button');
    assert.equal(essential.className, all.className, 'both choices look the same');
    assert.equal(window.localStorage.getItem('smartprofit:appearance'), null, 'a pre-consent preference leaves the device');
    assert.equal(window.smartProfitConsent.store.getItem('smartprofit:appearance'), 'light', 'but still applies on this page');
    window.smartProfitConsent.store.setItem('smartprofit:chart', '{"style":"ohlc"}');
    assert.equal(window.localStorage.getItem('smartprofit:chart'), null);
});

test('allowing preferences persists them; choosing essential only removes them', async () => {
    const window = await consentPage();
    window.smartProfitConsent.store.setItem('smartprofit:rail-expanded', '1');
    window.document.querySelector('[data-consent-choice="preferences"]').click();
    assert.equal(window.localStorage.getItem('smartprofit:rail-expanded'), '1', 'the setting chosen before consent is kept');
    assert.equal(JSON.parse(window.localStorage.getItem('smartprofit:consent')).preferences, true);
    assert.match(window.document.cookie, /(?:^|; )sp_consent=v1\.preferences\.\d+/, 'the choice is a real first-party cookie');
    assert.ok(window.document.querySelector('[data-consent-banner]').hidden);

    window.smartProfitConsent.save({ preferences: false });
    assert.equal(window.localStorage.getItem('smartprofit:rail-expanded'), null, 'withdrawing consent clears preferences');
    assert.equal(window.smartProfitConsent.allows('preferences'), false);
    assert.equal(window.smartProfitConsent.allows('essential'), true);
    assert.match(window.document.cookie, /sp_consent=v1\.essential\.\d+/);
});

test('a stored choice is respected and the banner stays closed', async () => {
    const window = await consentPage({ 'smartprofit:consent': JSON.stringify({ v: 1, preferences: true, at: 'x' }), 'smartprofit:appearance': 'dark' });
    assert.equal(window.document.querySelector('[data-consent-banner]'), null);
    assert.equal(window.localStorage.getItem('smartprofit:appearance'), 'dark');
});

test('the cookie policy lists every preference key that consent.js manages', async () => {
    const window = await consentPage();
    const html = read('pages/cookies.html');
    for (const key of window.smartProfitConsent.preferenceKeys) assert.ok(html.includes(`<code>${key}</code>`), `cookies.html documents ${key}`);
});

test('form-guard strips control and invisible characters and limits repeated attempts', () => {
    const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://example.test/', runScripts: 'outside-only' });
    dom.window.eval(read('assets/js/form-guard.js'));
    const { clean, limiter } = dom.window.smartProfitForms;
    assert.equal(clean('  Ada​ ‮Love\u0000lace\n ', 50), 'Ada Lovelace');
    assert.equal(clean('x'.repeat(80), 50).length, 50);
    const limit = limiter('t', { max: 3, windowMs: 60000, lockMs: 60000 });
    limit.record(); limit.record();
    assert.equal(limit.wait(), 0);
    limit.record();
    assert.ok(limit.wait() > 0, 'the third failure pauses');
    limit.reset();
    assert.equal(limit.wait(), 0);
});

test('sign-up refuses an unticked acceptance and records the accepted version when ticked', async () => {
    const html = read('pages/register.html').replace(/<script[\s\S]*?<\/script>/g, '');
    const dom = new JSDOM(html, { url: 'https://example.test/pages/register.html', runScripts: 'outside-only' });
    const { window } = dom;
    const signUps = [];
    window.getSupabaseClient = async () => ({ auth: { signUp: async (payload) => { signUps.push(payload); return { data: { session: null }, error: null }; } } });
    window.redirectIfAuthenticated = () => {};
    window.eval(read('assets/js/form-guard.js'));
    window.eval(read('assets/js/register.js'));
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
    const $ = (id) => window.document.getElementById(id);
    Object.entries({ firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com', username: 'ada_l', password: 'Analytical1', confirmPassword: 'Analytical1' }).forEach(([id, value]) => { $(id).value = value; });
    const form = $('registerForm');

    await window.handleRegister({ preventDefault() {}, currentTarget: form });
    assert.equal(signUps.length, 0, 'no account without acceptance');
    assert.equal($('termsCheck').getAttribute('aria-invalid'), 'true');
    assert.match($('registerStatus').textContent, /18 or older/);

    $('username').value = 'bad name<script>';
    $('termsCheck').checked = true;
    await window.handleRegister({ preventDefault() {}, currentTarget: form });
    assert.equal(signUps.length, 0, 'a username with markup characters is refused');
    assert.equal($('username').getAttribute('aria-invalid'), 'true');

    $('username').value = 'ada_l';
    await window.handleRegister({ preventDefault() {}, currentTarget: form });
    await settle();
    assert.equal(signUps.length, 1);
    assert.equal(signUps[0].options.data.terms_version, '2026-10-03');
    assert.ok(Date.parse(signUps[0].options.data.terms_accepted_at));
});

test('vercel.json sends a strict CSP and the standard security headers', () => {
    const config = JSON.parse(read('vercel.json'));
    const all = config.headers.find((rule) => rule.source === '/(.*)').headers;
    const value = (key) => all.find((header) => header.key === key)?.value || '';
    const csp = value('Content-Security-Policy');
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /object-src 'none'/);
    const scriptSrc = csp.split(';').find((part) => part.trim().startsWith('script-src'));
    assert.ok(!scriptSrc.includes("'unsafe-inline'") && !scriptSrc.includes("'unsafe-eval'"), 'no inline or eval scripts');
    // The only inline scripts on the site are identical requireAuth() calls; the CSP allows exactly that hash.
    const inline = new Set(pages.flatMap((name) => [...read(`pages/${name}`).matchAll(/<script>([^<]*)<\/script>/g)].map((match) => match[1])));
    for (const body of inline) assert.ok(scriptSrc.includes(`'sha256-${createHash('sha256').update(body).digest('base64')}'`), `CSP allows inline script ${body}`);
    for (const key of ['Strict-Transport-Security', 'X-Content-Type-Options', 'X-Frame-Options', 'Referrer-Policy', 'Permissions-Policy']) assert.ok(value(key), `${key} is set`);
    const staff = config.headers.find((rule) => rule.source.includes('admin'));
    assert.ok(staff.headers.some((header) => header.key === 'X-Robots-Tag' && /noindex/.test(header.value)), 'staff pages are not indexed');
});

test('the build publishes no source art, notes or secrets', () => {
    const source = read('scripts/build-static.mjs');
    assert.match(source, /layered-asset/);
    const ignore = read('.vercelignore');
    for (const entry of ['.env', '.env.*', '.sandbox', 'supabase']) assert.ok(ignore.split(/\r?\n/).includes(entry), `.vercelignore lists ${entry}`);
});
