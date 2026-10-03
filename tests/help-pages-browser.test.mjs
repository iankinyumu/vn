// Real-browser checks that the help pages (guides, FAQ, contact) open inside the signed-in shell, so a
// customer never lands back on the public landing header, in light and dark, at desktop and 320px.
// Set BROWSER_EVIDENCE=1 to write screenshots to docs/browser-checks/.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { EDGE, openApp, shot, startApp } from './helpers/browser-app.mjs';
import { tradeFake } from './browser/trade-fake.mjs';

const fake = () => tradeFake({}) + `
    Object.assign(window.__FAKE__.rpc, {
        get_notification_unread_count: () => 0,
        list_my_notifications: () => ({ announcements: [], notifications: [], unread: 0 }),
        list_support_tickets: () => ({ items: [], next: null }),
    });
`;

let app;
before(async () => { assert.ok(EDGE, 'Microsoft Edge is required for the real-browser checks'); app = await startApp(); });
after(async () => { await app?.close(); });

const PAGES = [['faq.html', 'faq'], ['contact.html', 'contact'], ['blog.html', 'blog'], ['guide-settlement.html', 'blog']];

for (const scheme of ['light', 'dark']) {
    for (const viewport of [{ width: 1366, height: 860 }, { width: 320, height: 640 }]) {
        test(`help pages keep the signed-in shell in ${scheme} mode at ${viewport.width}px`, async () => {
            for (const [path, key] of PAGES) {
                const { page, context, errors } = await openApp(app, path, { fake: fake(), viewport });
                try {
                    await page.emulateMedia({ colorScheme: scheme });
                    await page.locator('.app-topbar').waitFor();
                    assert.equal(await page.locator('.premium-header').count(), 0, `${path} shows the landing header`);
                    assert.equal(await page.locator('.app-rail').count(), 1, `${path} has no side panel`);
                    assert.equal(await page.locator(`.app-rail a[href="${path === 'guide-settlement.html' ? 'blog.html' : path}"][aria-current="page"]`).count(), 1, `${path} is not marked current in the rail`);
                    assert.ok(await page.locator('.app-topbar [data-notify-open]').count() === 1, `${path} has no notification button`);
                    await page.locator('.app-topbar .mode-switch-label').waitFor();
                    assert.match(await page.locator('.app-topbar .mode-switch-label').textContent(), /^(PRACTICE|REAL)$/i, `${path} does not name the account mode`);
                    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${path} scrolls sideways`);
                    // Content keeps its flat styling: headings in the text colour, no card shadow.
                    const card = await page.evaluate(() => { const node = document.querySelector('main .premium-glass-card, main h1'); return node ? getComputedStyle(node).boxShadow : 'none'; });
                    assert.equal(card, 'none', `${path} content has a shadow`);
                    await shot(page, `help-${key}-${path.replace('.html', '')}-${scheme}-${viewport.width}`);
                    assert.deepEqual(errors, [], `${path} logged errors`);
                } finally { await context.close(); }
            }
        });
    }
}

test('the landing page header and footer no longer offer guides, FAQ or contact', async () => {
    const { page, context } = await openApp(app, 'index.html', { fake: fake() });
    try {
        await page.locator('.premium-header').waitFor();
        for (const href of ['faq.html', 'contact.html', 'blog.html']) assert.equal(await page.locator(`a[href="${href}"]`).count(), 0, `the landing page links ${href}`);
    } finally { await context.close(); }
});

test('signed in, legal pages offer Back to the app instead of landing links or log out', async () => {
    for (const path of ['terms.html', 'privacy.html', 'risk.html', 'cookies.html']) {
        const { page, context, errors } = await openApp(app, path, { fake: fake() });
        try {
            await page.locator('.premium-header [data-shell-back]').waitFor();
            assert.match(await page.locator('[data-shell-back]').textContent(), /Back/);
            for (const href of ['index.html', 'about.html', 'login.html', 'register.html']) {
                assert.equal(await page.locator(`.premium-header a[href="${href}"], .premium-footer a[href="${href}"]`).count(), 0, `${path} links ${href}`);
            }
            assert.equal(await page.getByRole('button', { name: /log out/i }).count(), 0, `${path} shows log out`);
            assert.equal(await page.locator('.premium-header .navbar-brand').getAttribute('href'), 'dashboard.html');
            assert.ok(await page.locator('.premium-footer a[href="terms.html"]').count() === 1, `${path} lost its legal links`);
            assert.deepEqual(errors, [], `${path} logged errors`);
            // Opened directly, with no earlier page of ours, Back goes to the dashboard.
            await Promise.all([page.waitForURL(/dashboard\.html/), page.locator('[data-shell-back]').click()]);
        } finally { await context.close(); }
    }
});
