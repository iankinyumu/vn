// Real-browser checks of the deposit and withdraw sheet (assets/js/deposit-sheet.js),
// the top bar that opens it and the Real account page (pages/sandbox-deposit.html),
// in Microsoft Edge. supabase-js is replaced by tests/browser/fake-supabase.js and
// the funding-deposit Edge Function by a route, so nothing reaches a real backend
// or Daraja. Set BROWSER_EVIDENCE=1 to write screenshots to docs/browser-checks/.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { EDGE, openApp, shot, startApp } from './helpers/browser-app.mjs';
import { tradeFake } from './browser/trade-fake.mjs';

const TESTER = {
    available: true, environment: 'SANDBOX', label: 'Daraja Sandbox - test funds only', test_balance_usd: 0, spendable: false,
    min_usd: 5, max_usd_per_deposit: 500, max_usd_rolling_24h: 1000, max_deposits_rolling_24h: 3, quote_ttl_seconds: 300,
    kes_per_usd: 129.62, rate_date: '2026-09-25', rate_stale: false, test_msisdns: ['254708374149'],
};

// Stateful funding fakes on top of the trading fake: a payment is pending for two polls, then confirmed.
const fake = ({ overview = TESTER, expiresInMs = 300000 } = {}) => tradeFake({ overview }) + `
    window.__PAYMENTS__ = [];
    window.__OWN__ = [];
    window.__POLLS__ = 0;
    Object.assign(window.__FAKE__.rpc, {
        funding_sandbox_overview: () => (${JSON.stringify(overview)}.available ? { ...${JSON.stringify(overview)}, my_msisdns: [...window.__OWN__],
            test_balance_usd: window.__PAYMENTS__.some((p) => p.state === 'CONFIRMED') ? 5 : ${JSON.stringify(overview.test_balance_usd ?? 0)} } : { available: false }),
        funding_my_payments: () => {
            if (window.__PAYMENTS__.length && ++window.__POLLS__ > 2) window.__PAYMENTS__.forEach((p) => { p.state = 'CONFIRMED'; p.status_message = 'The USD amount was added to your sandbox test balance.'; });
            return window.__PAYMENTS__;
        },
        funding_set_my_sandbox_msisdn: (args) => {
            const msisdn = String(args.p_msisdn).replace(/^0/, '254');
            if (!/^254(7|1)[0-9]{8}$/.test(msisdn)) return { __error: 'phone_invalid' };
            window.__OWN__ = window.__OWN__.filter((n) => n !== msisdn);
            if (args.p_enabled) window.__OWN__.push(msisdn);
            return { msisdn, enabled: args.p_enabled };
        },
        funding_create_deposit_quote: (args) => {
            const usd = Number(args.p_usd_amount);
            const kes = Math.ceil(usd * 129.62 - 1e-9);
            return { quote_id: 'q-' + usd, environment: 'SANDBOX', usd_amount: usd, kes_due: kes, kes_rounding: Math.round((kes - usd * 129.62) * 100) / 100,
                kes_per_usd: 129.62, rate_date: '2026-09-25', rate_source: 'CBK', rate_version: 1, expires_at: new Date(Date.now() + ${expiresInMs}).toISOString() };
        },
    });
`;

let app;
before(async () => { assert.ok(EDGE, 'Microsoft Edge is required for the real-browser checks'); app = await startApp(); });
after(async () => { await app?.close(); });

async function open({ overview, expiresInMs, deposit = null, path = 'sandbox-deposit.html', viewport } = {}) {
    const posted = [];
    const route = ['**/functions/v1/funding-deposit', async (request) => {
        const body = JSON.parse(request.request().postData() || '{}');
        posted.push({ body, headers: request.request().headers() });
        const answer = deposit ? deposit(body) : { status: 200, json: { payment_id: 'p-1', environment: 'SANDBOX', state: 'PENDING', status_message: 'Check your phone and enter your M-Pesa PIN.', usd_amount: 5, kes_due: 649 } };
        if (answer.status === 200) await request.request().frame().page().evaluate(() => window.__PAYMENTS__.push({ payment_id: 'p-1', environment: 'SANDBOX', state: 'PENDING', usd_amount: 5, kes_due: 649, status_message: 'Check your phone', mpesa_receipt: null, receipt_verified: false, created_at: new Date().toISOString() }));
        await request.fulfill({ status: answer.status, contentType: 'application/json', body: JSON.stringify(answer.json) });
    }];
    const opened = await openApp(app, path, { fake: fake({ overview, expiresInMs }), routes: [route], viewport });
    return { ...opened, posted };
}
const openSheet = async (page, tab = 'deposit') => { await page.click(`.app-topbar [data-funding-open="${tab}"]`); await page.locator('dialog[data-fund-sheet][open]').waitFor(); };

test('funding sheet: Deposit and Withdraw show in Real mode only', async () => {
    const practice = await open({ path: 'profile.html' });
    await practice.page.waitForFunction(() => document.querySelector('[data-mode-label]')?.textContent === 'Practice');
    assert.equal(await practice.page.locator('[data-funding-actions]').isHidden(), true, 'Practice shows funding buttons');
    assert.deepEqual(practice.errors, []);
    await practice.context.close();
    const real = await open();
    await real.page.waitForFunction(() => document.querySelector('[data-mode-label]')?.textContent === 'Real');
    assert.deepEqual(await real.page.locator('.app-topbar [data-funding-open]').allTextContents(), ['Deposit', 'Withdraw']);
    assert.equal(await real.page.locator('[data-funding-actions]').isVisible(), true);
    assert.deepEqual(real.errors, []);
    await real.context.close();
});

test('funding sheet: a non-tester who reaches the sheet sees closed deposits and withdrawals and no form', async () => {
    const { page, context, errors, posted } = await open({ path: 'profile.html', overview: { available: false } });
    await page.waitForFunction(() => document.querySelector('[data-mode-label]')?.textContent === 'Practice');
    assert.equal(await page.locator('[data-funding-actions]').isHidden(), true);
    const trigger = page.locator('.app-topbar [data-funding-open="deposit"]');
    await page.evaluate(() => { document.querySelector('[data-funding-actions]').hidden = false; });
    await trigger.click();
    await page.locator('dialog[data-fund-sheet][open]').waitFor();
    await page.locator('[data-fund-unavailable]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('[data-fund-unavailable]').textContent(), 'Deposits are not open on this account yet.');
    assert.equal(await page.locator('[data-fund-step="form"]').isVisible(), false);
    assert.equal(await page.locator('.fund-method-name').first().textContent(), 'Lipa na M-Pesa');
    await page.click('[data-fund-tab="withdraw"]');
    assert.equal(await page.locator('[data-fund-withdraw-closed]').textContent(), 'Withdrawals are not open yet.');
    await page.keyboard.press('Escape');
    await page.locator('dialog[data-fund-sheet]').waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.fundingOpen), 'deposit', 'focus returns to the button that opened the sheet');
    await page.click('.mode-switch-toggle');
    assert.equal(await page.locator('[data-account-id="real-preview"]').isDisabled(), false, 'Real is selectable as a view');
    assert.match(await page.locator('[data-account-id="real-preview"]').textContent(), /\$0\.00/);
    assert.equal(posted.length, 0);
    assert.deepEqual(errors, []);
    await context.close();
});

test('funding sheet: a tester is quoted locked KES, rate and expiry; the prompt goes pending then confirmed', async () => {
    const { page, context, errors, posted } = await open();
    await openSheet(page);
    await page.locator('[data-fund-step="form"]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('[data-fund-env]').textContent(), 'Real account');
    assert.deepEqual(await page.locator('[data-fund-phone] option').allTextContents(), ['2547*****149']);
    assert.deepEqual(await page.locator('.fund-chip').allTextContents(), ['$5', '$10', '$20', '$50', '$100', '$200', '$500']);

    await page.fill('[data-fund-amount]', '500.01');
    await page.click('[data-fund-continue]');
    assert.equal(await page.locator('[data-fund-status]').textContent(), 'Enter an amount from USD 5.00 to USD 500.00.');
    assert.equal(await page.locator('[data-fund-step="review"]').isVisible(), false);

    await page.click('.fund-chip:has-text("$5")');
    assert.equal(await page.locator('[data-fund-amount]').inputValue(), '5');
    assert.equal(await page.locator('[data-fund-estimate]').textContent(), '≈ KES 649 · USD 5.00–500.00');
    await page.click('[data-fund-continue]');
    await page.locator('[data-fund-step="review"]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('[data-quote-usd]').textContent(), 'USD 5.00');
    assert.equal(await page.locator('[data-quote-kes]').textContent(), 'KES 649');
    assert.equal(await page.locator('[data-quote-rate]').textContent(), 'KES 129.62 / USD');
    assert.equal(await page.locator('[data-quote-phone]').textContent(), '2547*****149');
    assert.match(await page.locator('[data-quote-expiry]').textContent(), /^[45]:\d\d$/);
    assert.equal(await page.locator('[data-fund-real-warning]').isVisible(), false, 'no real-money warning for the sandbox test number');
    await shot(page, 'funding-sheet-review');

    await page.click('[data-fund-send]');
    await page.locator('[data-fund-step="status"]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('[data-payment-state]').textContent(), 'Waiting for approval');
    assert.equal(posted.length, 1);
    assert.deepEqual(posted[0].body, { quote_id: 'q-5', phone: '254708374149', idempotency_key: 'sandbox-q-5' });
    assert.match(posted[0].headers.authorization, /^Bearer /);
    await page.waitForFunction(() => document.querySelector('[data-payment-state]').textContent === 'Deposit confirmed', null, { timeout: 30000 });
    await shot(page, 'funding-sheet-confirmed');
    const calls = await page.evaluate(() => [...new Set(window.__RPC_LOG__.filter((c) => c.name.startsWith('funding_') || c.name.startsWith('engine_buy')).map((c) => c.name))].sort());
    assert.deepEqual(calls, ['funding_create_deposit_quote', 'funding_my_payments', 'funding_sandbox_overview'], 'no purchase is made');
    assert.deepEqual(errors, []);
    await context.close();
});

test('funding sheet: an expired quote cannot be sent, and a refused prompt shows the safe message and reference', async () => {
    let { page, context } = await open({ expiresInMs: -1000 });
    await openSheet(page);
    await page.fill('[data-fund-amount]', '5');
    await page.click('[data-fund-continue]');
    await page.locator('[data-fund-step="review"]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('[data-quote-expiry]').textContent(), 'Expired');
    assert.equal(await page.locator('[data-fund-send]').isDisabled(), true);
    await context.close();

    ({ page, context } = await open({ deposit: () => ({ status: 409, json: { error: { code: 'deposit_limit_reached', message: 'This deposit would exceed your deposit limit for the last 24 hours.' }, request_id: 'ABCD1234' } }) }));
    await openSheet(page);
    await page.fill('[data-fund-amount]', '5');
    await page.click('[data-fund-continue]');
    await page.locator('[data-fund-step="review"]').waitFor({ state: 'visible' });
    await page.click('[data-fund-send]');
    await page.waitForFunction(() => /Reference ABCD1234/.test(document.querySelector('[data-fund-status]').textContent));
    assert.match(await page.locator('[data-fund-status]').textContent(), /deposit limit/);
    assert.equal(await page.locator('[data-fund-step="status"]').isVisible(), false);
    assert.equal(await page.locator('[data-fund-send]').isDisabled(), false, 'the same quote can be retried');
    await context.close();
});

test('funding sheet: a tester adds and removes their own number and is warned, with the amount, that real money moves', async () => {
    const { page, context, errors, posted } = await open();
    await openSheet(page);
    await page.locator('[data-fund-step="form"]').waitFor({ state: 'visible' });
    await page.click('[data-fund-add-toggle]');
    assert.match(await page.locator('[data-fund-add] .fund-warning').textContent(), /^Real money: a prompt to your own number runs on the live M-Pesa network\. Approving it with your PIN charges your real M-Pesa balance, and SmartProfit cannot refund it\.$/);
    await page.fill('[data-fund-add-input]', '12345');
    await page.click('[data-fund-add-save]');
    await page.waitForFunction(() => /Safaricom number such as/.test(document.querySelector('[data-fund-status]').textContent));
    await page.fill('[data-fund-add-input]', '0712 345 678');
    await page.click('[data-fund-add-save]');
    await page.waitForFunction(() => document.querySelector('[data-fund-status]').textContent === 'Number added.');
    assert.deepEqual(await page.locator('[data-fund-phone] option').allTextContents(), ['2547*****678 · your number', '2547*****149']);
    assert.equal(await page.locator('[data-fund-phone]').inputValue(), '254712345678');
    assert.equal(await page.locator('[data-fund-add]').isVisible(), false);

    await page.fill('[data-fund-amount]', '5');
    await page.click('[data-fund-continue]');
    await page.locator('[data-fund-step="review"]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('[data-fund-real-warning]').textContent(),
        'Real money: approving this prompt charges KES 649 from the real M-Pesa balance of 2547*****678. It goes to Safaricom\'s sandbox paybill 174379 and cannot be refunded by SmartProfit.');
    await page.click('[data-fund-back]');
    await page.selectOption('[data-fund-phone]', '254708374149');
    await page.click('[data-fund-continue]');
    await page.locator('[data-fund-step="review"]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('[data-fund-real-warning]').isVisible(), false, 'the sandbox test number carries no warning');
    await page.click('[data-fund-back]');
    await page.selectOption('[data-fund-phone]', '254712345678');
    await page.click('[data-fund-remove]');
    await page.waitForFunction(() => document.querySelector('[data-fund-status]').textContent === 'Number removed.');
    assert.deepEqual(await page.locator('[data-fund-phone] option').allTextContents(), ['2547*****149']);
    assert.equal(posted.length, 0);
    assert.deepEqual(errors, []);
    await context.close();
});

test('funding sheet: on a phone it is a bottom sheet over the page', async () => {
    const { page, context, errors } = await open({ viewport: { width: 390, height: 844 } });
    await openSheet(page);
    await page.locator('[data-fund-step="form"]').waitFor({ state: 'visible' });
    const box = await page.locator('dialog[data-fund-sheet]').boundingBox();
    assert.equal(Math.round(box.width), 390);
    assert.ok(Math.abs(box.y + box.height - 844) <= 1, `the sheet is anchored to the bottom edge (${box.y + box.height})`);
    await shot(page, 'funding-sheet-phone');
    assert.deepEqual(errors, []);
    await context.close();
});

test('Real account page: the switch shows Real with the balance, history is listed and Practice leads back to the dashboard', async () => {
    const { page, context, errors } = await open({ path: 'sandbox-deposit.html', overview: { ...TESTER, test_balance_usd: 12.5 } });
    await page.locator('[data-sandbox-available]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('[data-sandbox-balance]').textContent(), '12.50');
    assert.equal(await page.locator('#realBalanceLabel').textContent(), 'Balance', 'the Real page reads as a live account');
    await page.waitForFunction(() => document.querySelector('[data-mode-label]')?.textContent === 'Real' && document.querySelector('[data-mode-balance]').textContent === '$12.50');
    assert.equal(await page.locator('[data-sandbox-history]').textContent(), 'No deposits yet.');
    const footer = await page.locator('footer').textContent();
    assert.match(footer, /Trading digit contracts involves risk: only trade money you can afford to lose\./);
    assert.doesNotMatch(footer, /sandbox|testing|virtual/i, 'no test-environment wording in the footer');
    assert.ok(!/no real money/i.test(await page.content()), 'the page never claims that no real money moves');
    assert.equal(await page.evaluate(() => { try { return window.smartProfitAccount.get().mode; } catch (_) { return null; } }), null, 'no trading account is activated');
    await shot(page, 'real-account-page');
    assert.deepEqual(errors, []);
    await page.click('.mode-switch-toggle');
    await Promise.all([page.waitForURL(/dashboard\.html$/), page.click('[data-account-id="acc-demo"]')]);
    await context.close();
});

test('Real account page: a non-tester learns only that Real is not open', async () => {
    const { page, context, errors } = await open({ path: 'sandbox-deposit.html', overview: { available: false } });
    await page.locator('[data-sandbox-unavailable]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('[data-sandbox-available]').isVisible(), false);
    const calls = await page.evaluate(() => window.__RPC_LOG__.map((c) => c.name));
    assert.ok(calls.every((name) => name.startsWith('funding_') || ['get_engine_config', 'enroll_practice_account', 'list_my_accounts', 'get_account_summary', 'get_notification_unread_count', 'list_my_notifications', 'get_my_onboarding'].includes(name)), `only funding, account and notification RPCs: ${calls}`);
    assert.deepEqual(errors, []);
    await context.close();
});
