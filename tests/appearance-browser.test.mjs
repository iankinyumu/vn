// Real-browser checks of the shared shell's appearance handling in Microsoft Edge, on the
// fake backend: light and dark follow the system setting (live), the collapsed side panel
// labels the focused item, and the layout mirrors in right-to-left text.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { EDGE, openApp, startApp } from './helpers/browser-app.mjs';
import { tradeFake } from './browser/trade-fake.mjs';

let app;
before(async () => { assert.ok(EDGE, 'Microsoft Edge is required for the real-browser checks'); app = await startApp(); });
after(async () => { await app?.close(); });

const luminance = (page, selector) => page.evaluate((target) => {
    const [r, g, b] = getComputedStyle(document.querySelector(target)).backgroundColor.match(/[\d.]+/g).map(Number);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}, selector);

test('appearance follows the system setting, including a change while the page is open', async () => {
    const { page, context, errors } = await openApp(app, 'trade.html', { fake: tradeFake() });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.reload();
    await page.waitForSelector('[data-app-rail]');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.bsTheme), 'light');
    assert.ok(await luminance(page, 'body') > 0.9, 'the light page background is light');
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--chart-line').trim()), '#0a64a0', 'charts read the light palette');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForFunction(() => document.documentElement.dataset.bsTheme === 'dark');
    assert.ok(await luminance(page, 'body') < 0.1, 'the page switched to dark without a reload');
    assert.deepEqual(errors, []);
    await context.close();
});

test('the collapsed side panel labels the item under keyboard focus, and Escape dismisses it', async () => {
    const { page, context, errors } = await openApp(app, 'trade.html', { fake: tradeFake() });
    await page.waitForSelector('[data-app-rail]');
    await page.evaluate(() => document.querySelector('.app-rail-brand').focus());
    await page.keyboard.press('Tab');
    const tip = page.locator('.app-rail-tip');
    await tip.waitFor({ state: 'visible' });
    assert.equal(await tip.textContent(), 'Dashboard');
    const [link, label] = [await page.locator('.app-rail-link').first().boundingBox(), await tip.boundingBox()];
    assert.ok(label.x >= link.x + link.width, 'the label sits beside the panel, not clipped inside it');
    assert.equal(await tip.getAttribute('aria-hidden'), 'true', 'the label repeats the link text, so assistive technology skips it');
    await page.keyboard.press('Escape');
    assert.equal(await tip.isHidden(), true, 'Escape dismisses the label');
    assert.deepEqual(errors, []);
    await context.close();
});

test('in right-to-left text the side panel moves to the right edge and the content clears it', async () => {
    const { page, context, errors } = await openApp(app, 'trade.html', { fake: tradeFake() });
    await page.waitForSelector('[data-app-rail]');
    await page.evaluate(() => { document.documentElement.dir = 'rtl'; });
    const rail = await page.locator('[data-app-rail]').boundingBox();
    const width = page.viewportSize().width;
    assert.ok(Math.abs(rail.x + rail.width - width) <= 1, `the panel is on the right (${rail.x}+${rail.width})`);
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).paddingRight), '64px', 'the content leaves room for the panel on the right');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, 'no sideways scroll');
    assert.deepEqual(errors, []);
    await context.close();
});
