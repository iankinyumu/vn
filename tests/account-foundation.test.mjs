import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

function page() {
    const dom = new JSDOM('<!doctype html><body><select data-account-switcher></select></body>', { runScripts: 'outside-only', url: 'https://example.test/pages/dashboard.html' });
    const accounts = [{ id: 'practice-id', execution_mode: 'DEMO', currency: 'USD', status: 'ACTIVE' }, { id: 'real-id', execution_mode: 'REAL', currency: 'USD', status: 'ACTIVE' }];
    dom.window.getSupabaseClient = async () => ({ rpc: async (name) => ({ data: name === 'get_engine_config' ? { real_enabled: false } : name === 'list_my_accounts' ? accounts : 'practice-id', error: null }) });
    dom.window.eval(fs.readFileSync('assets/js/account-context.js', 'utf8'));
    dom.window.eval(fs.readFileSync('assets/js/account-keys.js', 'utf8'));
    dom.window.eval(fs.readFileSync('assets/js/account-switcher.js', 'utf8'));
    return dom;
}

test('a session explicitly starts on Practice and Real is listed but disabled', async () => {
    const dom = page();
    await dom.window.initAccountSwitcher();
    assert.deepEqual({ ...dom.window.smartProfitAccount.get() }, { accountId: 'practice-id', mode: 'DEMO', currency: 'USD' });
    const options = dom.window.document.querySelectorAll('option');
    assert.equal(options.length, 2);
    assert.equal(options[1].disabled, true);
    assert.match(options[1].textContent, /Not available yet/);
    dom.window.close();
});

test('account keys are mode and account scoped and switching clears old state', async () => {
    const dom = page();
    let clears = 0;
    dom.window.document.addEventListener('smartprofit:clear-trade-state', () => clears++);
    await dom.window.initAccountSwitcher();
    const key = dom.window.smartProfitAccountKeys.key('quote');
    dom.window.sessionStorage.setItem(key, 'old quote');
    const select = dom.window.document.querySelector('[data-account-switcher]');
    select.value = 'real-id'; select.dispatchEvent(new dom.window.Event('change'));
    assert.equal(dom.window.sessionStorage.getItem(key), null);
    assert.equal(clears, 1);
    assert.equal(dom.window.smartProfitAccount.get().accountId, 'real-id');
    dom.window.close();
});

test('an absent or inactive Practice account does not fall back to another account', async () => {
    const dom = new JSDOM('<!doctype html><body><select data-account-switcher></select></body>', { runScripts: 'outside-only', url: 'https://example.test/pages/dashboard.html' });
    dom.window.getSupabaseClient = async () => ({ rpc: async (name) => ({ data: name === 'get_engine_config' ? { real_enabled: false } : name === 'list_my_accounts' ? [{ id: 'inactive-practice', execution_mode: 'DEMO', currency: 'USD', status: 'INACTIVE' }] : 'inactive-practice', error: null }) });
    dom.window.eval(fs.readFileSync('assets/js/account-context.js', 'utf8'));
    dom.window.eval(fs.readFileSync('assets/js/account-switcher.js', 'utf8'));
    await assert.rejects(dom.window.initAccountSwitcher(), /Practice account is unavailable/);
    assert.throws(() => dom.window.smartProfitAccount.get(), /active account is required/i);
    dom.window.close();
});

test('the account picker shows Practice on init even when Real is listed first', async () => {
    const dom = new JSDOM('<!doctype html><body><select data-account-switcher></select></body>', { runScripts: 'outside-only', url: 'https://example.test/pages/dashboard.html' });
    const accounts = [{ id: 'real-id', execution_mode: 'REAL', currency: 'USD', status: 'ACTIVE' }, { id: 'practice-id', execution_mode: 'DEMO', currency: 'USD', status: 'ACTIVE' }];
    dom.window.getSupabaseClient = async () => ({ rpc: async (name) => ({ data: name === 'get_engine_config' ? { real_enabled: true } : name === 'list_my_accounts' ? accounts : 'practice-id', error: null }) });
    dom.window.eval(fs.readFileSync('assets/js/account-context.js', 'utf8'));
    dom.window.eval(fs.readFileSync('assets/js/account-keys.js', 'utf8'));
    dom.window.eval(fs.readFileSync('assets/js/account-switcher.js', 'utf8'));
    await dom.window.initAccountSwitcher();
    const select = dom.window.document.querySelector('[data-account-switcher]');
    assert.equal(select.value, 'practice-id');
    assert.equal(select.selectedOptions[0].textContent, 'Practice');
    assert.equal(dom.window.smartProfitAccount.get().accountId, 'practice-id');
    dom.window.close();
});
