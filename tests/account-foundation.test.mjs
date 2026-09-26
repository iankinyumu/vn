import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const PRACTICE = { id: 'practice-id', execution_mode: 'DEMO', currency: 'USD', status: 'ACTIVE' };
const REAL = { id: 'real-id', execution_mode: 'REAL', currency: 'USD', status: 'ACTIVE' };

function page({ accounts = [PRACTICE, REAL], realEnabled = false, balances = { 'practice-id': 10000, 'real-id': 25 }, minStake = 0.35, answers = {} } = {}) {
    const dom = new JSDOM('<!doctype html><body><div data-account-switcher></div></body>', { runScripts: 'outside-only', url: 'https://example.test/pages/dashboard.html' });
    const calls = [];
    const config = { real_enabled: realEnabled, accounts: accounts.map((account) => ({ ...account, limits: { min_stake: minStake, max_stake: 500 } })) };
    dom.window.getSupabaseClient = async () => ({ rpc: async (name, args) => {
        calls.push({ name, args });
        if (answers[name]) return answers[name](args);
        if (name === 'get_engine_config') return { data: config, error: null };
        if (name === 'list_my_accounts') return { data: accounts, error: null };
        if (name === 'get_account_summary') return { data: { available: balances[args.p_account_id], currency: 'USD' }, error: null };
        if (name === 'funding_sandbox_overview') return { data: { available: false }, error: null };
        return { data: 'practice-id', error: null };
    } });
    dom.window.eval(fs.readFileSync('assets/js/account-context.js', 'utf8'));
    dom.window.eval(fs.readFileSync('assets/js/account-keys.js', 'utf8'));
    dom.window.eval(fs.readFileSync('assets/js/account-switcher.js', 'utf8'));
    const $ = (selector) => dom.window.document.querySelector(selector);
    return { dom, calls, $, balances, item: (id) => $(`[data-account-id="${id}"]`) };
}

async function settle(predicate, message) {
    const started = Date.now();
    while (!predicate()) {
        if (Date.now() - started > 2000) assert.fail(message);
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

test('a session explicitly starts on Practice and Real is listed but not open', async () => {
    const { dom, $, item } = page();
    await dom.window.initAccountSwitcher();
    assert.deepEqual({ ...dom.window.smartProfitAccount.get() }, { accountId: 'practice-id', mode: 'DEMO', currency: 'USD' });
    assert.equal($('[data-mode-label]').textContent, 'Practice');
    assert.equal(item('practice-id').getAttribute('aria-checked'), 'true');
    assert.equal(item('real-id').disabled, true);
    assert.match(item('real-id').textContent, /Not open yet/);
    dom.window.close();
});

test('the mode switch is a plain button that opens and closes an account menu', async () => {
    const { dom, $, balances } = page();
    await dom.window.initAccountSwitcher();
    const toggle = $('.mode-switch-toggle');
    await settle(() => $('[data-mode-balance]').textContent === '$10,000.00', 'the balance was not shown');
    assert.equal(toggle.getAttribute('aria-haspopup'), 'menu');
    assert.equal($('.mode-menu').hidden, true);
    toggle.click();
    assert.equal($('.mode-menu').hidden, false);
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    $('.mode-menu').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal($('.mode-menu').hidden, true);
    balances['practice-id'] = 9990;
    dom.window.document.dispatchEvent(new dom.window.Event('smartprofit:balance-changed'));
    await settle(() => $('[data-mode-balance]').textContent === '$9,990.00', 'a balance change was not re-read');
    dom.window.close();
});

test('account keys are mode and account scoped and switching clears old state', async () => {
    const { dom, item } = page({ realEnabled: true });
    let clears = 0;
    dom.window.document.addEventListener('smartprofit:clear-trade-state', () => clears++);
    await dom.window.initAccountSwitcher();
    const key = dom.window.smartProfitAccountKeys.key('quote');
    dom.window.sessionStorage.setItem(key, 'old quote');
    item('real-id').click();
    assert.equal(dom.window.sessionStorage.getItem(key), null);
    assert.equal(clears, 1);
    assert.equal(dom.window.smartProfitAccount.get().accountId, 'real-id');
    assert.equal(dom.window.document.querySelector('[data-mode-label]').textContent, 'Real');
    assert.equal(dom.window.document.querySelector('[data-account-switcher]').dataset.mode, 'real');
    dom.window.close();
});

test('an absent or inactive Practice account does not fall back to another account', async () => {
    const { dom, $ } = page({ accounts: [{ ...PRACTICE, status: 'INACTIVE' }] });
    await assert.rejects(dom.window.initAccountSwitcher(), /Practice account is unavailable/);
    assert.throws(() => dom.window.smartProfitAccount.get(), /active account is required/i);
    assert.equal($('.mode-switch-toggle').disabled, true);
    assert.equal($('[data-mode-balance]').textContent, 'Unavailable');
    dom.window.close();
});

test('the switch shows Practice on init even when Real is listed first', async () => {
    const { dom, $, item } = page({ accounts: [REAL, PRACTICE], realEnabled: true });
    await dom.window.initAccountSwitcher();
    assert.equal($('[data-mode-label]').textContent, 'Practice');
    assert.equal(item('practice-id').getAttribute('aria-checked'), 'true');
    assert.equal(dom.window.smartProfitAccount.get().accountId, 'practice-id');
    dom.window.close();
});

test('practice funds can be reset from the menu only once the balance is below the minimum stake', async () => {
    const reset = page();
    await reset.dom.window.initAccountSwitcher();
    await settle(() => reset.$('[data-mode-balance]').textContent === '$10,000.00', 'the balance was not shown');
    assert.equal(reset.$('[data-reset-practice]').hidden, true, 'a funded account is offered a reset');
    reset.balances['practice-id'] = 0.2;
    reset.dom.window.document.dispatchEvent(new reset.dom.window.Event('smartprofit:balance-changed'));
    await settle(() => !reset.$('[data-reset-practice]').hidden, 'an empty account was not offered a reset');
    reset.$('[data-reset-practice]').click();
    await settle(() => reset.calls.some((call) => call.name === 'reset_practice_balance'), 'the reset was not requested');
    assert.equal(reset.calls.find((call) => call.name === 'reset_practice_balance').args.p_account_id, 'practice-id');
    await settle(() => reset.calls.filter((call) => call.name === 'get_account_summary').length >= 3, 'the balance was not re-read after the reset');
    reset.dom.window.close();

    const limited = page({ balances: { 'practice-id': 0.1 }, answers: { reset_practice_balance: () => ({ data: null, error: { message: 'reset_rate_limited' } }) } });
    await limited.dom.window.initAccountSwitcher();
    await settle(() => !limited.$('[data-reset-practice]').hidden, 'the reset was not offered');
    limited.$('[data-reset-practice]').click();
    await settle(() => !limited.$('[data-mode-note]').hidden, 'a refused reset was not explained');
    assert.equal(limited.$('[data-mode-note]').textContent, 'Practice funds can be reset once every 24 hours.');
    limited.dom.window.close();
});
