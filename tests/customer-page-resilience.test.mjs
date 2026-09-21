import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { createTestDatabase, claimsFor } from './helpers/test-db.mjs';

/* Two failures took the customer pages down at once, and neither of them was a
 * data problem:
 *
 *   1. account-data.js called get_my_active_restrictions() as a fatal
 *      dependency, so an RPC that was missing from the live database blanked
 *      profile, balances, orders, positions and equity for every customer.
 *   2. trade.js reported a failed market-catalog read as "This pair is not
 *      listed by the exchange.", which blamed the customer's symbol for an
 *      outage in the exchange's own list.
 *
 * These tests drive the real modules against a stubbed Supabase client so they
 * assert what the customer would actually see, not what the code intends. */

const ACCOUNT_SKELETON = `<!DOCTYPE html><html><body>
    <div id="accountRestrictionBanner" class="alert alert-danger py-2 px-3" role="status" hidden></div>
    <div data-profile-avatar>—</div>
    <h3 data-profile-name>Loading account…</h3>
    <span data-profile-email></span>
    <b data-profile-created>—</b>
    <b data-account-mode>—</b>
    <button type="button" data-mode-option="DEMO">DEMO</button>
    <button type="button" data-mode-option="REAL" disabled>REAL</button>
    <div class="balance-value" data-wallet-total-usd>—</div>
    <div class="balance-value" data-wallet-asset="USDT">0</div>
    <div class="balance-sub" data-wallet-asset-usd="USDT">≈ $0.00</div>
    <div class="balance-value" data-unrealized-pnl>—</div>
    <div class="balance-value" data-open-orders-count>—</div>
    <div class="balance-value" data-total-equity>—</div>
    <div class="balance-sub" data-account-load-status>Ledger-backed balance</div>
    <tbody id="openPositionsBody"></tbody>
    <div id="openOrdersList"></div>
    <tbody id="transactionHistoryBody"></tbody>
    <form id="profileForm">
        <input id="profileDisplayName" data-profile-display-name>
        <input data-profile-email-input>
        <p data-profile-save-status></p>
    </form>
    <label class="toggle-switch"><input type="checkbox"></label>
</body></html>`;

const TRADE_SKELETON = `<!DOCTYPE html><html><body>
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
        <div id="priceFields"><input id="orderPrice" placeholder="--" readonly></div>
        <input id="orderAmount" value="0.01">
        <input id="orderTotal" readonly>
        <button type="button" class="btn-buy-large"><span id="btnBuyText">Buy BTC</span></button>
        <button type="button" class="btn-sell-large"><span id="btnSellText">Sell BTC</span></button>
    </form>
    <div id="marketNotice" hidden></div>
</body></html>`;

const CATALOG = [
    { symbol: 'BTCUSDT', base_asset: 'BTC', display_name: 'Bitcoin', tradable: true, paused: false },
    { symbol: 'ETHUSDT', base_asset: 'ETH', display_name: 'Ethereum', tradable: true, paused: false }
];

async function settle(rounds = 12) {
    for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function thenable(value) {
    const query = { then: (resolve, reject) => Promise.resolve(value).then(resolve, reject) };
    for (const method of ['select', 'single', 'eq', 'order', 'limit', 'in', 'update']) query[method] = () => query;
    return query;
}

/* `restrictions` reproduces the two shapes a missing RPC can take: PostgREST
 * answers with a resolved { error } (PGRST202), while a transport fault rejects
 * outright. Neither may blank the page. */
async function bootAccountPage({ restrictions = 'ok', balance = 2500 } = {}) {
    const dom = new JSDOM(ACCOUNT_SKELETON, { url: 'http://localhost/pages/profile.html', runScripts: 'outside-only' });
    const { window } = dom;
    const warnings = [], errors = [], rpcCalls = [];

    const ok = (data) => ({ data, error: null });
    const client = {
        auth: {
            getSession: async () => ({ data: { session: { user: { id: 'user-1', email: 'ada@example.test' } } }, error: null }),
            onAuthStateChange() {}
        },
        from(name) {
            if (name === 'profiles') return thenable(ok({ display_name: 'Ada Lovelace', created_at: '2026-01-04T00:00:00.000Z' }));
            if (name === 'trading_accounts') return thenable(ok([{ id: 'demo-1', execution_mode: 'DEMO', base_currency: 'USD', status: 'ACTIVE', created_at: '2026-01-04T00:00:00.000Z' }]));
            if (name === 'wallets') return thenable(ok([{ id: 'wallet-usdt', asset: 'USDT', ledger_scope: 'DEMO', ledger_accounts: [{ id: 'ledger-usdt', kind: 'AVAILABLE' }] }]));
            return thenable(ok([]));
        },
        async rpc(name) {
            rpcCalls.push(name);
            if (name === 'get_my_active_restrictions') {
                if (restrictions === 'error') return { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.get_my_active_restrictions' } };
                if (restrictions === 'throws') throw new Error('network unreachable');
                if (restrictions === 'restriction') return ok([{ restriction_type: 'TRADING', reason: 'Chargeback investigation open', applied_at: '2026-02-01T00:00:00.000Z' }]);
                return ok([]);
            }
            if (name === 'account_balance_totals') return ok([{ ledger_account_id: 'ledger-usdt', amount: String(balance) }]);
            return ok([]);
        },
        channel() { return { on() { return this; }, subscribe() { return this; } }; },
        removeChannel: async () => {}
    };

    window.SMARTPROFIT_SUPABASE_CONFIG = { url: 'https://project.supabase.co' };
    window.getSupabaseClient = async () => client;
    window.console.warn = (...args) => warnings.push(args.map(String).join(' '));
    window.console.error = (...args) => errors.push(args.map(String).join(' '));

    window.eval(fs.readFileSync('assets/js/account-cache.js', 'utf8'));
    window.eval(fs.readFileSync('assets/js/account-data.js', 'utf8'));
    await settle();

    return { window, document: window.document, warnings, errors, rpcCalls };
}

async function bootTradePage({ catalog = CATALOG, catalogFails = false } = {}) {
    const dom = new JSDOM(TRADE_SKELETON, { url: 'http://localhost/pages/trade.html', runScripts: 'outside-only' });
    const { window } = dom;

    const client = {
        rpc: async (name) => {
            if (name === 'list_market_catalog') {
                return catalogFails ? { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.list_market_catalog' } } : { data: catalog, error: null };
            }
            return { data: null, error: null };
        },
        functions: { invoke: async () => ({ error: null }) }
    };

    window.getSupabaseClient = async () => client;
    window.alert = () => {};
    // No network in a unit test: Binance calls fail closed and the stream is inert.
    window.fetch = async () => ({ ok: false });
    window.WebSocket = class { constructor() {} close() {} };
    window.setInterval = () => 0;
    window.console.warn = () => {};
    window.console.error = () => {};

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

    return { window, document: window.document };
}

test('a failed restrictions read cannot blank the customer account page', async (t) => {
    for (const restrictions of ['error', 'throws']) {
        await t.test(`restrictions read failing as ${restrictions} still renders profile, balance and equity`, async () => {
            const { window, document, warnings, errors, rpcCalls } = await bootAccountPage({ restrictions });

            // The three values the customers reported as blank / "-".
            assert.equal(document.querySelector('[data-profile-name]').textContent, 'Ada Lovelace', 'profile name must render');
            assert.equal(document.querySelector('[data-wallet-asset="USDT"]').textContent, '2,500', 'USDT balance must render');
            assert.equal(document.querySelector('[data-total-equity]').textContent, '$2,500.00', 'total equity must render');
            assert.equal(document.querySelector('[data-wallet-total-usd]').textContent, '$2,500.00');

            // Every other projection still ran, so the page is not half-drawn.
            assert.equal(document.querySelector('[data-account-load-status]').textContent, 'Balances may take a few seconds to update.');
            assert.ok(rpcCalls.includes('account_balance_totals'), 'balances must still be fetched');
            assert.equal(document.querySelector('[data-open-orders-count]').textContent, '0');
            assert.equal(errors.length, 0, `the loader must not fall into its fatal catch: ${errors.join(' | ')}`);

            // The failure is reported to the console for support, but nothing is
            // shown to the customer: an internal restriction-status error must
            // never reach the banner.
            assert.equal(warnings.length > 0, true, 'the failure must be reported to the console');
            const banner = document.getElementById('accountRestrictionBanner');
            assert.equal(banner.hidden, true, 'a failed read must leave the banner hidden');
            assert.equal(banner.textContent, '');

            window.close();
        });
    }

    await t.test('an active restriction is shown with its reason', async () => {
        const { window, document, errors } = await bootAccountPage({ restrictions: 'restriction' });

        const banner = document.getElementById('accountRestrictionBanner');
        assert.equal(banner.hidden, false);
        assert.match(banner.textContent, /Chargeback investigation open/);
        assert.equal(banner.textContent.includes('Restriction status unavailable'), false);
        assert.equal(document.querySelector('[data-total-equity]').textContent, '$2,500.00');
        assert.equal(errors.length, 0);

        window.close();
    });

    await t.test('a healthy restrictions read shows no banner at all', async () => {
        const { window, document, warnings, errors } = await bootAccountPage();

        assert.equal(document.getElementById('accountRestrictionBanner').hidden, true);
        assert.equal(document.getElementById('accountRestrictionBanner').textContent, '');
        assert.equal(document.querySelector('[data-total-equity]').textContent, '$2,500.00');
        assert.equal(warnings.length, 0);
        assert.equal(errors.length, 0);

        window.close();
    });
});

test('an unavailable market catalog is never reported as an unlisted pair', async (t) => {
    await t.test('the catalog failing says the market list is unavailable and closes the form', async () => {
        const { window, document } = await bootTradePage({ catalogFails: true });
        const notice = document.getElementById('marketNotice');

        assert.equal(notice.hidden, false);
        assert.match(notice.textContent, /temporarily unavailable/);
        assert.equal(/not listed/.test(notice.textContent), false, 'a catalog outage must not blame the pair');
        assert.equal(document.querySelector('.btn-buy-large').disabled, true, 'the form must stay closed');
        assert.equal(document.querySelector('.btn-sell-large').disabled, true);
        assert.equal(window.tradabilityNotice(null), 'Market list is temporarily unavailable. Refresh to try again.');

        window.close();
    });

    await t.test('a pair absent from a loaded catalog is reported as not listed', async () => {
        const { window, document } = await bootTradePage({ catalog: CATALOG });
        const notice = document.getElementById('marketNotice');

        // The catalog loaded, so the default pair is tradable and the form is open.
        assert.equal(notice.hidden, true);
        assert.equal(document.querySelector('.btn-buy-large').disabled, false);

        // A pair the loaded catalog does not contain (what placeOrder is handed
        // when a symbol was retired mid-session) must say so, and say nothing
        // about the market list being unavailable.
        window.applyTradability(null);

        assert.equal(notice.hidden, false);
        assert.match(notice.textContent, /not listed/);
        assert.equal(/temporarily unavailable/.test(notice.textContent), false);
        assert.equal(document.querySelector('.btn-buy-large').disabled, true);
        assert.equal(window.tradabilityNotice(null), 'This pair is not listed by the exchange.');

        window.close();
    });
});

/* The incident's root cause was drift between supabase/migrations and the manual
 * bootstrap file an operator pastes into the SQL editor. This executes that file
 * for real: Section 13's self-check raises if any browser-facing RPC is missing,
 * so a green run here means the script the operator runs is complete. */
test('the live bootstrap script defines get_my_active_restrictions and self-checks it', async () => {
    const db = await createTestDatabase();

    async function as(name) {
        await db.exec('reset role');
        await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify(claimsFor(name))]);
        await db.exec('set role authenticated');
    }

    async function asAnon() {
        await db.exec('reset role');
        await db.exec('set role anon');
    }

    try {
        const raw = (await fsPromises.readFile('supabase/LIVE_ADMIN_MIGRATION_AND_BOOTSTRAP.sql', 'utf8')).replace(/^\uFEFF/, '');
        await db.exec(raw.replace(/create extension if not exists pgcrypto;/gi, '-- stripped for pglite'));

        await db.exec('reset role');
        const signatures = (await db.query(`
            select pg_get_function_result(p.oid) as result, oidvectortypes(p.proargtypes) as args
              from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname = 'get_my_active_restrictions'
        `)).rows;

        // Exactly one overload, and the shape Section 13 asserts as its expected
        // string. If Postgres ever formats this differently the self-check would
        // fail on the operator's run, so it is pinned here first.
        assert.equal(signatures.length, 1);
        assert.equal(signatures[0].result, 'TABLE(restriction_type text, reason text, applied_at timestamp with time zone)');
        assert.equal(signatures[0].args, '');

        await asAnon();
        await assert.rejects(
            db.query('select * from public.get_my_active_restrictions()'),
            /permission denied/i,
            'anon must not read restriction status'
        );

        await as('customer');
        assert.deepEqual((await db.query('select * from public.get_my_active_restrictions()')).rows, []);
    } finally {
        await db.exec('reset role');
        await db.close();
    }
});
