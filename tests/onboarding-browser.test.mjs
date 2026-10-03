// Real-browser checks of the welcome questions: unfinished customers are sent to them once, every
// answer is optional, "Skip for now" ends them at once, and the last answer picks the first page.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { EDGE, openApp, startApp } from './helpers/browser-app.mjs';
import { tradeFake } from './browser/trade-fake.mjs';

const onboardingFake = ({ status = 'not_started', data = {} } = {}) => `
    (function () {
        window.__FAKE__ = window.__FAKE__ || { rpc: {} };
        window.__FAKE__.rpc = window.__FAKE__.rpc || {};
        const s = { status: ${JSON.stringify(status)}, skipped: false, data: ${JSON.stringify(data)} };
        Object.assign(window.__FAKE__.rpc, {
            get_notification_unread_count: () => 0,
            list_my_notifications: () => ({ announcements: [], notifications: [], unread: 0 }),
            get_my_onboarding: () => JSON.parse(JSON.stringify(s)),
            save_my_onboarding: ({ p_data, p_finish, p_skip }) => {
                Object.assign(s.data, p_data);
                s.status = p_finish || p_skip ? 'completed' : 'in_progress';
                s.skipped = Boolean(p_skip);
                return JSON.parse(JSON.stringify(s));
            },
        });
    })();
`;

let app;
before(async () => { assert.ok(EDGE, 'Microsoft Edge is required for the real-browser checks'); app = await startApp(); });
after(async () => { await app?.close(); });

test('a new customer is sent from the dashboard to the welcome questions', async () => {
    const { page, context, errors } = await openApp(app, 'dashboard.html', { fake: tradeFake({}) + onboardingFake() });
    try {
        await page.waitForURL(/onboarding\.html$/);
        await page.locator('[data-step="1"]:not([hidden])').waitFor();
        assert.match(await page.locator('[data-ob-progress-text]').textContent(), /1 of 3/);
        // The dashboard starts loading against this minimal fake before it is replaced; only onboarding's own errors count.
        assert.deepEqual(errors.filter((text) => /onboarding|auth\.js/.test(text)), []);
    } finally { await context.close(); }
});

test('customers who answered or skipped stay where they asked to go', async () => {
    const { page, context } = await openApp(app, 'dashboard.html', { fake: tradeFake({}) + onboardingFake({ status: 'completed' }) });
    try {
        await page.waitForTimeout(800);
        assert.match(page.url(), /dashboard\.html$/);
    } finally { await context.close(); }
});

for (const scheme of ['dark', 'light']) {
    test(`three optional questions, then the chosen first page, at 320px in ${scheme} mode`, async () => {
        const { page, context, errors } = await openApp(app, 'onboarding.html', { fake: onboardingFake(), viewport: { width: 320, height: 640 } });
        try {
            await page.emulateMedia({ colorScheme: scheme });
            await page.locator('[data-step="1"]:not([hidden])').waitFor();
            await page.check('[name="goal"][value="extra_income"]');
            assert.equal(await page.locator('[data-income-warning]').isVisible(), true, 'an income goal gets a plain note');
            await page.click('[data-step="1"] [type="submit"]');
            await page.locator('[data-step="2"]:not([hidden])').waitFor();
            // Nothing is required: continue without answering.
            await page.click('[data-step="2"] [type="submit"]');
            await page.locator('[data-step="3"]:not([hidden])').waitFor();
            await page.check('[name="start_with"][value="guides"]');
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no sideways scrolling at 320px');
            const saved = await page.evaluate(() => (window.__RPC_LOG__ || []).filter((call) => call.name === 'save_my_onboarding').map((call) => call.args));
            assert.equal(saved.length, 2);
            assert.equal(saved[0].p_data.goal, 'extra_income');
            await page.click('[data-step="3"] [type="submit"]');
            await page.waitForURL(/guide-settlement\.html$/);
            assert.deepEqual(errors.filter((text) => /onboarding/.test(text)), []);
        } finally { await context.close(); }
    });
}

test('"Skip for now" ends it at once and lands on the dashboard', async () => {
    const { page, context } = await openApp(app, 'onboarding.html', { fake: onboardingFake() });
    try {
        await page.locator('[data-step="1"]:not([hidden])').waitFor();
        await page.click('[data-ob-skip-all]');
        await page.waitForURL(/dashboard\.html$/);
    } finally { await context.close(); }
});
