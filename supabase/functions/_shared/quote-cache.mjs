/* Shared market data only. Never store credentials, balances or orders in Redis.
 *
 * Redis is an optimisation here, never a dependency. Previously a missing Upstash
 * secret or a single failed command threw, so every customer quote and every
 * scheduled matching pass collapsed - a shared cache outage became a trading
 * outage. The contract now is:
 *
 *   - Redis healthy: unchanged. Shared 3 s snapshot cache, cross-instance lock, and
 *     the per-user quote rate limit.
 *   - Redis absent or failing: log one warning per instance and continue with a
 *     per-instance 3 s in-memory micro-cache. No lock, so concurrent callers may
 *     each publish a snapshot; that is a cheaper failure than refusing the order.
 *
 * Dropping the Redis rate limiter is safe because it was only ever a coarse
 * pre-filter: public.assert_demo_order_rate_limit() inside submit_demo_order is the
 * control that actually protects the order path, and it is unaffected.
 */

import { QuoteError, errorStatus } from './errors.mjs';
import { fetchBookTicker } from './market-data.mjs';

export { QuoteError };

const SNAPSHOT_TTL_MS = 3000;
const QUOTE_REQUESTS_PER_MINUTE = 30;
const LOCK_TTL_SECONDS = 30;

export function createQuoteCache({
    env,
    fetcher = fetch,
    now = Date.now,
    uuid = () => crypto.randomUUID(),
    logger = console,
    marketData = fetchBookTicker
}) {
    const redisUrl = env('UPSTASH_REDIS_REST_URL');
    const token = env('UPSTASH_REDIS_REST_TOKEN');
    const namespace = 'smartprofit:' + env('SUPABASE_URL') + ':demo:v1:';
    const microCache = new Map();
    let redisUsable = Boolean(redisUrl && token);
    let redisWarningLogged = false;

    function warnOnce(reason) {
        if (redisWarningLogged) return;
        redisWarningLogged = true;
        logger.warn(`quote-cache: shared cache disabled (${reason}); continuing with a per-instance in-memory cache.`);
    }

    function degrade(reason) {
        redisUsable = false;
        warnOnce(reason);
    }

    if (!redisUsable) warnOnce('UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN are not set');

    /**
     * Runs one Redis command. A failure downgrades this instance for good rather
     * than retrying: a cache that is already failing should not add latency to
     * every quote. Returns `{ ok: false }` when the shared cache is unavailable.
     */
    async function command(args) {
        if (!redisUsable) return { ok: false, value: null };
        try {
            const response = await fetcher(redisUrl, {
                method: 'POST',
                headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
                body: JSON.stringify(args),
                signal: AbortSignal.timeout(2000)
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            if (data && data.error) throw new Error('redis rejected the command');
            return { ok: true, value: data ? data.result : null };
        } catch (error) {
            degrade(error instanceof Error ? error.message : String(error));
            return { ok: false, value: null };
        }
    }

    function readMicroCache(symbol) {
        const snapshot = microCache.get(symbol);
        if (!snapshot) return null;
        const age = now() - Date.parse(snapshot.received_at);
        if (snapshot.id && age >= 0 && age < SNAPSHOT_TTL_MS) return snapshot;
        microCache.delete(symbol);
        return null;
    }

    function parseSnapshot(raw) {
        try {
            const snapshot = JSON.parse(raw);
            const age = now() - Date.parse(snapshot.received_at);
            if (snapshot.id && age >= 0 && age < SNAPSHOT_TTL_MS) return snapshot;
        } catch (_) { /* Fall through and fetch a replacement. */ }
        return null;
    }

    async function rateLimit(userId) {
        const result = await command(['EVAL', "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],60) end; return n", 1, namespace + 'rate:' + userId]);
        if (!result.ok) return; // The database rate limiter inside submit_demo_order still applies.
        if (Number(result.value) > QUOTE_REQUESTS_PER_MINUTE) {
            throw new QuoteError('Too many quote requests. Please wait a minute.', errorStatus('rate_limited'), 'rate_limited');
        }
    }

    /** Fetches a fresh book, persists the snapshot, and only then publishes it. */
    async function fetchAndPublish(admin, symbol, onSnapshot) {
        const book = await marketData(symbol, { fetcher });
        const { data: snapshot, error } = await admin.from('market_snapshots').insert({
            source: 'BINANCE_BOOK_TICKER',
            symbol,
            bid_price: book.bid,
            ask_price: book.ask,
            depth: [],
            received_at: new Date(now()).toISOString(),
            sequence_id: uuid()
        }).select('id, bid_price, ask_price, received_at').abortSignal(AbortSignal.timeout(4000)).single();
        if (error) throw new QuoteError('Unable to prepare a quote. Please try again shortly.', 503, 'internal');
        // onSnapshot runs before publishing so a failed follow-up (matching) cannot
        // leave a "successful" cached quote behind.
        await onSnapshot(snapshot);
        microCache.set(symbol, snapshot);
        if (redisUsable) await command(['SET', namespace + 'quote:' + symbol, JSON.stringify(snapshot), 'EX', 3]);
        return snapshot;
    }

    async function getSnapshot(admin, symbol, onSnapshot = async () => {}) {
        if (!/^[A-Z0-9]{2,20}USDT$/.test(symbol)) {
            throw new QuoteError('Unsupported symbol', 400, 'unsupported_symbol');
        }

        const micro = readMicroCache(symbol);
        if (micro) return micro;
        if (!redisUsable) return fetchAndPublish(admin, symbol, onSnapshot);

        const key = namespace + 'quote:' + symbol;
        const cached = await command(['GET', key]);
        if (cached.ok && cached.value) {
            const snapshot = parseSnapshot(cached.value);
            if (snapshot) return snapshot;
        }

        const lockKey = key + ':lock';
        const lockOwner = uuid();
        const acquired = await command(['SET', lockKey, lockOwner, 'NX', 'EX', LOCK_TTL_SECONDS]);
        if (!acquired.ok) return fetchAndPublish(admin, symbol, onSnapshot);
        if (acquired.value !== 'OK') {
            throw new QuoteError('A fresh quote is being prepared. Please try again shortly.', 503, 'internal');
        }

        try {
            // Recheck after locking: another worker may have completed between GET and SET.
            const latest = await command(['GET', key]);
            if (latest.ok && latest.value) {
                const snapshot = parseSnapshot(latest.value);
                if (snapshot) return snapshot;
            }
            return await fetchAndPublish(admin, symbol, onSnapshot);
        } finally {
            // Do not delete a successor's lock if this worker exceeded its lease.
            await command(['EVAL', "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end", 1, lockKey, lockOwner]);
        }
    }

    return { getSnapshot, rateLimit };
}
