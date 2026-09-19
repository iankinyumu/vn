import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

/* The trading page must take its pair universe from the market registry and
 * nothing else. Before this wiring existed, trade.js carried a 78-row TOP_75_COINS
 * array while public.market_symbols held 75 rows, so the page could offer a pair
 * the engine would refuse. These tests drive the real trade.js against a stub
 * registry and assert what the customer would actually see. */

const CATALOG = [
    { symbol: 'BTCUSDT', base_asset: 'BTC', display_name: 'Bitcoin', tradable: true, paused: false },
    { symbol: 'ETHUSDT', base_asset: 'ETH', display_name: 'Ethereum', tradable: true, paused: false },
    { symbol: 'SOLUSDT', base_asset: 'SOL', display_name: 'Solana', tradable: false, paused: false }
];

function catalogWithPausedBitcoin() {
    return CATALOG.map((row) => (row.symbol === 'BTCUSDT' ? { ...row, paused: true } : row));
}

const SKELETON = `<!DOCTYPE html><html><body>
    <div id="tickerTrack" class="ticker-track"></div>
    <button id="pairSelectorBtn" data-bs-toggle="dropdown"></button>
    <span id="currentPairBadge">BTC</span>
    <span id="currentPairText">BTC/USDT</span>
    <div id="pairListContainer"></div>
    <span id="headerBtcPrice">--</span><span id="headerBtcChange">--</span>
    <span id="wsStatusBadge"><span id="wsStatusText"></span></span>
    <span id="ohlcOpen"></span><span id="ohlcHigh"></span><span id="ohlcLow"></span>
    <span id="ohlcClose"></span><span id="ohlcChange"></span><span id="ohlcVolume"></span>
    <span id="orderBookBaseLabel">BTC</span><span id="tradeFormAmountLabel">BTC</span>
    <div id="orderBookAsks"></div><div id="orderBookBids"></div><div class="spread-price"></div>
    <div id="recentTrades"></div><div id="openPositionsBody"></div><div id="openOrdersList"></div>
    <form id="tradeForm">
        <button type="button" class="order-type-btn active">Limit</button>
        <button type="button" class="order-type-btn">Market</button>
        <div id="limitFields">
            <input id="orderPrice" value="50000">
            <input id="orderAmount" value="0.01">
            <input id="orderTotal" readonly>
        </div>
        <button type="button" class="btn-buy-large"><span id="btnBuyText">Buy BTC</span></button>
        <button type="button" class="btn-sell-large"><span id="btnSellText">Sell BTC</span></button>
    </form>
    <div id="marketNotice" hidden></div>
</body></html>`;

async function settle(rounds = 8) {
    for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function bootTradePage({ catalog = CATALOG, search = '', quoteError = null } = {}) {
    const dom = new JSDOM(SKELETON, { url: `http://localhost/pages/trade.html${search}`, runScripts: 'outside-only' });
    const { window } = dom;
    const calls = { rpc: [], invoke: [] };
    const alerts = [];

    const client = {
        rpc: async (name) => {
            calls.rpc.push(name);
            if (name === 'list_market_catalog') return { data: catalog, error: null };
            return { data: null, error: null };
        },
        functions: {
            invoke: async (name) => {
                calls.invoke.push(name);
                return { error: quoteError };
            }
        }
    };

    window.getSupabaseClient = async () => client;
    window.alert = (message) => alerts.push(message);
    // No network in a unit test. Binance calls fail closed, and the stream is inert.
    window.fetch = async () => ({ ok: false });
    window.WebSocket = class { constructor() {} close() {} };
    // The page refreshes the book and tape on an interval; a test does not need it
    // and a pending interval would keep the process alive.
    window.setInterval = () => 0;
    window.smartProfitAccountData = { account: { execution_mode: 'DEMO', status: 'ACTIVE' }, balances: [] };
    // trade.js logs every failed Binance call; expected noise in a unit test.
    window.console.warn = () => {};
    window.console.error = () => {};

    for (const file of ['assets/js/market-registry.js', 'assets/js/market-ticker.js', 'assets/js/trade.js']) {
        window.eval(fs.readFileSync(file, 'utf8'));
    }

    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
    await settle();

    return { dom, window, calls, alerts, document: window.document };
}

function enabledState(document) {
    const form = document.getElementById('tradeForm');
    return {
        inputsDisabled: Array.from(form.querySelectorAll('input')).every((el) => el.disabled),
        buyDisabled: document.querySelector('.btn-buy-large').disabled,
        sellDisabled: document.querySelector('.btn-sell-large').disabled,
        noticeHidden: document.getElementById('marketNotice').hidden,
        notice: document.getElementById('marketNotice').textContent
    };
}

test('the trading page lists exactly the pairs the registry returns', async () => {
    const { window, document } = await bootTradePage();
    const items = Array.from(document.querySelectorAll('#pairListContainer .pair-list-item'));

    assert.equal(items.length, CATALOG.length);
    assert.deepEqual(items.map((el) => el.dataset.symbol), ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
    assert.ok(!document.getElementById('pairListContainer').textContent.includes('Market list unavailable'));
    window.close();
});

test('the ticker shows registry pairs with placeholders, never invented prices', async () => {
    const { window, document } = await bootTradePage();
    const track = document.getElementById('tickerTrack');

    // Rendered once and duplicated for the CSS marquee.
    assert.equal(track.querySelectorAll('.ticker-item').length, CATALOG.length * 2);
    assert.ok(track.textContent.includes('BTC/USDT'));
    assert.ok(track.textContent.includes('SOL/USDT'));
    assert.ok(!track.textContent.includes('Market list unavailable'));

    // No tick has arrived, so every cell stays a placeholder rather than a number.
    for (const symbol of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']) {
        assert.equal(document.getElementById(`ticker-price-${symbol}`).textContent, '--');
        assert.equal(document.getElementById(`ticker-change-${symbol}`).textContent, '--');
    }
    window.close();
});

test('a tradable pair leaves the order form enabled', async () => {
    const { window, document } = await bootTradePage();
    const state = enabledState(document);

    assert.equal(state.inputsDisabled, false);
    assert.equal(state.buyDisabled, false);
    assert.equal(state.sellDisabled, false);
    assert.equal(state.noticeHidden, true);
    assert.equal(document.getElementById('currentPairText').textContent, 'BTC/USDT');
    assert.equal(document.getElementById('btnBuyText').textContent, 'Buy BTC');
    window.close();
});

test('selecting a listed but non-tradable pair disables the order form', async () => {
    const { window, document } = await bootTradePage();
    window.switchAsset('SOLUSDT');
    await settle();

    const state = enabledState(document);
    assert.equal(state.inputsDisabled, true, 'the form must not accept an order for a display-only pair');
    assert.equal(state.buyDisabled, true);
    assert.equal(state.sellDisabled, true);
    assert.equal(state.noticeHidden, false);
    assert.match(state.notice, /reference only/);
    assert.equal(document.getElementById('tradeFormAmountLabel').textContent, 'SOL');
    window.close();
});

test('selecting a paused pair disables the order form and says why', async () => {
    const { window, document } = await bootTradePage({ catalog: catalogWithPausedBitcoin() });
    const state = enabledState(document);

    assert.equal(state.inputsDisabled, true);
    assert.equal(state.noticeHidden, false);
    assert.match(state.notice, /paused/i);
    window.close();
});

test('placing an order for a non-tradable pair is refused before any network call', async () => {
    const { window, document, calls, alerts } = await bootTradePage();
    window.switchAsset('SOLUSDT');
    await settle();
    calls.rpc.length = 0;
    calls.invoke.length = 0;

    await window.placeOrder('buy');
    await settle();

    assert.equal(calls.invoke.length, 0, 'a display-only pair must not reach the quote function');
    assert.equal(calls.rpc.filter((name) => name === 'submit_demo_order').length, 0);
    assert.equal(alerts.length, 1);
    assert.match(alerts[0], /reference only/);
    assert.ok(document);
    window.close();
});

test('placing an order for a tradable pair passes the client-side guard', async () => {
    // The quote call returns an error, which stops the flow after the guard and
    // before the order RPC — enough to prove the guard did not block a valid pair.
    const { window, calls, alerts } = await bootTradePage({ quoteError: new Error('quote unavailable') });
    calls.invoke.length = 0;

    await window.placeOrder('buy');
    await settle();

    assert.deepEqual(calls.invoke, ['refresh-market-quote']);
    assert.equal(calls.rpc.filter((name) => name === 'submit_demo_order').length, 0);
    assert.equal(alerts.length, 1);
    assert.match(alerts[0], /quote unavailable/);
    window.close();
});

test('?symbol= selects a listed pair and ignores one the registry does not list', async () => {
    const listed = await bootTradePage({ search: '?symbol=ETHUSDT' });
    assert.equal(listed.document.getElementById('currentPairText').textContent, 'ETH/USDT');
    assert.equal(listed.document.getElementById('tradeFormAmountLabel').textContent, 'ETH');
    listed.window.close();

    const unlisted = await bootTradePage({ search: '?symbol=FAKECOINUSDT' });
    assert.equal(unlisted.document.getElementById('currentPairText').textContent, 'BTC/USDT');
    unlisted.window.close();
});

test('?symbol= for a listed but non-tradable pair still disables the form', async () => {
    const { window, document } = await bootTradePage({ search: '?symbol=SOLUSDT' });
    const state = enabledState(document);

    assert.equal(document.getElementById('currentPairText').textContent, 'SOL/USDT');
    assert.equal(state.inputsDisabled, true);
    assert.equal(state.noticeHidden, false);
    assert.match(state.notice, /reference only/);
    window.close();
});

test('an unreachable registry fails closed instead of offering pairs', async () => {
    const dom = new JSDOM(SKELETON, { url: 'http://localhost/pages/trade.html', runScripts: 'outside-only' });
    const { window } = dom;
    window.getSupabaseClient = async () => ({ rpc: async () => ({ data: null, error: new Error('offline') }) });
    window.alert = () => {};
    window.fetch = async () => ({ ok: false });
    window.WebSocket = class { constructor() {} close() {} };
    window.setInterval = () => 0;
    window.console.warn = () => {};
    window.console.error = () => {};

    for (const file of ['assets/js/market-registry.js', 'assets/js/market-ticker.js', 'assets/js/trade.js']) {
        window.eval(fs.readFileSync(file, 'utf8'));
    }
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
    await settle();

    const document = window.document;
    assert.equal(document.querySelectorAll('#pairListContainer .pair-list-item').length, 0);
    assert.equal(document.getElementById('tickerTrack').textContent.includes('Market list unavailable'), true);

    const state = enabledState(document);
    assert.equal(state.inputsDisabled, true, 'an unknown pair universe must not be orderable');
    assert.equal(state.buyDisabled, true);
    assert.equal(state.noticeHidden, false);
    window.close();
});

test('trade.js keeps no copy of the pair universe', () => {
    const source = fs.readFileSync('assets/js/trade.js', 'utf8');
    assert.ok(!source.includes('TOP_75_COINS'), 'the hardcoded coin array must stay deleted');
    assert.ok(source.includes('SmartProfitMarkets'), 'trade.js must read the registry');

    // Exactly one symbol literal is legitimate: the default pair the page opens on
    // before the registry answers. A hardcoded list would show up as many more.
    const symbols = source.match(/symbol:\s*'[A-Z]+USDT'/g) || [];
    assert.equal(symbols.length, 1, `expected only the default pair, found ${symbols.join(', ')}`);
    assert.match(source, /symbol:\s*'BTCUSDT'/);
});

test('trade.html loads the registry and ticker modules before trade.js', () => {
    const html = fs.readFileSync('pages/trade.html', 'utf8');
    const registry = html.indexOf('assets/js/market-registry.js');
    const ticker = html.indexOf('assets/js/market-ticker.js');
    const trade = html.indexOf('assets/js/trade.js');

    assert.ok(registry > -1, 'trade.html must load the registry module');
    assert.ok(ticker > -1, 'trade.html must load the ticker module');
    assert.ok(registry < trade && ticker < trade, 'both modules must load before trade.js runs');
});
