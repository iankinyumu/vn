import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { createQuoteCache } from '../supabase/functions/_shared/quote-cache.mjs';

function browserCache(storage = {}) {
    Object.defineProperties(storage, {
        getItem: { configurable: true, value(key) { return this[key] ?? null; } },
        setItem: { configurable: true, value(key, value) { this[key] = value; } },
        removeItem: { configurable: true, value(key) { delete this[key]; } }
    });
    let time = 1000;
    const context = { window: {}, sessionStorage: storage, Date: { now: () => time } };
    vm.runInNewContext(fs.readFileSync(new URL('../assets/js/account-cache.js', import.meta.url), 'utf8'), context);
    return { cache: context.window.smartProfitCache, storage, tick: (n) => time += n };
}

test('account cache survives navigation, expires, and separates users/accounts/modes', async () => {
    const b = browserCache(); let reads = 0;
    const load = async () => ({ data: ++reads });
    await Promise.all(Array.from({ length: 100 }, () => b.cache.read('project:user:DEMO', 'account-a', load)));
    assert.equal(reads, 1);
    await browserCache(b.storage).cache.read('project:user:DEMO', 'account-a', load);
    assert.equal(reads, 1);
    for (const [scope, key] of [['project:other:DEMO', 'account-a'], ['project:user:REAL', 'account-a'], ['project:user:DEMO', 'account-b']]) await b.cache.read(scope, key, load);
    assert.equal(reads, 4);
    b.tick(15001); await b.cache.read('project:user:DEMO', 'account-a', load);
    assert.equal(reads, 5);
    b.cache.clear(); assert.equal(Object.keys(b.storage).length, 0);
});

test('invalidation cannot be undone by an older pending read; errors are not cached', async () => {
    const b = browserCache(); let finish;
    const pending = b.cache.read('u', 'x', () => new Promise((r) => finish = r));
    await Promise.resolve(); b.cache.clear(); finish({ data: 'old' }); await pending;
    assert.equal(Object.keys(b.storage).length, 0);
    let reads = 0;
    for (let i = 0; i < 2; i++) await b.cache.read('u', 'x', async () => ({ error: ++reads }));
    assert.equal(reads, 2);
});

function quoteFixture() {
    const values = new Map(); let provider = 0, writes = 0, time = Date.now(), fail = false;
    const env = (key) => ({ UPSTASH_REDIS_REST_URL: 'https://redis.test', UPSTASH_REDIS_REST_TOKEN: 'test', SUPABASE_URL: 'project-test' })[key];
    const fetcher = async (url, options) => {
        if (fail) throw Error('offline');
        if (url.startsWith('https://api.binance.com')) { provider++; return Response.json({ bidPrice: '100', askPrice: '101' }); }
        const [op, key, val, ...rest] = JSON.parse(options.body);
        let result;
        if (op === 'GET') result = values.get(key) ?? null;
        else if (op === 'SET') {
            if (rest.includes('NX') && values.has(key)) result = null;
            else { values.set(key, val); result = 'OK'; }
        } else if (op === 'EVAL') {
            const actualKey = rest[0];
            if (key.includes('INCR')) { result = (values.get(actualKey) || 0) + 1; values.set(actualKey, result); }
            else { if (values.get(actualKey) === rest[1]) values.delete(actualKey); result = 1; }
        }
        return Response.json({ result });
    };
    const admin = { from: () => ({ insert: (data) => ({ select: () => ({ abortSignal: () => ({ single: async () => ({ data: { ...data, id: String(++writes) } }) }) }) }) }) };
    return { cache: () => createQuoteCache({ env, fetcher, now: () => time }), admin, values,
        stats: () => ({ provider, writes }), tick: (n) => time += n, fail: () => fail = true };
}

test('100 competing workers produce one upstream quote and one database write', async () => {
    const f = quoteFixture(); let matches = 0;
    const results = await Promise.allSettled(Array.from({ length: 100 }, () => f.cache().getSnapshot(f.admin, 'BTCUSDT', async () => { matches++; })));
    assert.deepEqual(f.stats(), { provider: 1, writes: 1 });
    assert.equal(matches, 1);
    assert(results.some((r) => r.status === 'fulfilled'));
    for (const result of results.filter((r) => r.status === 'rejected')) assert.equal(result.reason.status, 503);
    const cached = await f.cache().getSnapshot(f.admin, 'BTCUSDT');
    assert.equal(cached.id, '1'); assert.equal(f.stats().writes, 1);
    f.tick(3001); await f.cache().getSnapshot(f.admin, 'BTCUSDT');
    assert.equal(f.stats().writes, 2);
    await f.cache().getSnapshot(f.admin, 'ETHUSDT'); assert.equal(f.stats().writes, 3);
});

test('failed matching does not publish a successful cache entry and releases the lock', async () => {
    const f = quoteFixture();
    await assert.rejects(f.cache().getSnapshot(f.admin, 'BTCUSDT', async () => { throw Error('matching failed'); }), /matching failed/);
    assert.equal([...f.values.keys()].filter((k) => k.includes('quote:')).length, 0);
    const retry = await f.cache().getSnapshot(f.admin, 'BTCUSDT');
    assert.equal(retry.id, '2');
});

test('Redis outage/missing config never falls through to the database; rate limiting is per user', async () => {
    const f = quoteFixture();
    for (let i = 0; i < 30; i++) await f.cache().rateLimit('a');
    await assert.rejects(f.cache().rateLimit('a'), (e) => e.status === 429);
    await f.cache().rateLimit('b');
    f.fail(); await assert.rejects(f.cache().getSnapshot(f.admin, 'BTCUSDT'), (e) => e.status === 503);
    assert.deepEqual(f.stats(), { provider: 0, writes: 0 });
    await assert.rejects(createQuoteCache({ env: () => undefined }).getSnapshot(f.admin, 'BTCUSDT'), /not configured/);
});

test('account pages reuse reads across navigation and refresh once after an order event', async () => {
    const { cache } = browserCache(); let queries = 0, subscriptions = 0, onOrder;
    const data = {
        profiles: { display_name: 'Trader' },
        trading_accounts: [{ id: 'demo-account', execution_mode: 'DEMO', status: 'ACTIVE' }],
        wallets: [{ asset: 'USDT', ledger_accounts: [{ id: 'cash', kind: 'AVAILABLE' }] }],
        orders: [], positions: [], account_balance_totals: [{ ledger_account_id: 'cash', amount: '1000' }]
    };
    function query(name) {
        const q = { then(resolve) { queries++; return Promise.resolve({ data: data[name] }).then(resolve); } };
        for (const method of ['select','single','eq','order','limit','in']) q[method] = () => q;
        return q;
    }
    const client = {
        auth: { getSession: async () => ({ data: { session: { user: { id: 'user' } } } }), onAuthStateChange() {} },
        from: query, rpc: query,
        channel() { return { on(_type, _filter, callback) { onOrder = callback; return this; }, subscribe() { subscriptions++; return this; } }; },
        removeChannel: async () => {}
    };
    function page() {
        const timers = [];
        const context = { window: { smartProfitCache: cache, SMARTPROFIT_SUPABASE_CONFIG: { url: 'project' }, addEventListener() {}, location: { replace() { throw Error('unexpected redirect'); } } },
            document: { querySelectorAll: () => [], getElementById: () => null },
            getSupabaseClient: async () => client, console, setTimeout: cb => { timers.push(cb); return timers.length; }, clearTimeout() {} };
        vm.runInNewContext(fs.readFileSync(new URL('../assets/js/account-data.js', import.meta.url), 'utf8'), context);
        return { context, timers };
    }
    async function settled() { for (let i = 0; i < 50; i++) await Promise.resolve(); }
    let p = page(); await settled();
    assert.equal(p.context.window.smartProfitAccountData.balances[0].available, 1000);
    const coldQueries = queries; assert(coldQueries > 0);
    p = page(); await settled(); assert.equal(queries, coldQueries);
    const before = subscriptions;
    onOrder(); onOrder(); onOrder(); assert.equal(p.timers.length, 1);
    p.timers.shift()(); await settled();
    assert.equal(queries, coldQueries * 2); assert.equal(subscriptions, before);
});
