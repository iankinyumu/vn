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
    const avatarSaves = [];
    const client = { from: () => ({ ...reads, update: (values) => ({ eq: async (column, value) => { updates.push({ values, column, value }); return { error: null }; } }) }), auth: { updateUser: async (attributes) => { avatarSaves.push(attributes); return { data: {}, error: null }; } } };
    dom.window.getAuthenticatedUser = async () => ({ id: 'user-1', email: 'ada@example.test', email_confirmed_at: '2026-09-01T00:00:00Z', user_metadata: {} });
    dom.window.getSupabaseClient = async () => client;
    dom.window.smartProfitAccount = { get: () => ({ accountId: 'practice-id', mode: 'DEMO', currency: 'USD' }) };
    dom.window.initAccountSwitcher = async () => ({ config: { real_enabled: false }, accounts: [{ id: 'practice-id', execution_mode: 'DEMO', currency: 'USD', status: 'ACTIVE' }, { id: 'real-id', execution_mode: 'REAL', currency: 'USD', status: 'ACTIVE' }] });
    dom.window.refreshRestrictionBanner = async () => {};
    const $ = (selector) => dom.window.document.querySelector(selector);
    const wait = async (predicate) => { const started = Date.now(); while (!predicate() && Date.now() - started < 2000) await new Promise((resolve) => setTimeout(resolve, 5)); };
    assert.equal(dom.window.document.readyState, 'loading');
    dom.window.eval(fs.readFileSync('assets/js/avatars.js', 'utf8'));
    dom.window.eval(fs.readFileSync('assets/js/profile-identity.js', 'utf8'));
    await wait(() => $('[data-account-mode]').textContent === 'Practice');
    try {
        assert.equal($('[data-profile-name]').textContent, 'Ada Lovelace');
        // No stored character yet: a stable pick from the user id, shown as a free-standing image.
        const assigned = dom.window.smartProfitAvatars.fromSeed('user-1');
        assert.equal($('[data-profile-avatar-img]').getAttribute('src'), `https://example.test/assets/img/avatars/${assigned}.webp`);
        assert.equal($('[data-profile-avatar-img]').hidden, false);
        assert.equal($('[data-profile-avatar]').textContent, '', 'no initials');
        const radios = [...dom.window.document.querySelectorAll('[data-avatar-options] input[type="radio"]')];
        assert.equal(radios.length, 20);
        assert.deepEqual(radios.filter((radio) => radio.checked).map((radio) => radio.value), [assigned]);
        const other = radios.find((radio) => radio.value !== assigned);
        other.checked = true;
        other.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
        await wait(() => $('[data-avatar-status]').textContent.startsWith('Character saved'));
        assert.deepEqual(JSON.parse(JSON.stringify(avatarSaves)), [{ data: { avatar: other.value } }]);
        assert.equal($('[data-profile-avatar]').dataset.avatar, other.value);
        // A pick from another device arrives as an event: the picture and the picker follow it.
        const remote = radios.find((radio) => radio.value !== assigned && radio.value !== other.value).value;
        dom.window.document.dispatchEvent(new dom.window.CustomEvent('smartprofit:avatar-changed', { detail: { avatar: remote } }));
        assert.equal($('[data-profile-avatar]').dataset.avatar, remote);
        assert.equal(dom.window.document.querySelector(`[data-avatar-options] input[value="${remote}"]`).checked, true);
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
