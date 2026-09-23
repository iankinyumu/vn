import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

test('dashboard exposes clear reset-practice error messages', () => {
    const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
    const addListener = dom.window.addEventListener;
    dom.window.addEventListener = () => {};
    dom.window.eval(fs.readFileSync('assets/js/dashboard.js', 'utf8'));
    dom.window.addEventListener = addListener;
    for (const code of ['account_not_available', 'open_contracts_exist', 'reset_not_available', 'reset_rate_limited']) assert.match(dom.window.smartProfitDashboard.resetMessages[code], /\.$/);
    dom.window.close();
});

test('dashboard totals come from the lifetime server aggregate, not the latest 20 rows', async () => {
    const dom = new JSDOM(fs.readFileSync('pages/dashboard.html', 'utf8'), { runScripts: 'outside-only', url: 'https://example.test/pages/dashboard.html' });
    const calls = [];
    const latest = Array.from({ length: 20 }, (_, n) => ({ index_code: 'SPI10', contract_type: 'EVEN', state: 'LOST', stake: '5', payout: '9.65', id: `c${n}` }));
    const responses = {
        get_account_summary: { available: '0.50', currency: 'USD' },
        get_account_stats: { wins: 41, losses: 37, voids: 2, open: 0, net_result: 158.1, currency: 'USD' },
        list_my_contracts: latest,
    };
    const client = { rpc: async (name, args) => { calls.push({ name, args: JSON.parse(JSON.stringify(args ?? null)) }); return { data: responses[name] ?? null, error: null }; } };
    dom.window.initAccountSwitcher = async () => ({ client, config: { accounts: [{ id: 'practice-id', limits: { min_stake: 1 } }] } });
    dom.window.smartProfitAccount = { get: () => ({ accountId: 'practice-id', mode: 'DEMO', currency: 'USD' }) };
    dom.window.refreshRestrictionBanner = async () => {};
    const text = (selector) => dom.window.document.querySelector(selector).textContent;
    assert.equal(dom.window.document.readyState, 'loading');
    dom.window.eval(fs.readFileSync('assets/js/dashboard.js', 'utf8'));
    const started = Date.now();
    while (text('[data-wins]') === '—' && Date.now() - started < 2000) await new Promise((resolve) => setTimeout(resolve, 5));
    try {
        assert.deepEqual(calls.find((call) => call.name === 'get_account_stats')?.args, { p_account_id: 'practice-id' });
        assert.equal(text('[data-wins]'), '41');
        assert.equal(text('[data-losses]'), '37');
        assert.equal(text('[data-net-result]'), 'USD 158.10');
        assert.match(text('[data-voids]'), /2 voided · 0 open/);
        assert.match(dom.window.document.body.textContent, /Net result · all time/);
        assert.equal(dom.window.document.querySelectorAll('[data-contract-rows] tr').length, 20);
        assert.equal(dom.window.document.querySelector('[data-reset]').hidden, false);
    } finally { dom.window.close(); }
});
