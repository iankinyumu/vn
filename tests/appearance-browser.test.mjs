// Real-browser checks of the shared shell's appearance handling in Microsoft Edge, on the
// fake backend: light and dark follow the system setting (live), the collapsed side panel
// labels the focused item, and the layout mirrors in right-to-left text.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { EDGE, ROOT, openApp, startApp } from './helpers/browser-app.mjs';
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
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--chart-line').trim()), '#0a0a0a', 'charts read the light palette');
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

test('the Appearance menu overrides the system setting, persists, and works from the keyboard', async () => {
    const { page, context, errors } = await openApp(app, 'trade.html', { fake: tradeFake() });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForSelector('.app-rail .appearance-toggle');
    const toggle = page.locator('.app-rail .appearance-toggle');
    assert.equal(await toggle.getAttribute('aria-label'), 'Appearance: System');
    await toggle.click();
    const menu = page.locator('.appearance-menu');
    await menu.waitFor({ state: 'visible' });
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    assert.deepEqual(await menu.locator('[role="menuitemradio"]').allTextContents(), ['SystemMatch this device', 'Light', 'Dark']);
    // Focus moves in the popover's toggle event, which fires just after the menu shows.
    await page.waitForFunction(() => document.activeElement?.dataset.appearance === 'system', null, { timeout: 5000 });
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.documentElement.dataset.bsTheme === 'light');
    assert.equal(await menu.isHidden(), true, 'choosing closes the menu');
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('appearance-toggle')), true, 'focus returns to the button');
    assert.equal(await toggle.getAttribute('aria-label'), 'Appearance: Light');
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--label').trim()), '#0a0a0a', 'the light label is near-black');
    await page.reload();
    await page.waitForSelector('.app-rail .appearance-toggle');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.bsTheme), 'light', 'the choice survives a reload while the device is dark');
    await toggle.click();
    await menu.waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    assert.equal(await menu.isHidden(), true, 'Escape closes the menu');
    await toggle.click();
    await menu.locator('[data-appearance="system"]').click();
    await page.waitForFunction(() => document.documentElement.dataset.bsTheme === 'dark');
    assert.equal(await page.evaluate(() => localStorage.getItem('smartprofit:appearance')), null, 'System clears the stored override');
    assert.deepEqual(errors, []);
    await context.close();
});

test('signed-out pages stay light with no Appearance menu, whatever the saved choice or device', async () => {
    // Sign in, Create account and Forgot password redirect a signed-in session, so only their markup is checked.
    for (const path of ['login.html', 'register.html', 'forgot-password.html']) {
        assert.match(readFileSync(join(ROOT, 'pages', path), 'utf8'), /<html[^>]*data-appearance-fixed="light"/, `${path} is not fixed light`);
    }
    for (const path of ['index.html', 'terms.html', 'about.html']) {
        const { page, context, errors } = await openApp(app, path, { fake: tradeFake() });
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.evaluate(() => window.smartProfitAppearance.set('dark'));
        assert.equal(await page.evaluate(() => document.documentElement.dataset.bsTheme), 'light', `${path} went dark`);
        assert.equal(await page.locator('.appearance-toggle').count(), 0, `${path} offers an Appearance menu`);
        assert.deepEqual(errors, []);
        await context.close();
    }
});

test('the Appearance menu opens inside the screen from the phone drawer', async () => {
    const { page, context, errors } = await openApp(app, 'trade.html', { fake: tradeFake(), viewport: { width: 360, height: 740 } });
    await page.waitForSelector('[data-rail-open]');
    await page.click('[data-rail-open]');
    await page.waitForFunction(() => document.querySelector('[data-app-rail]').getBoundingClientRect().x === 0);
    await page.click('.app-rail .appearance-toggle');
    const box = await page.locator('.appearance-menu').boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 360 && box.y >= 0 && box.y + box.height <= 740, `drawer menu on screen (${JSON.stringify(box)})`);
    await page.locator('.appearance-menu [data-appearance="light"]').click();
    await page.waitForFunction(() => document.documentElement.dataset.bsTheme === 'light');
    assert.deepEqual(errors, []);
    await context.close();
});

test('scheduled engine changes are announced once, calmly, and can be dismissed until the schedule changes', async () => {
    const cutover = Date.UTC(2031, 0, 1);
    const fake = tradeFake() + `
        window.__FAKE__.rpc.get_engine_v3_status = [
            { index_code: 'SPI10', execution_mode: 'DEMO', engine_generation: 2, cutover_ms: ${cutover} },
            { index_code: 'SPI25', execution_mode: 'DEMO', engine_generation: 2, cutover_ms: ${cutover} },
            { index_code: 'SPI50', execution_mode: 'DEMO', engine_generation: 2, cutover_ms: null }];
        window.__FAKE__.rpc.get_engine_v3_rescales = [
            { index: 'SPI100', mode: 'DEMO', kind: 'rescale', factor: '10', status: 'scheduled', pause_from: '${new Date(cutover + 86400000 - 4500000).toISOString()}', resume_at: '${new Date(cutover + 86400000).toISOString()}' }];`;
    const { page, context, errors } = await openApp(app, 'trade.html', { fake });
    const notice = page.locator('[data-engine-notice]');
    await notice.waitFor({ state: 'visible' });
    const text = await notice.innerText();
    assert.match(text, /SP Index 10 and SP Index 25 move to the new price engine at 00:00 UTC on Wednesday,? 1 January 2031/);
    assert.match(text, /SP Index 100 is rescaled at 00:00 UTC on Thursday,? 2 January 2031: its price is multiplied by 10\. It pauses from 22:45 UTC/);
    assert.doesNotMatch(text, /SP Index 50/);
    assert.equal(await notice.getAttribute('role'), 'status');
    const close = page.getByRole('button', { name: 'Dismiss this notice' });
    const box = await close.boundingBox();
    assert.ok(box.width >= 44 && box.height >= 44, 'the close button is a 44px target');
    await close.click();
    assert.equal(await notice.isHidden(), true);
    await page.reload();
    await page.waitForSelector('[data-app-rail]');
    await page.waitForTimeout(800);
    assert.equal(await notice.isHidden(), true, 'a dismissed announcement stays dismissed');
    assert.deepEqual(errors, []);
    await context.close();
});
