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
    const engine = ({ client, config: { accounts: [{ id: 'practice-id', limits: { min_stake: 1 } }] } });
    dom.window.loadEngineConfig = async () => engine;
    dom.window.initAccountSwitcher = async () => engine;
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
    const engine = ({ client, config: { indices, enabled_contract_types: ['EVEN', 'ODD'], accounts: [] } });
    dom.window.loadEngineConfig = async () => engine;
    dom.window.initAccountSwitcher = async () => engine;
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

/* The pages below run the real startup chain (account-context.js and
   account-switcher.js) against a fake Supabase client, so a failing RPC takes
   the same path it would in the browser. */
const liveConfig = { real_enabled: false, enabled_contract_types: ['EVEN', 'ODD'], indices: [{ code: 'SPI10', display_name: 'SmartProfit Index 10', interval_ms: 2000, decimals: 3, status: 'ACTIVE' }] };
const tickRows = (count) => Array.from({ length: count }, (_, n) => ({ index_code: 'SPI10', tick_no: 900 - n, price: (1000 + (900 - n) / 1000).toFixed(3), digit: (900 - n) % 10, scheduled_at: '2026-09-24T10:00:00Z' }));

async function openDashboard(overrides = {}) {
    const dom = new JSDOM(fs.readFileSync('pages/dashboard.html', 'utf8'), { runScripts: 'outside-only', url: 'https://example.test/pages/dashboard.html' });
    const responses = {
        enroll_practice_account: { data: 'practice-id' },
        get_engine_config: { data: liveConfig },
        list_my_accounts: { data: [{ id: 'practice-id', execution_mode: 'DEMO', currency: 'USD', status: 'ACTIVE' }] },
        get_account_summary: { data: { available: 10000, currency: 'USD' } },
        get_account_stats: { data: { wins: 0, losses: 0, voids: 0, open: 0, net_result: 0, currency: 'USD' } },
        list_my_contracts: { data: [] },
        get_recent_ticks: { data: tickRows(120) },
        get_my_active_restrictions: { data: [] },
        ...overrides,
    };
    const errors = [];
    dom.window.console.error = (...args) => errors.push(args);
    const client = { rpc: async (name) => ({ data: null, error: null, ...(responses[name] || {}) }) };
    dom.window.getSupabaseClient = async () => client;
    dom.window.drawIndexChart = () => {};
    // The shell builds the switcher in the browser; the test provides the same mount point.
    dom.window.document.querySelector('[data-shell-header]').innerHTML = '<select data-account-switcher></select><div data-restriction-banner hidden></div>';
    for (const file of ['account-context.js', 'account-keys.js', 'account-switcher.js', 'restriction-banner.js', 'dashboard.js']) dom.window.eval(fs.readFileSync(`assets/js/${file}`, 'utf8'));
    const $ = (selector) => dom.window.document.querySelector(selector);
    const settle = async (predicate) => { const started = Date.now(); while (!predicate() && Date.now() - started < 2000) await new Promise((resolve) => setTimeout(resolve, 5)); };
    return { dom, $, errors, settle };
}

test('a failed account call does not hide working market data and names what failed', async () => {
    const page = await openDashboard({ get_account_stats: { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.get_account_stats' }, status: 404 } });
    const { $ } = page;
    try {
        await page.settle(() => $('[data-index-rows] tr') && /SmartProfit Index 10/.test($('[data-index-rows]').textContent) && /could not be loaded/.test($('[data-dashboard-status]').textContent));
        assert.match($('[data-index-rows]').textContent, /SmartProfit Index 101000\.9000#900Open/);
        assert.equal(page.dom.window.document.querySelectorAll('[data-latest-ticks] .ob-mini-row').length, 10);
        assert.equal($('[data-index-count]').textContent, '1 / 1');
        assert.equal($('[data-practice-balance]').textContent, 'USD 10000.00');
        assert.equal($('[data-wins]').textContent, 'Unavailable');
        assert.equal($('[data-net-result]').textContent, 'Unavailable');
        assert.match($('[data-dashboard-status]').textContent, /Some account data could not be loaded: results\. Market data below is unaffected/);
        assert.doesNotMatch($('[data-dashboard-status]').textContent, /get_account_stats|PGRST/);
    } finally { page.dom.window.close(); }
});

test('a new Practice account sees real zeros and an explained empty history, not blanks', async () => {
    const page = await openDashboard();
    const { $ } = page;
    try {
        await page.settle(() => $('[data-wins]').textContent === '0' && /SmartProfit Index 10/.test($('[data-index-rows]').textContent));
        assert.equal($('[data-practice-balance]').textContent, 'USD 10000.00');
        assert.equal($('[data-net-result]').textContent, 'USD 0.00');
        assert.equal($('[data-losses]').textContent, '0');
        assert.equal($('[data-win-rate]').textContent, 'No results yet');
        assert.match($('[data-contract-rows]').textContent, /No contracts yet\. Contracts you buy on the Trade page appear here\./);
        assert.match($('[data-open-contracts]').textContent, /No open contracts\./);
        assert.equal($('[data-dashboard-status]').textContent, '');
        assert.equal($('[data-account-switcher]').value, 'practice-id');
    } finally { page.dom.window.close(); }
});

test('a failed Practice enrollment says so and still shows the indices', async () => {
    const page = await openDashboard({ enroll_practice_account: { data: null, error: { code: '42883', message: 'function public.enroll_practice_account() does not exist' }, status: 404 } });
    const { $ } = page;
    try {
        await page.settle(() => /Practice account could not be opened/.test($('[data-dashboard-status]').textContent) && /SmartProfit Index 10/.test($('[data-index-rows]').textContent));
        assert.match($('[data-dashboard-status]').textContent, /^Your Practice account could not be opened\. Reload the page; if this continues, contact support\.$/);
        assert.equal($('[data-practice-balance]').textContent, 'Unavailable');
        assert.equal($('[data-account-switcher]').disabled, true);
        assert.match($('[data-account-switcher]').textContent, /Account unavailable/);
        const logged = page.errors.find(([label]) => label === '[smartprofit] startup failed');
        assert.deepEqual({ step: logged[1].step, status: logged[1].status, code: logged[1].code }, { step: 'enroll_practice_account', status: 404, code: '42883' });
    } finally { page.dom.window.close(); }
});

test('an index with no published ticks says so instead of drawing an empty live chart', async () => {
    const page = await openDashboard({ get_recent_ticks: { data: [] } });
    const { $ } = page;
    try {
        await page.settle(() => /No ticks published yet/.test($('[data-chart-status]').textContent) && /No ticks yet/.test($('[data-index-rows]').textContent));
        assert.equal($('[data-chart-status]').textContent, 'No ticks published yet for SmartProfit Index 10.');
        assert.match($('[data-latest-ticks]').textContent, /No ticks published yet\./);
        assert.equal($('[data-market-state]').textContent, 'No ticks published yet');
    } finally { page.dom.window.close(); }
});
