import test from 'node:test';
import assert from 'node:assert/strict';

import {
    CORS_ALLOW_HEADERS, CORS_ALLOW_METHODS, CORS_MAX_AGE,
    corsHeaders, preflightResponse, resolveAllowOrigin
} from '../supabase/functions/_shared/cors.mjs';
import { createRequestId, errorResponse, jsonResponse } from '../supabase/functions/_shared/http.mjs';
import { MARKET_DATA_HOSTS, fetchBookTicker } from '../supabase/functions/_shared/market-data.mjs';
import { createQuoteCache } from '../supabase/functions/_shared/quote-cache.mjs';

/* The browser reaches a demo order through refresh-market-quote, so anything that
 * makes that first hop fail is seen by the customer as "we couldn't place your
 * order". These tests pin the three hardening rules that hop now guarantees:
 * a preflight that allows x-client-info, a stable error code on every failure,
 * and a quote path that survives both a Redis outage and a Binance host block. */

const BOOK = { bidPrice: '100', askPrice: '101' };
const quiet = { warn() {}, error() {} };

/* ------------------------------------------------------------------ CORS --- */

test('the preflight allows every header supabase-js sends and is answered without auth', async () => {
    const request = new Request('https://project.functions.supabase.co/refresh-market-quote', {
        method: 'OPTIONS',
        headers: { Origin: 'https://app.example' }
    });
    const response = preflightResponse(request, null);

    assert.equal(response.status, 204);
    assert.equal(response.headers.get('Access-Control-Allow-Headers'), CORS_ALLOW_HEADERS);
    assert.equal(CORS_ALLOW_HEADERS, 'authorization, x-client-info, apikey, content-type');
    assert.ok(response.headers.get('Access-Control-Allow-Headers').includes('x-client-info'));
    assert.equal(response.headers.get('Access-Control-Allow-Methods'), CORS_ALLOW_METHODS);
    assert.equal(response.headers.get('Access-Control-Allow-Methods'), 'POST, OPTIONS');
    assert.equal(response.headers.get('Access-Control-Max-Age'), CORS_MAX_AGE);
    assert.equal(response.headers.get('Access-Control-Max-Age'), '86400');
    assert.equal(response.headers.get('Vary'), 'Origin');
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
});

test('an unset allowlist is a wildcard; a configured one echoes only its members', () => {
    assert.equal(resolveAllowOrigin('https://anything.example', null), '*');
    assert.equal(resolveAllowOrigin('https://anything.example', ''), '*');

    assert.equal(resolveAllowOrigin('https://app.example', 'https://app.example, https://www.app.example'), 'https://app.example');
    assert.equal(resolveAllowOrigin('https://evil.example', 'https://app.example'), null);

    const blocked = corsHeaders('https://evil.example', 'https://app.example');
    assert.equal(blocked['Access-Control-Allow-Origin'], undefined, 'a non-member origin must not be echoed');
    assert.equal(blocked.Vary, 'Origin');
    assert.equal(blocked['Access-Control-Allow-Headers'], CORS_ALLOW_HEADERS);
});

test('a failure response carries the CORS headers, a stable code, and no server text', async () => {
    const logs = [];
    const response = errorResponse({
        requestId: '8F3A21C0',
        code: 'market_data_unavailable',
        detail: new Error('binance returned 451 for api.binance.com'),
        requestOrigin: 'https://app.example',
        logger: { error: (...parts) => logs.push(parts.join(' ')) }
    });

    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
    assert.equal(response.headers.get('Access-Control-Allow-Headers'), CORS_ALLOW_HEADERS);

    const body = await response.json();
    assert.deepEqual(body, {
        error: { code: 'market_data_unavailable', message: 'Live prices are temporarily unavailable. Please try again in a moment.' },
        request_id: '8F3A21C0'
    });
    assert.ok(!JSON.stringify(body).includes('451'), 'the upstream detail must stay server-side');
    assert.ok(logs.some((line) => line.includes('8F3A21C0')), 'the request id must be logged with the detail');
    assert.ok(logs.some((line) => line.includes('451')), 'the real reason must be logged');
});

test('an unknown code degrades to internal instead of leaking through', async () => {
    const response = errorResponse({ requestId: 'AAAABBBB', code: 'sqlstate_23505', logger: quiet });
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.error.code, 'internal');
});

test('request ids are eight uppercase hex characters and do not repeat', () => {
    const ids = new Set();
    for (let i = 0; i < 64; i++) {
        const id = createRequestId();
        assert.match(id, /^[0-9A-F]{8}$/);
        ids.add(id);
    }
    assert.ok(ids.size > 1);
});

test('success responses carry CORS too', async () => {
    const response = jsonResponse({ snapshot: { id: '1' } }, { requestOrigin: 'https://app.example' });
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
    assert.deepEqual(await response.json(), { snapshot: { id: '1' } });
});

/* ----------------------------------------------------------- market data --- */

test('market data tries the public mirror before the primary host', async () => {
    const hits = [];
    const book = await fetchBookTicker('BTCUSDT', {
        logger: quiet,
        fetcher: async (url) => { hits.push(url); return Response.json(BOOK); }
    });

    assert.equal(hits.length, 1);
    assert.ok(hits[0].startsWith('https://data-api.binance.vision/api/v3/ticker/bookTicker'));
    assert.deepEqual(book, { bid: 100, ask: 101, host: MARKET_DATA_HOSTS[0] });
});

test('a region-blocked mirror falls back to api.binance.com', async () => {
    const hits = [];
    const book = await fetchBookTicker('ETHUSDT', {
        logger: quiet,
        fetcher: async (url) => {
            hits.push(new URL(url).origin);
            return url.includes('data-api.binance.vision') ? new Response('unavailable', { status: 451 }) : Response.json(BOOK);
        }
    });

    assert.deepEqual(hits, ['https://data-api.binance.vision', 'https://api.binance.com']);
    assert.equal(book.host, 'https://api.binance.com');
});

test('an implausible book is refused and every host failing yields market_data_unavailable', async () => {
    const zeroBid = async () => Response.json({ bidPrice: '0', askPrice: '101' });
    const crossed = async () => Response.json({ bidPrice: '102', askPrice: '101' });
    const offline = async () => { throw new Error('network unreachable'); };

    for (const fetcher of [zeroBid, crossed, offline]) {
        await assert.rejects(
            fetchBookTicker('BTCUSDT', { fetcher, logger: quiet }),
            (error) => error.code === 'market_data_unavailable' && error.status === 503
        );
    }
});
/* ----------------------------------------------------------- quote cache --- */

/* A single harness covers all three Redis states the cache must survive. It runs
 * a small in-memory Redis REST stand-in plus a stand-in Binance, and counts every
 * upstream quote, database write and logged warning so a test can assert on the
 * behaviour a customer would experience rather than on internal call shapes. */
function harness({ redis = 'healthy' } = {}) {
    const values = new Map();
    const stats = { redisCommands: 0, quoteFetches: 0, writes: 0, warnings: [] };
    let redisHealthy = redis === 'healthy';
    let marketUp = true;
    let time = Date.parse('2026-09-20T12:00:00.000Z');

    const env = (key) => {
        const configured = { SUPABASE_URL: 'project-test' };
        if (redis !== 'absent') {
            configured.UPSTASH_REDIS_REST_URL = 'https://redis.test';
            configured.UPSTASH_REDIS_REST_TOKEN = 'token';
        }
        return configured[key];
    };

    const runRedisCommand = (options) => {
        const [op, key, value, ...rest] = JSON.parse(options.body);
        if (op === 'GET') return values.get(key) ?? null;
        if (op === 'SET') {
            if (rest.includes('NX') && values.has(key)) return null;
            values.set(key, value);
            return 'OK';
        }
        if (op === 'EVAL') {
            const actualKey = rest[0];
            if (String(key).includes('INCR')) {
                const next = (values.get(actualKey) || 0) + 1;
                values.set(actualKey, next);
                return next;
            }
            if (values.get(actualKey) === rest[1]) values.delete(actualKey);
            return 1;
        }
        return null;
    };

    const fetcher = async (url, options) => {
        const origin = new URL(url).origin;
        if (MARKET_DATA_HOSTS.includes(origin)) {
            stats.quoteFetches++;
            if (!marketUp) throw new Error('network unreachable');
            return Response.json(BOOK);
        }
        stats.redisCommands++;
        if (!redisHealthy) throw new Error('redis offline');
        return Response.json({ result: runRedisCommand(options) });
    };

    const admin = {
        from: () => ({
            insert: (row) => ({
                select: () => ({
                    abortSignal: () => ({
                        single: async () => ({
                            data: {
                                id: String(++stats.writes),
                                bid_price: row.bid_price,
                                ask_price: row.ask_price,
                                received_at: row.received_at
                            },
                            error: null
                        })
                    })
                })
            })
        })
    };

    const logger = { warn: (message) => stats.warnings.push(message), error: () => {} };

    return {
        admin,
        stats,
        warnings: () => stats.warnings.slice(),
        publishedKeys: () => [...values.keys()].filter((key) => key.includes(':quote:')),
        cache: () => createQuoteCache({ env, fetcher, now: () => time, logger }),
        advance: (ms) => { time += ms; },
        breakRedis: () => { redisHealthy = false; },
        breakMarketData: () => { marketUp = false; }
    };
}

test('an unconfigured Redis still quotes, warns once, and reuses a 3 s micro-cache', async () => {
    const h = harness({ redis: 'absent' });
    const cache = h.cache();

    const first = await cache.getSnapshot(h.admin, 'BTCUSDT');
    assert.equal(first.id, '1');
    assert.equal(h.stats.quoteFetches, 1);
    assert.equal(h.stats.writes, 1);
    assert.equal(h.stats.redisCommands, 0, 'no Redis command may be attempted without credentials');

    const repeat = await cache.getSnapshot(h.admin, 'BTCUSDT');
    assert.equal(repeat.id, '1', 'the micro-cache must serve the repeat quote');
    assert.equal(h.stats.quoteFetches, 1);

    h.advance(3001);
    const stale = await cache.getSnapshot(h.admin, 'BTCUSDT');
    assert.equal(stale.id, '2');
    assert.equal(h.stats.quoteFetches, 2);

    assert.equal(h.warnings().filter((line) => line.includes('shared cache disabled')).length, 1, 'warn once per instance');
});

test('a Redis command failure degrades to the micro-cache instead of failing the quote', async () => {
    const h = harness();
    const cache = h.cache();
    assert.equal((await cache.getSnapshot(h.admin, 'BTCUSDT')).id, '1');

    h.breakRedis();
    const afterOutage = await cache.getSnapshot(h.admin, 'ETHUSDT');
    assert.equal(afterOutage.id, '2', 'the customer still gets a quote when Redis dies mid-flight');
    assert.equal(h.stats.quoteFetches, 2);
    assert.equal(h.warnings().filter((line) => line.includes('shared cache disabled')).length, 1);

    const repeat = await cache.getSnapshot(h.admin, 'ETHUSDT');
    assert.equal(repeat.id, '2');
    assert.equal(h.stats.quoteFetches, 2, 'the degraded instance must fall back to the micro-cache');
});

test('without Redis the shared rate limiter cannot block a quote', async () => {
    const h = harness({ redis: 'absent' });
    const cache = h.cache();

    for (let i = 0; i < 40; i++) await cache.rateLimit('user-a');
    assert.equal(h.stats.redisCommands, 0);
});

test('a healthy Redis still collapses 100 workers into one quote and one write', async () => {
    const h = harness();
    let matches = 0;

    const results = await Promise.allSettled(
        Array.from({ length: 100 }, () => h.cache().getSnapshot(h.admin, 'BTCUSDT', async () => { matches++; }))
    );

    assert.equal(h.stats.quoteFetches, 1);
    assert.equal(h.stats.writes, 1);
    assert.equal(matches, 1);
    assert.ok(results.some((result) => result.status === 'fulfilled'));
    for (const result of results.filter((entry) => entry.status === 'rejected')) assert.equal(result.reason.status, 503);

    const shared = await h.cache().getSnapshot(h.admin, 'BTCUSDT');
    assert.equal(shared.id, '1');
    assert.equal(h.stats.writes, 1, 'a later instance must reuse the shared snapshot');
    assert.equal(h.stats.quoteFetches, 1);

    for (let i = 0; i < 30; i++) await h.cache().rateLimit('a');
    await assert.rejects(h.cache().rateLimit('a'), (error) => error.status === 429 && error.code === 'rate_limited');
    await h.cache().rateLimit('b');
});

test('an unsupported symbol is refused before any upstream or database call', async () => {
    const h = harness();
    await assert.rejects(
        h.cache().getSnapshot(h.admin, 'BTCEUR'),
        (error) => error.code === 'unsupported_symbol' && error.status === 400
    );
    assert.equal(h.stats.quoteFetches, 0);
    assert.equal(h.stats.writes, 0);
});

test('a failed follow-up never leaves a cached snapshot behind, with or without Redis', async () => {
    for (const redis of ['healthy', 'absent']) {
        const h = harness({ redis });
        const cache = h.cache();

        await assert.rejects(
            cache.getSnapshot(h.admin, 'BTCUSDT', async () => { throw new Error('matching failed'); }),
            /matching failed/
        );
        assert.deepEqual(h.publishedKeys(), [], `nothing may be cached after a failed follow-up (redis: ${redis})`);

        const retry = await cache.getSnapshot(h.admin, 'BTCUSDT');
        assert.equal(retry.id, '2', `a failed follow-up must not be served from cache (redis: ${redis})`);
        assert.equal(h.stats.quoteFetches, 2);
    }
});

test('every market data host being down surfaces as market_data_unavailable', async () => {
    const h = harness({ redis: 'absent' });
    h.breakMarketData();

    await assert.rejects(
        h.cache().getSnapshot(h.admin, 'BTCUSDT'),
        (error) => error.code === 'market_data_unavailable'
    );
    assert.equal(h.stats.writes, 0, 'an unquotable pair must not write a snapshot row');
});
