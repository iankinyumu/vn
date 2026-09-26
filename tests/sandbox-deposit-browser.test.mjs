// Real-browser checks of the Daraja sandbox deposit page (pages/sandbox-deposit.html)
// in Microsoft Edge. supabase-js is replaced by tests/browser/fake-supabase.js
// and the funding-deposit Edge Function by a route, so nothing reaches a real
// backend or Daraja. Set BROWSER_EVIDENCE=1 to write screenshots to
// docs/browser-checks/.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist');
const EVIDENCE = process.env.BROWSER_EVIDENCE === '1' ? join(ROOT, 'docs', 'browser-checks') : null;
const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

let server, base, browser;

const TESTER = {
    available: true, environment: 'SANDBOX', label: 'Daraja Sandbox - test funds only', test_balance_usd: 0, spendable: false,
    min_usd: 5, max_usd_per_deposit: 500, max_usd_rolling_24h: 1000, max_deposits_rolling_24h: 3, quote_ttl_seconds: 300,
    kes_per_usd: 129.62, rate_date: '2026-09-25', rate_stale: false, test_msisdns: ['254708374149'],
};

// Stateful fakes: the payment is pending for the first poll, then confirmed, and
// the test balance follows the confirmation.
const initScript = ({ overview = TESTER, expiresInMs = 300000 } = {}) => `
    window.__PAYMENTS__ = [];
    window.__OWN__ = [];
    window.__POLLS__ = 0;
    window.__FAKE__ = { rpc: {
        // The page reads the overview and the payments together; the overview call comes first.
        funding_sandbox_overview: () => {
            if (window.__PAYMENTS__.length && ++window.__POLLS__ > 2) window.__PAYMENTS__.forEach((p) => { p.state = 'CONFIRMED'; p.status_message = 'Sandbox payment confirmed. The USD amount was added to your non-spendable sandbox test balance.'; });
            return { ...${JSON.stringify(overview)}, my_msisdns: [...window.__OWN__], test_balance_usd: window.__PAYMENTS__.some((p) => p.state === 'CONFIRMED') ? 5 : ${JSON.stringify(overview.test_balance_usd ?? 0)} };
        },
        funding_my_payments: () => window.__PAYMENTS__,
        funding_set_my_sandbox_msisdn: (args) => {
            const msisdn = String(args.p_msisdn).replace(/^0/, '254');
            if (!/^254(7|1)[0-9]{8}$/.test(msisdn)) return { __error: 'phone_invalid' };
            window.__OWN__ = window.__OWN__.filter((n) => n !== msisdn);
            if (args.p_enabled) window.__OWN__.push(msisdn);
            return { msisdn, enabled: args.p_enabled };
        },
        funding_create_deposit_quote: (args) => {
            const usd = Number(args.p_usd_amount);
            if (usd > 500) return { __error: 'amount_above_maximum' };
            const kes = Math.ceil(usd * 129.62 - 1e-9);
            return { quote_id: 'q-' + usd, environment: 'SANDBOX', usd_amount: usd, kes_due: kes, kes_rounding: Math.round((kes - usd * 129.62) * 100) / 100,
                kes_per_usd: 129.62, rate_date: '2026-09-25', rate_source: 'CBK', rate_version: 1, expires_at: new Date(Date.now() + ${expiresInMs}).toISOString() };
        },
    } };
`;

async function openPage({ overview, expiresInMs, deposit = null } = {}) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    const posted = [];
    await context.route('**/@supabase/supabase-js@2/dist/umd/supabase.js', (route) => route.fulfill({ contentType: 'text/javascript', body: readFileSync(join(ROOT, 'tests/browser/fake-supabase.js'), 'utf8') }));
    await context.route(/^https:\/\/(cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)\//, (route) => route.fulfill({ status: 200, body: '' }));
    await context.route('**/functions/v1/funding-deposit', async (route) => {
        const body = JSON.parse(route.request().postData() || '{}');
        posted.push({ body, headers: route.request().headers() });
        const answer = deposit ? deposit(body) : { status: 200, json: { payment_id: 'p-1', environment: 'SANDBOX', state: 'PENDING', status_message: 'Check your phone and enter your M-Pesa PIN to approve the payment.', usd_amount: 5, kes_due: 649 } };
        await route.fulfill({ status: answer.status, contentType: 'application/json', body: JSON.stringify(answer.json) });
    });
    await context.addInitScript({ content: initScript({ overview, expiresInMs }) });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
    await page.goto(`${base}/sandbox-deposit.html`);
    return { page, context, errors, posted };
}
const shot = async (page, name) => { if (EVIDENCE) await page.screenshot({ path: join(EVIDENCE, `${name}.png`), fullPage: true }); };

before(async () => {
    assert.ok(EDGE, 'Microsoft Edge is required for the real-browser checks');
    execFileSync(process.execPath, ['scripts/build-static.mjs'], { cwd: ROOT });
    server = createServer((req, res) => {
        const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^[/\\]+/, '');
        const file = join(DIST, path || 'index.html');
        if (!file.startsWith(DIST) || !existsSync(file)) { res.writeHead(404).end(); return; }
        res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' }).end(readFileSync(file));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: EDGE, headless: true });
    if (EVIDENCE) mkdirSync(EVIDENCE, { recursive: true });
});
after(async () => { await browser?.close(); server?.close(); });

test('sandbox deposit: a user who is not an allowlisted tester sees no form and no details', async () => {
    const { page, context, errors, posted } = await openPage({ overview: { available: false } });
    await page.locator('[data-sandbox-unavailable]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('[data-sandbox-available]').isVisible(), false);
    assert.equal(await page.locator('[data-sandbox-quote-form]').isVisible(), false);
    const calls = await page.evaluate(() => window.__RPC_LOG__.map((c) => c.name));
    assert.ok(calls.every((name) => name.startsWith('funding_')), `only funding RPCs: ${calls}`);
    assert.equal(posted.length, 0);
    assert.deepEqual(errors, []);
    await context.close();
});

test('sandbox deposit: quote shows locked KES, rate, rounding and expiry; the prompt goes pending then confirmed in the test balance only', async () => {
    const { page, context, errors, posted } = await openPage();
    await page.locator('[data-sandbox-available]').waitFor({ state: 'visible' });
    assert.equal((await page.locator('.sandbox-banner').textContent()).trim(), 'Daraja Sandbox - test funds only');
    assert.equal(await page.locator('[data-sandbox-balance]').textContent(), '0.00');
    assert.match(await page.locator('[data-sandbox-available]').textContent(), /non-spendable/);
    assert.deepEqual(await page.locator('[data-sandbox-phone] option').allTextContents(), ['2547*****149 (sandbox test number, never answers)']);
    assert.match(await page.locator('[data-sandbox-limits]').textContent(), /USD 5\.00 to USD 500\.00/);

    await page.fill('[data-sandbox-amount]', '500.01');
    await page.click('[data-sandbox-quote-button]');
    assert.match(await page.locator('[data-sandbox-status]').textContent(), /USD 5\.00 to USD 500\.00/);
    assert.equal(await page.locator('[data-sandbox-quote]').isVisible(), false);

    await page.fill('[data-sandbox-amount]', '5');
    await page.click('[data-sandbox-quote-button]');
    await page.locator('[data-sandbox-quote]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('[data-quote-usd]').textContent(), 'USD 5.00');
    assert.equal(await page.locator('[data-quote-kes]').textContent(), 'KES 649');
    assert.equal(await page.locator('[data-quote-rounding]').textContent(), 'KES 0.9');
    assert.match(await page.locator('[data-quote-rate]').textContent(), /KES 129\.62 per USD \(CBK, 2026-09-25\)/);
    assert.match(await page.locator('[data-quote-expiry]').textContent(), /^in [45]:\d\d$/);
    await shot(page, 'sandbox-deposit-quote');

    await page.click('[data-sandbox-send]');
    await page.locator('[data-sandbox-payment]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('[data-payment-state]').textContent(), 'Pending');
    assert.equal(posted.length, 1);
    assert.deepEqual(posted[0].body, { quote_id: 'q-5', phone: '254708374149', idempotency_key: 'sandbox-q-5' });
    assert.match(posted[0].headers.authorization, /^Bearer /);
    await page.evaluate(() => window.__PAYMENTS__.push({ payment_id: 'p-1', environment: 'SANDBOX', state: 'PENDING', usd_amount: 5, kes_due: 649,
        status_message: 'Check your phone', mpesa_receipt: null, receipt_verified: false, created_at: new Date().toISOString() }));
    await page.waitForFunction(() => document.querySelector('[data-payment-state]').textContent === 'Confirmed', null, { timeout: 30000 });
    assert.equal(await page.locator('[data-sandbox-balance]').textContent(), '5.00');
    const row = await page.locator('[data-sandbox-history] tr').first().allTextContents();
    assert.match(row[0], /5\.00.*KES 649.*Confirmed.*Not yet verified/s);
    await shot(page, 'sandbox-deposit-confirmed');
    const calls = await page.evaluate(() => [...new Set(window.__RPC_LOG__.map((c) => c.name))].sort());
    assert.deepEqual(calls, ['funding_create_deposit_quote', 'funding_my_payments', 'funding_sandbox_overview'], 'no trading RPC is touched');
    assert.deepEqual(errors, []);
    await context.close();
});

test('sandbox deposit: an expired quote cannot be sent, and a refused prompt shows the safe message and reference', async () => {
    let { page, context } = await openPage({ expiresInMs: -1000 });
    await page.locator('[data-sandbox-available]').waitFor({ state: 'visible' });
    await page.click('[data-sandbox-quote-button]');
    await page.locator('[data-sandbox-quote]').waitFor({ state: 'visible' });
    assert.match(await page.locator('[data-quote-expiry]').textContent(), /expired/);
    assert.equal(await page.locator('[data-sandbox-send]').isDisabled(), true);
    await context.close();

    ({ page, context } = await openPage({ deposit: () => ({ status: 409, json: { error: { code: 'deposit_limit_reached', message: 'This deposit would exceed your deposit limit for the last 24 hours.' }, request_id: 'ABCD1234' } }) }));
    await page.locator('[data-sandbox-available]').waitFor({ state: 'visible' });
    await page.click('[data-sandbox-quote-button]');
    await page.locator('[data-sandbox-quote]').waitFor({ state: 'visible' });
    await page.click('[data-sandbox-send]');
    await page.waitForFunction(() => /reference ABCD1234/.test(document.querySelector('[data-sandbox-status]').textContent));
    assert.match(await page.locator('[data-sandbox-status]').textContent(), /deposit limit/);
    assert.equal(await page.locator('[data-sandbox-payment]').isVisible(), false);
    await context.close();
});

test('sandbox deposit: a tester adds and removes their own number; the forms never fall through to a native submit', async () => {
    const html = readFileSync(join(ROOT, 'pages/sandbox-deposit.html'), 'utf8');
    assert.match(html, /data-sandbox-quote-button disabled>/, 'the quote button starts disabled');
    assert.match(html, /data-sandbox-own-add disabled>/, 'the add button starts disabled');
    const { page, context, errors, posted } = await openPage();
    await page.locator('[data-sandbox-available]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('[data-sandbox-quote-button]').isDisabled(), false);

    await page.fill('[data-sandbox-own-phone]', '12345');
    await page.click('[data-sandbox-own-add]');
    await page.waitForFunction(() => /Safaricom number such as/.test(document.querySelector('[data-sandbox-status]').textContent));
    await page.fill('[data-sandbox-own-phone]', '0712 345 678');
    await page.click('[data-sandbox-own-add]');
    await page.waitForFunction(() => /Number added/.test(document.querySelector('[data-sandbox-status]').textContent));
    assert.deepEqual(await page.locator('[data-sandbox-phone] option').allTextContents(), ['2547*****678 (your number)', '2547*****149 (sandbox test number, never answers)']);
    assert.equal(await page.locator('[data-sandbox-phone]').inputValue(), '254712345678');
    assert.equal(await page.locator('[data-sandbox-own-phone]').inputValue(), '');
    assert.equal(await page.locator('[data-sandbox-own-list] li').count(), 1);

    await page.click('[data-sandbox-quote-button]');
    await page.locator('[data-sandbox-quote]').waitFor({ state: 'visible' });
    await page.click('[data-sandbox-send]');
    await page.locator('[data-sandbox-payment]').waitFor({ state: 'visible' });
    assert.equal(posted[0].body.phone, '254712345678');

    await page.click('[data-sandbox-own-list] button');
    await page.waitForFunction(() => /Number removed/.test(document.querySelector('[data-sandbox-status]').textContent));
    assert.deepEqual(await page.locator('[data-sandbox-phone] option').allTextContents(), ['2547*****149 (sandbox test number, never answers)']);

    await page.evaluate(() => { document.querySelector('[data-sandbox-own-form]').requestSubmit(); document.querySelector('[data-sandbox-quote-form]').requestSubmit(); });
    await page.waitForTimeout(300);
    assert.ok(!page.url().includes('?'), 'no native GET submit');
    assert.deepEqual(errors, []);
    await context.close();
});
