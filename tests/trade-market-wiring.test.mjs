import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

/* The trading page must take its pair universe from the market registry and
 * nothing else, and every order outcome must be explained to the customer.
 * These tests drive the real trade.js / order-form.js / order-errors.js against
 * a stub registry, a stub client and a stub console, so they assert what a
 * customer would actually see: the inline status text, the field visibility, the
 * payload sent to submit_demo_order and the sentence shown when it fails. */

const CATALOG = [
    { symbol: 'BTCUSDT', base_asset: 'BTC', display_name: 'Bitcoin', tradable: true, paused: false },
    { symbol: 'ETHUSDT', base_asset: 'ETH', display_name: 'Ethereum', tradable: true, paused: false },
    { symbol: 'SOLUSDT', base_asset: 'SOL', display_name: 'Solana', tradable: false, paused: false }
];

function catalogWithPausedBitcoin() {
    return CATALOG.map((row) => (row.symbol === 'BTCUSDT' ? { ...row, paused: true } : row));
}

/* The form now carries a side selector, an exact-match order-type selector, a
 * separate stop-price field for stop-limit orders and an aria-live status
 * region - all of which trade.js addresses by id or data attribute. */
const SKELETON = `<!DOCTYPE html><html><body>
    <div id="tickerTrack" class="ticker-track"></div>
    <button id="pairSelectorBtn" data-bs-toggle="dropdown"></button>
    <span id="currentPairBadge">BTC</span>
    <span id="currentPairText">BTC/USDT</span>
    <div id="pairListContainer"></div>
    <span id="headerPrice">--</span><span id="headerChange">--</span>
    <span id="wsStatusBadge"><span id="wsStatusText"></span></span>
    <span id="ohlcOpen"></span><span id="ohlcHigh"></span><span id="ohlcLow"></span>
    <span id="ohlcClose"></span><span id="ohlcChange"></span><span id="ohlcVolume"></span>
    <span id="orderBookBaseLabel">BTC</span><span id="tradeFormAmountLabel">BTC</span>
    <div id="orderBookAsks"></div><div id="orderBookBids"></div><div class="spread-price"></div>
    <div id="recentTrades"></div><div id="openPositionsBody"></div><div id="openOrdersList"></div>
    <span data-wallet-asset-label></span>
    <div data-wallet-asset="BTC"></div>
    <div data-wallet-asset-usd="BTC"></div>
    <form id="tradeForm">
        <div id="sideToggle">
            <button type="button" class="side-btn active" data-order-side="buy" aria-pressed="true">Buy</button>
            <button type="button" class="side-btn" data-order-side="sell" aria-pressed="false">Sell</button>
        </div>
        <div id="orderTypeToggle">
            <button type="button" class="order-type-btn active" data-order-type="limit" aria-pressed="true">Limit</button>
            <button type="button" class="order-type-btn" data-order-type="market" aria-pressed="false">Market</button>
            <button type="button" class="order-type-btn" data-order-type="stop_limit" aria-pressed="false">Stop Limit</button>
        </div>
        <div id="priceFields"><input id="orderPrice"></div>
        <div id="stopFields" hidden><input id="orderStopPrice"></div>
        <input id="orderAmount">
        <button type="button" class="preset-btn" data-preset="25">25%</button>
        <button type="button" class="preset-btn" data-preset="50">50%</button>
        <button type="button" class="preset-btn" data-preset="75">75%</button>
        <button type="button" class="preset-btn" data-preset="100">100%</button>
        <label id="orderTotalLabel">Total (USDT)</label>
        <input id="orderTotal" readonly>
        <button type="button" class="btn-buy-large" data-order-side="buy"><span id="btnBuyText">Buy BTC</span></button>
        <button type="button" class="btn-sell-large" data-order-side="sell"><span id="btnSellText">Sell BTC</span></button>
    </form>
    <div id="marketNotice" hidden></div>
    <div id="orderStatus" class="order-status" role="status" aria-live="polite" hidden></div>
</body></html>`;

async function settle(rounds = 8) {
    for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** A thenable PostgREST-style read chain, so `await client.from(t)...` resolves. */
function readChain(rows) {
    const query = {
        select: () => query, eq: () => query, order: () => query, limit: () => query,
        then: (resolve) => Promise.resolve({ data: rows, error: null }).then(resolve)
    };
    return query;
}

function defaultOrder(params) {
    return {
        id: 'order-1',
        state: 'OPEN',
        type: params.p_type,
        side: params.p_side,
        symbol: params.p_symbol,
        quantity: params.p_quantity,
        limit_price: params.p_limit_price,
        stop_price: params.p_stop_price
    };
}

async function bootTradePage({
    catalog = CATALOG,
    search = '',
    quoteError = null,
    orderResult = null,
    fills = [],
    consoleError = null
} = {}) {
    const dom = new JSDOM(SKELETON, { url: `http://localhost/pages/trade.html${search}`, runScripts: 'outside-only' });
    const { window } = dom;
    const calls = { rpc: [], invoke: [], from: [] };
    const logs = { warn: [], error: [] };
    const alerts = [];

    const client = {
        rpc: async (name, params) => {
            calls.rpc.push({ name, params });
            if (name === 'list_market_catalog') return { data: catalog, error: null };
            if (name === 'submit_demo_order') return orderResult ? orderResult(params) : { data: defaultOrder(params), error: null };
            return { data: null, error: null };
        },
        functions: {
            invoke: async (name, options) => {
                calls.invoke.push({ name, options });
                return quoteError ? { data: null, error: quoteError } : { data: { snapshot: { id: 'snap-1' } }, error: null };
            }
        },
        from: (table) => {
            calls.from.push(table);
            return table === 'fills' ? readChain(fills) : readChain([]);
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
    window.smartProfitAccountData = {
        account: { execution_mode: 'DEMO', status: 'ACTIVE' },
        balances: [
            { asset: 'USDT', available: 10000 },
            { asset: 'BTC', available: 0.25 },
            { asset: 'ETH', available: 2 }
        ]
    };
    // trade.js logs every failed Binance call and every rejected order; a test
    // asserts on those logs, so they are captured rather than silenced.
    window.console.warn = (...parts) => logs.warn.push(parts.join(' '));
    window.console.error = consoleError || ((...parts) => {
        logs.error.push(parts.map((part) => (part && part.message) || String(part)).join(' '));
    });

    for (const file of [
        'assets/js/market-registry.js',
        'assets/js/market-ticker.js',
        'assets/js/order-form.js',
        'assets/js/order-errors.js',
        'assets/js/trade.js'
    ]) {
        window.eval(fs.readFileSync(file, 'utf8'));
    }

    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
    await settle();

    return { dom, window, calls, alerts, logs, document: window.document };
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

function statusOf(document) {
    const region = document.getElementById('orderStatus');
    return { hidden: region.hidden, message: region.textContent, className: region.className };
}

function chooseOrderType(document, type) {
    document.querySelector(`#orderTypeToggle .order-type-btn[data-order-type="${type}"]`).click();
}

function chooseSide(document, side) {
    document.querySelector(`#sideToggle .side-btn[data-order-side="${side}"]`).click();
}

function submitCalls(calls) {
    return calls.rpc.filter((call) => call.name === 'submit_demo_order');
}

/** A FunctionsHttpError carries the server's JSON envelope on `.context`. */
function httpError(code) {
    return Object.assign(new Error('Edge Function returned a non-2xx status code'), {
        name: 'FunctionsHttpError',
        context: new Response(
            JSON.stringify({ error: { code, message: 'server text that must not reach the customer' }, request_id: 'ABCD1234' }),
            { status: 503, headers: { 'content-type': 'application/json' } }
        )
    });
}

function transportError() {
    return Object.assign(new Error('Failed to send a request to the Edge Function'), { name: 'FunctionsFetchError' });
}

function referenceIn(message) {
    const match = /Reference: ([0-9A-F]{8})/.exec(message);
    return match ? match[1] : null;
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
    assert.equal(submitCalls(calls).length, 0);
    assert.equal(alerts.length, 0, 'the order flow no longer uses alert()');
    assert.match(statusOf(document).message, /reference only/);
    window.close();
});

test('placing an order for a tradable pair passes the client-side guard', async () => {
    // The quote call returns an unmapped error, which stops the flow after the
    // guard and before the order RPC - enough to prove the guard let it through.
    const { window, calls, document } = await bootTradePage({ quoteError: new Error('quote unavailable') });
    document.getElementById('orderAmount').value = '0.001';
    calls.invoke.length = 0;

    await window.placeOrder('buy');
    await settle();

    assert.deepEqual(calls.invoke.map((call) => call.name), ['refresh-market-quote']);
    assert.equal(calls.invoke[0].options.body.symbol, 'BTCUSDT');
    assert.equal(submitCalls(calls).length, 0);
    // An unmapped failure is never shown verbatim: the customer gets the neutral
    // fallback plus a reference, not the raw quote error.
    const status = statusOf(document);
    assert.equal(status.hidden, false);
    assert.match(status.message, /couldn't place your order/i);
    assert.equal(/quote unavailable/.test(status.message), false);
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

test('the default pair comes from the registry, not a literal in trade.js', async () => {
    // BTCUSDT is listed but paused, so the registry's first *orderable* pair is
    // ETHUSDT. A hardcoded default would still open on BTC.
    const pausedBitcoin = catalogWithPausedBitcoin();
    const { window, document } = await bootTradePage({ catalog: pausedBitcoin });

    assert.equal(document.getElementById('currentPairText').textContent, 'ETH/USDT');
    assert.equal(document.getElementById('tradeFormAmountLabel').textContent, 'ETH');
    window.close();
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
    const { window, document } = await bootTradePage({ catalog: null });

    assert.equal(document.querySelectorAll('#pairListContainer .pair-list-item').length, 0);
    assert.equal(document.getElementById('tickerTrack').textContent.includes('Market list unavailable'), true);

    const state = enabledState(document);
    assert.equal(state.inputsDisabled, true, 'an unknown pair universe must not be orderable');
    assert.equal(state.buyDisabled, true);
    assert.equal(state.noticeHidden, false);
    assert.match(state.notice, /Market list is temporarily unavailable/);

    await window.placeOrder('buy');
    await settle();
    assert.match(statusOf(document).message, /Market list is temporarily unavailable/);
    window.close();
});

test('trade.js keeps no copy of the pair universe', () => {
    const source = fs.readFileSync('assets/js/trade.js', 'utf8');
    assert.ok(!source.includes('TOP_75_COINS'), 'the hardcoded coin array must stay deleted');
    assert.ok(source.includes('SmartProfitMarkets'), 'trade.js must read the registry');
    assert.ok(!source.includes("'BTCUSDT'"), 'the default pair must come from the registry, not a literal');
    assert.ok(!source.includes('headerBtcPrice'), 'price readout ids must be pair-neutral');
    assert.ok(!source.includes('setAmountPercent(25)'), 'presets must be wired, not inlined per button');
    assert.ok(!source.includes('alert('), 'the order flow reports inline, not through alert()');
});

test('trade.html loads the registry, ticker and form modules before trade.js', () => {
    const html = fs.readFileSync('pages/trade.html', 'utf8');
    const registry = html.indexOf('assets/js/market-registry.js');
    const ticker = html.indexOf('assets/js/market-ticker.js');
    const form = html.indexOf('assets/js/order-form.js');
    const errors = html.indexOf('assets/js/order-errors.js');
    const trade = html.indexOf('assets/js/trade.js');

    assert.ok(registry > -1, 'trade.html must load the registry module');
    assert.ok(ticker > -1, 'trade.html must load the ticker module');
    assert.ok(form > -1, 'trade.html must load the order-form module');
    assert.ok(errors > -1, 'trade.html must load the order-errors module');
    for (const index of [registry, ticker, form, errors]) {
        assert.ok(index < trade, 'every module trade.js depends on must load first');
    }
    assert.ok(!html.includes('placeholder="67,845.32"'), 'the hardcoded price placeholder must be gone');
    assert.ok(!html.includes('headerBtcPrice'), 'the BTC-named header price must be renamed');
    assert.ok(html.includes('id="orderStatus"'), 'the inline status region must exist');
    assert.ok(html.includes('id="orderStopPrice"'), 'stop-limit orders need their own stop-price input');
    assert.ok(html.includes('data-order-type="stop_limit"'), 'order types must be matched by data attribute');
});
