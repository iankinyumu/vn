// Real-browser checks of the trade page layout and interactions in Microsoft Edge,
// on the fake backend (tests/browser/trade-fake.mjs). Set BROWSER_EVIDENCE=1 to
// write screenshots to docs/browser-checks/.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { EDGE, openApp, shot, startApp } from './helpers/browser-app.mjs';
import { tradeFake } from './browser/trade-fake.mjs';

let app;
before(async () => { assert.ok(EDGE, 'Microsoft Edge is required for the real-browser checks'); app = await startApp(); });
after(async () => { await app?.close(); });

const live = (page) => page.waitForFunction(() => document.querySelector('[data-feed-state]').dataset.state === 'live' && document.querySelector('[data-digits] .current'));
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test('trade page on a desktop: side panel, top bar, market beside the ticket, pointer under the latest digit', async () => {
    const { page, context, errors } = await openApp(app, 'trade.html', { fake: tradeFake() });
    await live(page);
    assert.equal(await noSideScroll(page), true, 'the page scrolls sideways');
    const rail = await page.locator('[data-app-rail]').boundingBox();
    assert.equal(Math.round(rail.width), 64, 'the side panel starts thin');
    const market = await page.locator('.trade-market').boundingBox();
    const ticket = await page.locator('.trade-ticket').boundingBox();
    assert.ok(ticket.x > market.x + market.width - 1, 'the ticket sits beside the market');
    assert.equal(await page.locator('[data-mode-label]').textContent(), 'Practice');
    assert.equal(await page.locator('[data-funding-actions]').isHidden(), true, 'Deposit and Withdraw belong to Real mode');
    // The chart is the main view: the market reaches the bottom of the screen and trades start below the fold.
    const fold = await page.evaluate(() => ({ market: document.querySelector('.trade-market').getBoundingClientRect().bottom, activity: document.querySelector('.trade-activity').getBoundingClientRect().top, height: innerHeight }));
    assert.ok(fold.market > fold.height - 40 && fold.activity >= fold.height - 2, JSON.stringify(fold));
    await page.waitForFunction(() => document.querySelector('[data-mode-balance]').textContent === '$10,000.00');
    // The pointer is centred over the digit that is current when it is measured.
    const offset = await page.evaluate(() => {
        const current = document.querySelector('[data-digits] .current .digit-ring').getBoundingClientRect();
        const pointer = document.querySelector('[data-digit-pointer]').getBoundingClientRect();
        return Math.abs((pointer.left + pointer.width / 2) - (current.left + current.width / 2));
    });
    assert.ok(offset <= 2, `the pointer is ${offset}px off the latest digit`);
    await page.click('[data-rail-expand]');
    await page.waitForFunction(() => document.querySelector('[data-app-rail]').getBoundingClientRect().width === 220);
    assert.equal(await page.locator('.app-rail-link.active .app-rail-text').isVisible(), true);
    await page.click('[data-rail-expand]');
    await shot(page, 'trade-desktop');
    assert.deepEqual(errors, []);
    await context.close();
});

test('trade page: buying a side debits the balance, tracks the trade and keeps the other side ready', async () => {
    const { page, context, errors } = await openApp(app, 'trade.html', { fake: tradeFake() });
    await live(page);
    await page.click('.family-tab:has-text("Over / Under") span');
    await page.click('.barrier-choice:has(input[value="3"]) span');
    await page.waitForFunction(() => document.querySelector('[data-side="a"] [data-side-payout]').textContent.startsWith('$'));
    await page.click('[data-side="a"]');
    await page.waitForFunction(() => /^Over 3 bought/.test(document.querySelector('[data-trade-status]').textContent));
    await page.waitForFunction(() => document.querySelector('[data-mode-balance]').textContent === '$9,999.00');
    assert.equal(await page.locator('[data-open-count]').textContent(), '1');
    assert.equal(await page.locator('[data-side="b"]').isDisabled(), false);
    await shot(page, 'trade-bought');
    assert.deepEqual(errors, []);
    await context.close();
});

test('trade page on a phone: drawer navigation, one column and the action bar pinned to the bottom', async () => {
    const { page, context, errors } = await openApp(app, 'trade.html', { fake: tradeFake(), viewport: { width: 390, height: 844 } });
    await live(page);
    assert.equal(await noSideScroll(page), true, 'the page scrolls sideways on a phone');
    assert.equal(await page.locator('[data-app-rail]').isVisible(), true);
    assert.ok((await page.locator('[data-app-rail]').boundingBox()).x < 0, 'the drawer is off screen until opened');
    const actions = await page.locator('[data-trade-actions]').boundingBox();
    assert.ok(actions.y >= 0 && actions.y + actions.height <= 844, 'the action bar is on screen without scrolling');
    // On a shorter screen the ticket runs past the fold and the action bar sticks to the bottom edge.
    await page.setViewportSize({ width: 390, height: 640 });
    await page.waitForTimeout(100);
    const pinned = await page.locator('[data-trade-actions]').boundingBox();
    assert.ok(Math.abs(pinned.y + pinned.height - 640) <= 1, `the action bar is pinned to the bottom (${pinned.y + pinned.height})`);
    await page.setViewportSize({ width: 390, height: 844 });
    for (const selector of ['[data-mode-balance]', '[data-rail-open]']) {
        const box = await page.locator(selector).boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= 390, `${selector} is cut off`);
    }
    await shot(page, 'trade-phone');
    await page.click('[data-rail-open]');
    await page.waitForFunction(() => document.querySelector('[data-app-rail]').getBoundingClientRect().x === 0);
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('app-rail-link')), true, 'focus moves into the drawer');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('[data-app-rail]').getBoundingClientRect().x < 0);
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.railOpen !== undefined), true, 'focus returns to the menu button');
    assert.deepEqual(errors, []);
    await context.close();
});

test('trade page: a Lottie loader covers the chart while the market loads, and a CSS mark stands in if the player cannot load', async () => {
    const slow = tradeFake() + 'window.__FAKE__.delay = { get_engine_config: 1500, get_recent_ticks: 3000 };';
    for (const blocked of [false, true]) {
        const routes = blocked ? [['**/vendor/lottie/**', (route) => route.abort()]] : [];
        const { page, context, errors } = await openApp(app, 'trade.html', { fake: slow, routes });
        const loader = page.locator('.chart-frame [data-loader]');
        await loader.waitFor({ state: 'visible' });
        assert.equal(await page.locator('[data-mode-label]').count(), 0, 'the loader waited for the account to load');
        assert.equal(await loader.getAttribute('role'), 'status');
        assert.equal(await loader.textContent(), 'Loading market');
        if (blocked) await page.waitForTimeout(500);
        else await page.locator('.chart-frame .sp-loader-art svg').waitFor();
        assert.equal(await page.locator('.sp-loader-art').evaluate((node) => node.hasAttribute('data-fallback')), blocked);
        if (!blocked) await shot(page, 'trade-loading');
        await live(page);
        assert.equal(await page.locator('[data-loader]').count(), 0, 'the loader stayed after the market loaded');
        assert.deepEqual(errors.filter((error) => !/lottie|vendor|ERR_FAILED/i.test(error)), []);
        await context.close();
    }
});

test('trade page: the chart switches between line, candles and OHLC, and the choice is remembered', async () => {
    const { page, context, errors } = await openApp(app, 'trade.html', { fake: tradeFake() });
    await live(page);
    assert.equal(await page.locator('[data-chart-period-wrap]').isHidden(), true, 'a line chart has no candle period');
    await page.click('.chart-choice:has(input[value="candles"]) > span');
    assert.equal(await page.locator('[data-chart-period-wrap]').isVisible(), true);
    await page.selectOption('[data-chart-period]', '10000');
    const drawn = () => page.evaluate(() => { const canvas = document.querySelector('[data-index-chart]'); const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data; let lit = 0; for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) lit++; return lit; });
    await page.waitForTimeout(300);
    assert.ok(await drawn() > 0, 'nothing was drawn for candles');
    await shot(page, 'trade-candles');
    await page.click('.chart-choice:has(input[value="ohlc"]) > span');
    await page.waitForTimeout(300);
    assert.ok(await drawn() > 0, 'nothing was drawn for OHLC bars');
    assert.equal(await page.evaluate(() => localStorage.getItem('smartprofit:chart')), '{"style":"ohlc","period":10000}');
    await page.reload();
    await live(page);
    assert.equal(await page.locator('input[name="chartStyle"][value="ohlc"]').isChecked(), true, 'the chart type was not remembered');
    assert.equal(await page.locator('[data-chart-period]').inputValue(), '10000');
    assert.deepEqual(errors, []);
    await context.close();
});
