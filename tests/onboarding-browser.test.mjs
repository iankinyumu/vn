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
            await page.check('[name="goal"][value="grow"]');
            await page.click('[data-step="1"] [type="submit"]');
            await page.locator('[data-step="2"]:not([hidden])').waitFor();
            // Nothing is required: continue without answering.
            await page.click('[data-step="2"] [type="submit"]');
            await page.locator('[data-step="3"]:not([hidden])').waitFor();
            await page.check('[name="start_with"][value="guides"]');
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no sideways scrolling at 320px');
            const saved = await page.evaluate(() => (window.__RPC_LOG__ || []).filter((call) => call.name === 'save_my_onboarding').map((call) => call.args));
            assert.equal(saved.length, 2);
            assert.equal(saved[0].p_data.goal, 'grow');
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

// ---- The site follows the answers -----------------------------------------------------------

test('the trade page opens on the contract the customer wanted to try', async () => {
    const { page, context, errors } = await openApp(app, 'trade.html', { fake: tradeFake({}) + onboardingFake({ status: 'completed', data: { experience: 'some', interests: ['overunder'] } }) });
    try {
        await page.locator('[name="family"][value="overunder"]:checked').waitFor({ state: 'attached' });
        assert.deepEqual(errors, []);
    } finally { await context.close(); }
});

test('the first-visit tour runs for a newcomer and is skipped for an experienced trader', async () => {
    for (const [experience, toured] of [['new', true], ['experienced', false]]) {
        const { page, context } = await openApp(app, 'trade.html', { fake: tradeFake({}) + onboardingFake({ status: 'completed', data: { experience } }) });
        try {
            await page.locator('[data-companion]').waitFor();
            await page.waitForTimeout(600);
            const bubble = await page.locator('[data-companion-bubble]').isVisible();
            assert.equal(bubble, toured, `${experience}: tour ${toured ? 'shown' : 'not shown'}`);
        } finally { await context.close(); }
    }
});

test('tailoring turns the answers into settings and marks the page with them', async () => {
    const { page, context, errors } = await openApp(app, 'dashboard.html', { fake: tradeFake({}) + onboardingFake({ status: 'completed', data: { goal: 'grow', experience: 'some', interests: ['overunder', 'evenodd'] } }) });
    try {
        await page.waitForFunction(() => document.documentElement.dataset.dashboardLead === 'results');
        assert.equal(await page.evaluate(() => document.documentElement.dataset.guidance), 'light');
        const settings = await page.evaluate(() => window.smartProfitTailoring.settings());
        assert.deepEqual(settings, { guidance: 'light', dashboardLead: 'results', contracts: ['evenodd', 'overunder'] });
        const mapped = await page.evaluate(() => {
            const { derive } = window.smartProfitTailoring;
            return {
                none: derive({}),
                learn: derive({ goal: 'learn', experience: 'new' }).dashboardLead,
                shortTerm: derive({ goal: 'short_term' }).dashboardLead,
                strategy: derive({ goal: 'strategy', experience: 'experienced' }),
                unknown: derive({ goal: 'fun', experience: 'guru', interests: ['dice'] }),
            };
        });
        assert.deepEqual(mapped.none, { guidance: null, dashboardLead: null, contracts: [] }, 'no answers keep today\'s site');
        assert.equal(mapped.learn, 'guides');
        assert.equal(mapped.shortTerm, 'indices');
        assert.deepEqual(mapped.strategy, { guidance: 'minimal', dashboardLead: 'breakdown', contracts: [] });
        assert.deepEqual(mapped.unknown, { guidance: null, dashboardLead: null, contracts: [] });
        assert.deepEqual(errors.filter((text) => /tailoring|onboarding/.test(text)), []);
    } finally { await context.close(); }
});

test('guidance levels: full explains and tours, light offers the tour, minimal stays quiet', async () => {
    const cases = [
        { experience: 'new', open: true, bubble: /^1 of 3\./ },
        { experience: 'some', open: false, bubble: /Take the tour/ },
        { experience: 'experienced', open: false, bubble: null },
        { experience: undefined, open: false, bubble: /^1 of 3\./ },
    ];
    for (const { experience, open, bubble } of cases) {
        const data = experience ? { experience, interests: ['evenodd'] } : { interests: ['evenodd'] };
        const { page, context, errors } = await openApp(app, 'trade.html', { fake: tradeFake({}) + onboardingFake({ status: 'completed', data }) });
        try {
            await page.locator('[name="family"][value="evenodd"]:checked').waitFor({ state: 'attached' });
            await page.locator('[data-companion]').waitFor();
            await page.waitForTimeout(600);
            assert.equal(await page.locator('[data-ticket-help]').evaluate((node) => node.open), open, `${experience}: explanation ${open ? 'open' : 'closed'}`);
            if (open) {
                assert.ok(await page.locator('[data-help-family="evenodd"]').isVisible(), 'the selected contract is explained');
                assert.equal(await page.locator('[data-help-family="overunder"]').isVisible(), false, 'other contracts are not');
            }
            const shown = await page.locator('[data-companion-bubble]').isVisible();
            if (!bubble) assert.equal(shown, false, `${experience}: no tour prompt`);
            else assert.match(await page.locator('[data-companion-text], [data-companion-actions]').allTextContents().then((parts) => parts.join(' ')), bubble);
            assert.deepEqual(errors, []);
        } finally { await context.close(); }
    }
});

test('the dashboard shows Getting started only to customers who asked for full guidance', async () => {
    for (const [experience, visible] of [['new', true], ['some', false], [undefined, false]]) {
        const data = experience ? { experience } : {};
        const { page, context } = await openApp(app, 'dashboard.html', { fake: tradeFake({}) + onboardingFake({ status: 'completed', data }) });
        try {
            await page.waitForFunction(() => window.smartProfitTailoring);
            await page.evaluate(() => window.smartProfitTailoring.settings());
            assert.equal(await page.locator('[data-getting-started]').isVisible(), visible, `${experience}: Getting started ${visible ? 'shown' : 'hidden'}`);
            if (visible) assert.equal(await page.locator('[data-getting-started] a[href="guide-settlement.html"]').count(), 1);
        } finally { await context.close(); }
    }
});

test('the welcome answers never show anywhere a customer can see', async () => {
    const data = { goal: 'learn', experience: 'new', interests: ['evenodd'] };
    for (const path of ['profile.html', 'dashboard.html', 'trade.html']) {
        const { page, context } = await openApp(app, path, { fake: tradeFake({}) + onboardingFake({ status: 'completed', data }) });
        try {
            await page.waitForFunction(() => window.smartProfitTailoring);
            await page.evaluate(() => window.smartProfitTailoring.settings());
            assert.equal(await page.locator('[name="goal"], [name="experience"], [name="interests"], [data-prefs-form]').count(), 0, `${path}: no answer fields`);
            const text = await page.locator('body').innerText();
            assert.doesNotMatch(text, /you asked for|your answers|trading preferences|Learn how digit contracts work/i, `${path}: no answers echoed`);
        } finally { await context.close(); }
    }
    const onboarding = (await import('node:fs')).readFileSync(new URL('../pages/onboarding.html', import.meta.url), 'utf8');
    assert.doesNotMatch(onboarding, /on your profile/);
});
