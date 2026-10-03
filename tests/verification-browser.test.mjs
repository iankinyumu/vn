// Real-browser checks of account verification, which customers start from their profile: each step
// saves to the server, errors point at the field, the knowledge check is explained, it works at 320px
// in both colour schemes, and the profile shows where the customer is without forcing it.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { EDGE, openApp, startApp } from './helpers/browser-app.mjs';
import { tradeFake } from './browser/trade-fake.mjs';

// A stand-in for the onboarding RPCs with the server's step lock and scoring, kept in page memory.
const verificationFake = ({ status = 'not_started', step = 1, failPhoneOnce = false } = {}) => `
    (function () {
        window.__FAKE__ = window.__FAKE__ || { rpc: {} };
        window.__FAKE__.rpc = window.__FAKE__.rpc || {};
        const KEY = { q1: 'lose_stake', q2: 'same_chance', q3: 'expected_loss', q4: 'the_stake' };
        const s = { status: ${JSON.stringify(status)}, current_step: ${step}, data: { legal_first_name: 'Wanjiru', legal_last_name: 'Kamau', country_of_residence: 'KE', nationality: 'KE' } };
        let failPhone = ${failPhoneOnce};
        const view = () => JSON.parse(JSON.stringify(s));
        Object.assign(window.__FAKE__.rpc, {
            get_notification_unread_count: () => 0,
            list_my_notifications: () => ({ announcements: [], notifications: [], unread: 0 }),
            get_my_verification: () => view(),
            get_my_onboarding: () => ({ status: 'completed', skipped: false, data: {} }),
            save_my_verification_step: ({ p_step, p_data }) => {
                if (p_step > s.current_step) return { __error: 'step_locked' };
                if (p_step === 1 && failPhone) { failPhone = false; return { __error: 'invalid_phone' }; }
                Object.assign(s.data, p_data);
                if (p_step === 5) {
                    s.knowledge_score = ['q1', 'q2', 'q3', 'q4'].filter((q) => p_data[q] === KEY[q]).length;
                    s.appropriateness = s.knowledge_score >= 3 ? 'appropriate' : 'not_yet';
                }
                s.status = 'in_progress';
                s.current_step = Math.max(s.current_step, p_step + 1);
                return view();
            },
            complete_my_verification: () => { s.status = 'completed'; s.completed_at = new Date().toISOString(); return view(); },
        });
    })();
`;

let app;
before(async () => { assert.ok(EDGE, 'Microsoft Edge is required for the real-browser checks'); app = await startApp(); });
after(async () => { await app?.close(); });

const rpcLog = (page, name) => page.evaluate((n) => (window.__RPC_LOG__ || []).filter((call) => call.name === n), name);

test('the profile shows verification progress and links to it, without forcing it', async () => {
    const { page, context } = await openApp(app, 'profile.html', { fake: tradeFake({}) + verificationFake({ status: 'in_progress', step: 3 }) });
    try {
        await page.locator('[data-verification-link]:not([hidden])').waitFor();
        assert.match(await page.locator('[data-verification-status]').textContent(), /step 3 of 6/);
        assert.equal((await page.locator('[data-verification-link]').textContent()).trim(), 'Continue verification');
        assert.equal(await page.locator('[data-verification-link]').getAttribute('href'), 'verification.html');
        assert.match(page.url(), /profile\.html$/);
    } finally { await context.close(); }
});

for (const scheme of ['dark', 'light']) {
    test(`the six verification steps save in turn and submit, at 320px in ${scheme} mode`, async () => {
        const { page, context, errors } = await openApp(app, 'verification.html', { fake: verificationFake({ failPhoneOnce: true }), viewport: { width: 320, height: 640 } });
        try {
            await page.emulateMedia({ colorScheme: scheme });
            await page.locator('[data-step="1"]:not([hidden])').waitFor();
            assert.match(await page.locator('[data-ob-progress-text]').textContent(), /Step 1 of 6 · About you/);

            // Empty submit: an error summary and a field error, no server call.
            await page.fill('#legal_first_name', '');
            await page.click('[data-step="1"] [type="submit"]');
            assert.equal(await page.locator('[data-ob-errors]').isVisible(), true);
            assert.equal(await page.locator('#legal_first_name').getAttribute('aria-invalid'), 'true');
            assert.equal((await rpcLog(page, 'save_my_verification_step')).length, 0);

            await page.fill('#legal_first_name', 'Wanjiru');
            await page.fill('#date_of_birth', '1994-05-17');
            await page.fill('#phone', '0712 345 678');
            await page.click('[data-step="1"] [type="submit"]');
            // The server refuses the phone once: its error lands on the phone field.
            await page.locator('[data-error-for="phone"]:not([hidden])').waitFor();
            assert.equal(await page.locator('#phone').getAttribute('aria-invalid'), 'true');
            await page.click('[data-step="1"] [type="submit"]');
            await page.locator('[data-step="2"]:not([hidden])').waitFor();
            const first = (await rpcLog(page, 'save_my_verification_step')).at(-1);
            assert.equal(first.args.p_data.phone, '+254712345678', 'a local Kenyan number is sent with its country code');

            assert.equal(await page.locator('[data-region-select]').isVisible(), true, 'Kenyan residents choose a county');
            await page.fill('#address_line1', 'Kenyatta Avenue 12');
            await page.fill('#city', 'Nairobi');
            await page.selectOption('[data-region-select]', 'Nairobi');
            await page.click('[data-step="2"] [type="submit"]');

            await page.locator('[data-step="3"]:not([hidden])').waitFor();
            await page.selectOption('#employment_status', 'employed');
            await page.selectOption('#occupation', 'ict');
            await page.selectOption('#annual_income', '1m_3m');
            await page.selectOption('#savings', '100k_500k');
            await page.check('[name="source_of_funds"][value="salary"]');
            await page.check('[name="is_pep"][value="false"]');
            await page.click('[data-step="3"] [type="submit"]');

            await page.locator('[data-step="4"]:not([hidden])').waitFor();
            for (const name of ['experience_binary', 'experience_forex', 'experience_shares']) await page.check(`[name="${name}"][value="none"]`);
            await page.check('[name="finance_background"][value="false"]');
            await page.click('[data-step="4"] [type="submit"]');

            await page.locator('[data-step="5"]:not([hidden])').waitFor();
            await page.check('[name="q1"][value="lose_stake"]');
            await page.check('[name="q2"][value="more_likely"]');
            await page.check('[name="q3"][value="expected_loss"]');
            await page.check('[name="q4"][value="the_stake"]');
            await page.click('[data-step="5"] [type="submit"]');
            await page.locator('[data-step="5-result"]:not([hidden])').waitFor();
            assert.match(await page.locator('[data-ob-score]').textContent(), /3 of 4/);
            const review = await page.locator('[data-ob-review]').textContent();
            assert.match(review, /Not quite\..*next digit/s, 'a wrong answer is said in words');
            assert.match(review, /Exactly as likely as on any other tick/);
            await page.click('[data-ob-next]');

            await page.locator('[data-step="6"]:not([hidden])').waitFor();
            await page.check('[name="goal"][value="extra_income"]');
            assert.equal(await page.locator('[data-income-warning]').isVisible(), true, 'an income goal gets a plain warning');
            await page.check('[name="weekly_time"][value="1_5h"]');
            await page.check('[name="ack_lose_stake"]');
            await page.check('[name="ack_practice"]');
            await page.click('[data-step="6"] [type="submit"]');
            assert.equal(await page.locator('[data-error-for="acknowledgements"]').isVisible(), true, 'all three acknowledgements are needed');
            await page.check('[name="ack_afford"]');
            await page.click('[data-step="6"] [type="submit"]');

            await page.locator('[data-step="done"]:not([hidden])').waitFor();
            assert.equal((await rpcLog(page, 'complete_my_verification')).length, 1);
            assert.match(await page.locator('[data-ob-appropriateness]').textContent(), /understand how digit contracts work/);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no sideways scrolling at 320px');
            assert.deepEqual(errors, []);
        } finally { await context.close(); }
    });
}
