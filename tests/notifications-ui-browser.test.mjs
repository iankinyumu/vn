// Real-browser checks of the notification centre (assets/js/notifications.js) and the shared toasts
// on the trade page, in Microsoft Edge, light and dark, at desktop and 320px widths.
// Set BROWSER_EVIDENCE=1 to write screenshots to docs/browser-checks/.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { EDGE, openApp, shot, startApp } from './helpers/browser-app.mjs';
import { tradeFake } from './browser/trade-fake.mjs';

const now = new Date().toISOString();
const fake = () => tradeFake({}) + `
    window.__INBOX__ = {
        announcements: [{ id: 'a-1', title: 'Maintenance tonight', body: 'Trading pauses from 02:00 to 02:15 EAT while the price engine is updated.', link: 'faq.html', severity: 'important', created_at: '${now}', read: false }],
        notifications: [
            { id: 'n-1', category: 'support', title: 'Support replied on SP-1001', body: 'Your deposit was credited this morning. Thank you for waiting.', link: 'support.html', created_at: '${now}', read: false, from_staff: true },
            { id: 'n-2', category: 'funding', title: 'Deposit confirmed', body: '$10.00 was added to your REAL account.', link: null, created_at: '2026-09-20T09:00:00Z', read: true, from_staff: false },
        ],
    };
    const unread = () => [...window.__INBOX__.announcements, ...window.__INBOX__.notifications].filter((item) => !item.read).length;
    Object.assign(window.__FAKE__.rpc, {
        get_notification_unread_count: () => unread(),
        list_my_notifications: () => ({ ...window.__INBOX__, unread: unread() }),
        mark_notifications_read: () => { [...window.__INBOX__.announcements, ...window.__INBOX__.notifications].forEach((item) => { item.read = true; }); return 0; },
    });
`;

let app;
before(async () => { assert.ok(EDGE, 'Microsoft Edge is required for the real-browser checks'); app = await startApp(); });
after(async () => { await app?.close(); });

for (const scheme of ['light', 'dark']) {
    for (const viewport of [{ width: 1366, height: 860 }, { width: 320, height: 640 }]) {
        test(`notification centre fits and reads in ${scheme} mode at ${viewport.width}px`, async () => {
            const { page, context, errors } = await openApp(app, 'trade.html', { fake: fake(), viewport });
            try {
                await page.emulateMedia({ colorScheme: scheme });
                const button = page.locator('.app-topbar [data-notify-open]');
                await button.waitFor();
                await page.waitForFunction(() => document.querySelector('[data-notify-open]').getAttribute('aria-label') === 'Notifications, 2 unread');
                const box = await button.boundingBox();
                assert.ok(box.width >= 44 && box.height >= 44, `the button is ${box.width}x${box.height}`);
                assert.ok(box.x + box.width <= viewport.width, 'the button overflows the top bar');
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'the page scrolls sideways');
                assert.equal(await page.locator('[data-announcement-banner]').isVisible(), true);
                await shot(page, `notifications-${scheme}-${viewport.width}-bar`);

                await button.click();
                const sheet = page.locator('[data-notify-sheet]');
                await page.locator('[data-notify-item]').nth(2).waitFor();
                const sheetBox = await sheet.boundingBox();
                assert.ok(sheetBox.x >= 0 && sheetBox.x + sheetBox.width <= viewport.width + 0.5, 'the sheet does not fit the screen');
                assert.ok(await page.evaluate(() => {
                    const node = document.querySelector('[data-notify-sheet]');
                    return node.scrollWidth <= node.clientWidth;
                }), 'the sheet scrolls sideways');
                const style = await page.evaluate(() => { const s = getComputedStyle(document.querySelector('[data-notify-sheet]')); return { shadow: s.boxShadow, radius: s.borderRadius }; });
                assert.equal(style.shadow, 'none');
                await page.keyboard.press('Tab');
                // Reduced motion leaves a 10µs transition on every property: let the ring settle.
                await page.waitForTimeout(50);
                const outline = await page.evaluate(() => getComputedStyle(document.activeElement).outlineWidth);
                assert.equal(outline, '2px', 'focus is not a 2px outline');
                await shot(page, `notifications-${scheme}-${viewport.width}-sheet`);
                await page.keyboard.press('Escape');
                await page.waitForFunction(() => !document.querySelector('[data-notify-sheet]').open);
                assert.equal(await page.evaluate(() => document.activeElement?.dataset.notifyOpen !== undefined), true, 'focus did not return to the button');

                await page.evaluate(() => window.smartProfitNotify.show({ title: 'Order filled', detail: 'PRACTICE · SPI10 · Even · stake $10.00 · exit tick #26' }));
                const toast = await page.locator('[data-toast]').first().boundingBox();
                assert.ok(toast.x >= 0 && toast.x + toast.width <= viewport.width, 'the toast does not fit the screen');
                await shot(page, `notifications-${scheme}-${viewport.width}-toast`);
                assert.deepEqual(errors, []);
            } finally { await context.close(); }
        });
    }
}
