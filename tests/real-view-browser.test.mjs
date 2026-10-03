// Real-browser checks of the Real view: until Real deposits and withdrawals are connected, Real is
// selectable from the account menu with a zero balance, the market keeps running, and buying,
// depositing and withdrawing stay disabled. Nothing is ever sent to the server for the view.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { EDGE, openApp, startApp } from './helpers/browser-app.mjs';
import { tradeFake } from './browser/trade-fake.mjs';

const extras = `
    Object.assign(window.__FAKE__.rpc, {
        get_notification_unread_count: () => 0,
        list_my_notifications: () => ({ announcements: [], notifications: [], unread: 0 }),
        get_my_onboarding: () => ({ status: 'completed', skipped: false, data: {} }),
        get_account_stats: () => ({ wins: 0, losses: 0, voids: 0, open: 0, net_result: 0, currency: 'USD' }),
    });
`;

let app;
before(async () => { assert.ok(EDGE, 'Microsoft Edge is required for the real-browser checks'); app = await startApp(); });
after(async () => { await app?.close(); });

const chooseReal = async (page) => {
    await page.click('.mode-switch-toggle');
    await page.click('[data-account-id="real-preview"]');
    await page.waitForFunction(() => document.querySelector('[data-mode-label]')?.textContent === 'Real' && document.querySelector('[data-mode-balance]')?.textContent === '$0.00');
};

test('trade page: Real shows the live market, but buying, depositing and withdrawing are disabled', async () => {
    const { page, context, errors } = await openApp(app, 'trade.html', { fake: tradeFake({}) + extras });
    try {
        await page.locator('[data-side]:not([disabled]), .trade-side:not([disabled])').first().waitFor().catch(() => {});
        await chooseReal(page);
        const gate = page.locator('[data-v3-gate]');
        await gate.waitFor({ state: 'visible' });
        assert.match(await gate.textContent(), /Real trading opens soon/);
        const sides = await page.locator('[data-trade-actions] button').evaluateAll((buttons) => buttons.map((button) => button.disabled));
        assert.ok(sides.length >= 2 && sides.every(Boolean), 'both buy buttons are disabled');
        for (const kind of ['deposit', 'withdraw']) {
            const button = page.locator(`.app-topbar [data-funding-open="${kind}"]`);
            assert.equal(await button.isVisible(), true, `${kind} shows in Real`);
            assert.equal(await button.isDisabled(), true, `${kind} is disabled`);
            assert.match(await button.getAttribute('aria-label'), /coming soon/);
        }
        const leaked = await page.evaluate(() => (window.__RPC_LOG__ || []).filter((call) => call.args?.p_account_id === 'real-preview').map((call) => call.name));
        assert.deepEqual(leaked, [], 'no RPC is made for the Real view');
        // Back to Practice: buying and the funding buttons' state return.
        await page.click('.mode-switch-toggle');
        await page.click('[data-account-id]:not([data-account-id="real-preview"])');
        await page.waitForFunction(() => document.querySelector('[data-mode-label]')?.textContent === 'Practice');
        assert.equal(await page.locator('[data-funding-actions]').isHidden(), true);
        assert.equal(await gate.isHidden(), true);
        assert.deepEqual(errors, []);
    } finally { await context.close(); }
});

test('dashboard: Real shows a zero balance and no contracts', async () => {
    const { page, context, errors } = await openApp(app, 'dashboard.html', { fake: tradeFake({}) + extras });
    try {
        await page.locator('.mode-switch-toggle:not([disabled])').waitFor();
        await chooseReal(page);
        await page.waitForFunction(() => document.querySelector('[data-practice-balance]')?.textContent === 'USD 0.00');
        assert.match(await page.locator('[data-contract-rows]').textContent(), /No contracts yet/);
        assert.deepEqual(errors.filter((text) => !/favicon/.test(text)), []);
    } finally { await context.close(); }
});
