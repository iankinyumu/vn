import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

test('profile identity renders the authenticated person without account data', async () => {
    const dom = new JSDOM('<!doctype html><body><span data-profile-name></span><span data-profile-email></span><p data-profile-status></p></body>', { runScripts: 'outside-only' });
    dom.window.getAuthenticatedUser = async () => ({ email: 'person@example.test', user_metadata: { display_name: 'Person' } });
    const listeners = [];
    dom.window.addEventListener = (_, listener) => listeners.push(listener);
    dom.window.eval(fs.readFileSync('assets/js/profile-identity.js', 'utf8'));
    await listeners[0]();
    assert.equal(dom.window.document.querySelector('[data-profile-name]').textContent, 'Person');
    assert.equal(dom.window.document.querySelector('[data-profile-email]').textContent, 'person@example.test');
    dom.window.close();
});

test('the profile page shows identity and account types, switches tabs and saves the display name, without balances', async () => {
    const dom = new JSDOM(fs.readFileSync('pages/profile.html', 'utf8'), { runScripts: 'outside-only', url: 'https://example.test/pages/profile.html' });
    const updates = [];
    const reads = { select() { return this; }, eq() { return this; }, maybeSingle: async () => ({ data: { display_name: 'Ada Lovelace', created_at: '2026-09-01T00:00:00Z' }, error: null }) };
    const client = { from: () => ({ ...reads, update: (values) => ({ eq: async (column, value) => { updates.push({ values, column, value }); return { error: null }; } }) }) };
    dom.window.getAuthenticatedUser = async () => ({ id: 'user-1', email: 'ada@example.test', email_confirmed_at: '2026-09-01T00:00:00Z', user_metadata: {} });
    dom.window.getSupabaseClient = async () => client;
    dom.window.smartProfitAccount = { get: () => ({ accountId: 'practice-id', mode: 'DEMO', currency: 'USD' }) };
    dom.window.initAccountSwitcher = async () => ({ config: { real_enabled: false }, accounts: [{ id: 'practice-id', execution_mode: 'DEMO', currency: 'USD', status: 'ACTIVE' }, { id: 'real-id', execution_mode: 'REAL', currency: 'USD', status: 'ACTIVE' }] });
    dom.window.refreshRestrictionBanner = async () => {};
    const $ = (selector) => dom.window.document.querySelector(selector);
    const wait = async (predicate) => { const started = Date.now(); while (!predicate() && Date.now() - started < 2000) await new Promise((resolve) => setTimeout(resolve, 5)); };
    assert.equal(dom.window.document.readyState, 'loading');
    dom.window.eval(fs.readFileSync('assets/js/profile-identity.js', 'utf8'));
    await wait(() => $('[data-account-mode]').textContent === 'Practice');
    try {
        assert.equal($('[data-profile-name]').textContent, 'Ada Lovelace');
        assert.equal($('[data-profile-avatar]').textContent, 'AL');
        assert.equal($('[data-profile-verified]').textContent, 'Verified');
        assert.notEqual($('[data-profile-created]').textContent, '—');
        assert.deepEqual([...dom.window.document.querySelectorAll('[data-profile-accounts] tr')].map((row) => row.textContent), ['PracticeUSDACTIVE', 'RealUSDNot available yet']);
        assert.doesNotMatch($('main').textContent, /balance:|USD \d/i);

        $('[data-profile-tab="accounts"]').dispatchEvent(new dom.window.MouseEvent('click'));
        assert.equal($('#tab-accounts').classList.contains('active'), true);
        assert.equal($('#tab-settings').classList.contains('active'), false);

        $('[data-profile-display-name]').value = '  Ada King  ';
        $('#profileForm').dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
        await wait(() => $('[data-profile-save-status]').textContent === 'Display name saved.');
        assert.deepEqual(JSON.parse(JSON.stringify(updates)), [{ values: { display_name: 'Ada King' }, column: 'id', value: 'user-1' }]);
        assert.equal($('[data-profile-name]').textContent, 'Ada King');
    } finally { dom.window.close(); }
});
