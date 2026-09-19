import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTestDatabase, claimsFor } from './helpers/test-db.mjs';

/* These tests cover the market registry, the object that decides whether a pair
 * can be ordered. submit_demo_order rejects unknown, non-tradable, and paused
 * symbols, so each of those paths gets an explicit assertion: the pause control
 * used to be write-only, and an untested write-only control is how it stayed
 * that way. */

async function scalar(db, sql, args = []) {
    return (await db.query(sql, args)).rows[0]?.result;
}

async function as(db, name, aal = 'aal2') {
    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify(claimsFor(name, aal))]);
    await db.exec('set role authenticated');
}

async function placeOrder(db, symbol, clientOrderId = randomUUID()) {
    return scalar(
        db,
        'select (public.submit_demo_order($1, $2, $3::public.order_side, $4::public.order_type, $5, $6, null, $7)).id as result',
        [clientOrderId, symbol, 'BUY', 'LIMIT', 0.01, 50000, clientOrderId]
    );
}

test('Market registry: listing, executability, and order rejection paths', async (t) => {
    const db = await createTestDatabase();

    try {
        await t.test('the registry seeds both tradable and display-only pairs', async () => {
            await as(db, 'customer');
            const catalog = await scalar(db, 'select public.list_market_catalog() as result');
            assert.ok(Array.isArray(catalog));
            assert.equal(catalog.length, 75);

            const bySymbol = Object.fromEntries(catalog.map((row) => [row.symbol, row]));
            assert.equal(bySymbol.BTCUSDT.tradable, true);
            assert.equal(bySymbol.ETHUSDT.tradable, true);
            assert.equal(bySymbol.BTCUSDT.paused, false);
            assert.equal(bySymbol.SOLUSDT.tradable, false);
            assert.equal(bySymbol.SOLUSDT.base_asset, 'SOL');
            assert.equal(bySymbol.SOLUSDT.display_name, 'Solana');

            for (const row of catalog) {
                assert.ok(row.symbol.endsWith('USDT'));
                assert.equal(typeof row.base_asset, 'string');
                assert.equal(typeof row.display_name, 'string');
                assert.equal(typeof row.tradable, 'boolean');
                assert.equal(typeof row.paused, 'boolean');
            }
        });

        await t.test('the browser catalogue agrees with the registry table row count', async () => {
            // The table is revoked from every client role and the RPC is the only
            // supported read path, so the count is taken as the migration owner.
            await db.exec('reset role');
            const tableCount = await db.query('select count(*)::int as n from public.market_symbols');
            const catalogCount = await scalar(db, 'select jsonb_array_length(public.list_market_catalog()) as result');
            assert.equal(catalogCount, tableCount.rows[0].n);
        });

        await t.test('list_executable_symbols returns only tradable, unpaused pairs', async () => {
            // Granted to service_role alone: the browser must never read the
            // quote worker's watchlist directly.
            await db.exec('reset role');
            const executable = await scalar(db, 'select public.list_executable_symbols() as result');
            assert.deepEqual(executable.sort(), ['BTCUSDT', 'ETHUSDT']);
        });

        await t.test('an unregistered symbol is rejected before pricing', async () => {
            await as(db, 'customer');
            await assert.rejects(placeOrder(db, 'FAKECOINUSDT'), /unknown symbol/);
        });

        await t.test('a listed but non-tradable symbol is rejected', async () => {
            await as(db, 'customer');
            await assert.rejects(placeOrder(db, 'SOLUSDT'), /symbol_not_tradable/);
        });

        await t.test('a tradable, unpaused symbol is accepted', async () => {
            await as(db, 'customer');
            const orderId = await placeOrder(db, 'ETHUSDT');
            assert.ok(orderId);
        });
    } finally {
        await db.close();
    }
});

test('Market registry: the pause control is enforced by submit_demo_order', async (t) => {
    const db = await createTestDatabase();

    try {
        await t.test('an operator can pause a tradable pair', async () => {
            await as(db, 'administrator');
            const result = await scalar(
                db,
                'select public.set_symbol_trading_status($1, $2, $3) as result',
                ['BTCUSDT', true, 'Upstream feed maintenance']
            );
            assert.equal(result.trading_paused, true);
            assert.equal(result.tradable, true);

            await db.exec('reset role');
            const executable = await scalar(db, 'select public.list_executable_symbols() as result');
            assert.deepEqual(executable, ['ETHUSDT'], 'a paused pair must leave the executable set');

            const catalog = await scalar(db, 'select public.list_market_catalog() as result');
            assert.equal(catalog.find((row) => row.symbol === 'BTCUSDT').paused, true);
        });

        await t.test('a paused pair cannot be ordered', async () => {
            await as(db, 'customer');
            await assert.rejects(placeOrder(db, 'BTCUSDT'), /symbol_trading_paused/);
        });

        await t.test('an operator can resume the pair and ordering works again', async () => {
            await as(db, 'administrator');
            await scalar(
                db,
                'select public.set_symbol_trading_status($1, $2, $3) as result',
                ['BTCUSDT', false, 'Maintenance complete']
            );
            await db.exec('reset role');
            const executable = await scalar(db, 'select public.list_executable_symbols() as result');
            assert.deepEqual(executable.sort(), ['BTCUSDT', 'ETHUSDT']);

            await as(db, 'customer');
            const orderId = await placeOrder(db, 'BTCUSDT');
            assert.ok(orderId);
        });

        await t.test('a non-tradable pair cannot be resumed into execution', async () => {
            await as(db, 'administrator');
            await assert.rejects(
                scalar(db, 'select public.set_symbol_trading_status($1, $2, $3) as result', ['SOLUSDT', false, 'Attempted listing']),
                /symbol_not_tradable/
            );
        });

        await t.test('pausing an unregistered symbol is refused', async () => {
            await as(db, 'administrator');
            await assert.rejects(
                scalar(db, 'select public.set_symbol_trading_status($1, $2, $3) as result', ['FAKECOINUSDT', true, 'Unknown symbol']),
                /unsupported symbol/
            );
        });

        await t.test('only staff with markets.manage may change symbol status', async () => {
            await as(db, 'agent');
            await assert.rejects(
                scalar(db, 'select public.set_symbol_trading_status($1, $2, $3) as result', ['BTCUSDT', true, 'Agent attempt']),
                /forbidden/
            );
        });
    } finally {
        await db.close();
    }
});

test('Market registry: the executable set is not directly readable by clients', async (t) => {
    const db = await createTestDatabase();

    try {
        for (const role of ['anon', 'authenticated']) {
            await db.exec('reset role');
            await db.exec(`set role ${role}`);
            await assert.rejects(
                db.query('select public.list_executable_symbols()'),
                /permission denied/i,
                `${role} must not read the quote worker's watchlist`
            );
        }
    } finally {
        await db.exec('reset role');
        await db.close();
    }
});
