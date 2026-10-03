// Real-browser checks of the page and section loaders (assets/js/loader.js) in Microsoft Edge
// on the fake backend. Set BROWSER_EVIDENCE=1 to write screenshots to docs/browser-checks/.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { EDGE, openApp, shot, startApp } from './helpers/browser-app.mjs';
import { tradeFake } from './browser/trade-fake.mjs';

let app;
before(async () => { assert.ok(EDGE, 'Microsoft Edge is required for the real-browser checks'); app = await startApp(); });
after(async () => { await app?.close(); });

const slow = tradeFake() + `window.__FAKE__.delay = { get_engine_config: 1500, funding_sandbox_overview: 1500 };
    window.__FAKE__.rpc.get_account_stats = { wins: 0, losses: 0, voids: 0, open: 0, net_result: 0, currency: 'USD' };`;

test('every signed-in page that loads data is covered by a labelled loader until its data is in', async () => {
    for (const [path, label] of [['dashboard.html', 'Loading dashboard'], ['profile.html', 'Loading profile'], ['fairness.html', 'Loading verifier'], ['sandbox-deposit.html', 'Loading account']]) {
        const { page, context, errors } = await openApp(app, path, { fake: slow });
        const loader = page.locator('.sp-page-loader [data-loader]');
        await loader.waitFor({ state: 'visible' });
        assert.equal(await loader.textContent(), label, path);
        assert.equal(await loader.getAttribute('role'), 'status');
        await page.waitForFunction(() => document.querySelector('main')?.getAttribute('aria-busy') === 'true');
        const cover = await page.locator('.sp-page-loader').boundingBox();
        assert.ok(cover.x >= 63 && cover.y >= 51, `${path}: the side panel and top bar stay uncovered (${cover.x}, ${cover.y})`);
        if (path === 'dashboard.html') await shot(page, 'page-loader-dashboard');
        await page.waitForFunction(() => !document.querySelector('.sp-page-loader'), null, { timeout: 15000 });
        assert.equal(await page.locator('main').getAttribute('aria-busy'), null, `${path}: main stayed busy`);
        assert.deepEqual(errors, [], path);
        await context.close();
    }
});

test('a page whose data never answers is uncovered after the time limit', async () => {
    const hung = tradeFake() + 'window.__FAKE__.delay = { get_engine_config: 60000 };';
    const { page, context } = await openApp(app, 'fairness.html', { fake: hung });
    await page.locator('.sp-page-loader').waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('.sp-page-loader'), null, { timeout: 25000 });
    await context.close();
});
