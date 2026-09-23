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

test('dashboard index overview, chart, latest ticks and indices table come from the engine', async () => {
    const dom = new JSDOM(fs.readFileSync('pages/dashboard.html', 'utf8'), { runScripts: 'outside-only', url: 'https://example.test/pages/dashboard.html' });
    const indices = [{ code: 'SPI10', display_name: 'SmartProfit Index 10', interval_ms: 2000, decimals: 3, status: 'ACTIVE' }, { code: 'SPI25', display_name: 'SmartProfit Index 25', interval_ms: 2000, decimals: 3, status: 'PAUSED' }];
    const ticks = (code, count) => Array.from({ length: count }, (_, n) => ({ index_code: code, tick_no: 500 - n, price: (1000 + (500 - n) / 1000).toFixed(3), digit: (500 - n) % 10, scheduled_at: '2026-09-23T10:00:00Z' }));
    const drawn = [];
    const client = { rpc: async (name, args) => {
        if (name === 'get_recent_ticks') return { data: ticks(args.p_index, args.p_limit), error: null };
        if (name === 'get_account_summary') return { data: { available: '9990', currency: 'USD' }, error: null };
        if (name === 'get_account_stats') return { data: { wins: 3, losses: 1, voids: 0, open: 1, net_result: 20.9, currency: 'USD' }, error: null };
        if (name === 'list_my_contracts') return { data: args.p_state === 'OPEN' ? [{ index_code: 'SPI10', contract_type: 'EVEN', barrier: null, stake: 10, payout: 19.3, entry_tick_no: 501, settle_tick_no: 505, state: 'OPEN' }] : [], error: null };
        return { data: null, error: null };
    } };
    dom.window.initAccountSwitcher = async () => ({ client, config: { indices, enabled_contract_types: ['EVEN', 'ODD'], accounts: [] } });
    dom.window.smartProfitAccount = { get: () => ({ accountId: 'practice-id', mode: 'DEMO', currency: 'USD' }) };
    dom.window.refreshRestrictionBanner = async () => {};
    dom.window.drawIndexChart = (_canvas, series) => drawn.push(series.map((tick) => tick.tick_no));
    const $ = (selector) => dom.window.document.querySelector(selector);
    const wait = async (predicate) => { const started = Date.now(); while (!predicate() && Date.now() - started < 2000) await new Promise((resolve) => setTimeout(resolve, 5)); };
    assert.equal(dom.window.document.readyState, 'loading');
    dom.window.eval(fs.readFileSync('assets/js/dashboard.js', 'utf8'));
    await wait(() => dom.window.document.querySelectorAll('[data-index-rows] tr').length === 2 && dom.window.document.querySelectorAll('[data-latest-ticks] .ob-mini-row').length === 10);
    try {
        assert.equal($('[data-index-count]').textContent, '1 / 2');
        assert.equal($('[data-tick-interval]').textContent, '2 s');
        assert.equal($('[data-contract-types]').textContent, 'EVEN · ODD');
        assert.equal($('[data-win-rate]').textContent, '75.0%');
        assert.equal($('[data-settled-count]').textContent, '4');
        assert.match($('[data-open-contracts]').textContent, /SPI10EVEN10\.0019\.30501 → 505/);
        assert.equal(drawn.at(-1).length, 120);
        assert.equal(drawn.at(-1).at(-1), 500, 'the chart ends on the newest tick');
        assert.match($('[data-chart-title]').textContent, /SmartProfit Index 10 price/);
        assert.match($('[data-latest-ticks]').textContent, /^#5001000\.500/);
        const rows = [...dom.window.document.querySelectorAll('[data-index-rows] tr')];
        assert.match(rows[0].textContent, /SmartProfit Index 101000\.5000#500Open/);
        assert.match(rows[1].textContent, /Paused/);
        assert.equal(rows[0].querySelector('a').getAttribute('href'), 'trade.html?index=SPI10');
        $('[data-chart-indices] button:nth-child(2)').dispatchEvent(new dom.window.MouseEvent('click'));
        await wait(() => /Index 25/.test($('[data-chart-title]').textContent));
        assert.match($('[data-chart-title]').textContent, /SmartProfit Index 25 price/);
    } finally { dom.window.close(); }
});
