// Real-browser checks of the profile character picker: it is hidden until the profile picture is
// tapped, opens as a dialog focused on the current character, saves a pick straight away, and
// closes with Done, Esc or a tap outside, returning focus to the picture.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { EDGE, openApp, startApp } from './helpers/browser-app.mjs';
import { tradeFake } from './browser/trade-fake.mjs';

const answered = `
    (function () {
        window.__FAKE__ = window.__FAKE__ || { rpc: {} };
        window.__FAKE__.rpc = window.__FAKE__.rpc || {};
        Object.assign(window.__FAKE__.rpc, {
            get_notification_unread_count: () => 0,
            list_my_notifications: () => ({ announcements: [], notifications: [], unread: 0 }),
            get_my_onboarding: () => ({ status: 'completed', skipped: false, data: {} }),
        });
    })();
`;

let app;
before(async () => { assert.ok(EDGE, 'Microsoft Edge is required for the real-browser checks'); app = await startApp(); });
after(async () => { await app?.close(); });

test('the character picker opens only from the profile picture and closes back to it', async () => {
    for (const viewport of [{ width: 1366, height: 860 }, { width: 320, height: 640 }]) {
        const { page, context, errors } = await openApp(app, 'profile.html', { fake: tradeFake({}) + answered, viewport });
        try {
            const trigger = page.locator('[data-avatar-change]');
            await page.waitForFunction(() => !document.querySelector('[data-avatar-change]').disabled);
            assert.equal(await page.locator('[data-avatar-dialog]').isVisible(), false, 'no picker on the page until asked for');
            assert.match(await trigger.getAttribute('aria-label'), /Change character/);

            await trigger.click();
            await page.locator('[data-avatar-dialog][open]').waitFor();
            assert.equal(await page.evaluate(() => document.activeElement?.matches('[data-avatar-options] input:checked')), true, 'focus starts on the current character');

            const other = page.locator('[data-avatar-options] input:not(:checked)').first();
            const choice = await other.getAttribute('value');
            await page.locator(`[data-avatar-options] label:has(input[value="${choice}"])`).click();
            await page.locator('[data-avatar-status]', { hasText: 'Character saved' }).waitFor();
            assert.equal(await page.locator('[data-profile-avatar]').getAttribute('data-avatar'), choice);

            await page.click('.avatar-dialog-done');
            await page.locator('[data-avatar-dialog]:not([open])').waitFor({ state: 'attached' });
            assert.equal(await page.evaluate(() => document.activeElement?.matches('[data-avatar-change]')), true, 'focus returns to the picture');

            await trigger.click();
            await page.keyboard.press('Escape');
            await page.locator('[data-avatar-dialog]:not([open])').waitFor({ state: 'attached' });

            await trigger.click();
            await page.mouse.click(4, 4);
            await page.locator('[data-avatar-dialog]:not([open])').waitFor({ state: 'attached' });
            assert.deepEqual(errors, []);
        } finally { await context.close(); }
    }
});
