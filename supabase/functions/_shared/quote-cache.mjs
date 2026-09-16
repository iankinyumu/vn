// Shared market data only. Never store credentials, balances or orders in Redis.
export class QuoteError extends Error {
    constructor(message, status = 503) { super(message); this.status = status; }
}

export function createQuoteCache({ env, fetcher = fetch, now = Date.now, uuid = () => crypto.randomUUID() }) {
    const redisUrl = env('UPSTASH_REDIS_REST_URL');
    const token = env('UPSTASH_REDIS_REST_TOKEN');
    const namespace = 'smartprofit:' + env('SUPABASE_URL') + ':demo:v1:';
    async function command(args) {
        // Fail closed rather than turn a cache outage into an upstream/DB stampede.
        if (!redisUrl || !token) throw new QuoteError('Shared quote service is not configured.');
        try {
            const response = await fetcher(redisUrl, {
                method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
                body: JSON.stringify(args), signal: AbortSignal.timeout(2000)
            });
            if (!response.ok) throw new Error('Redis unavailable');
            const data = await response.json();
            if (data.error) throw new Error('Redis command failed');
            return data.result;
        } catch (_) { throw new QuoteError('The quote service is busy. Please try again shortly.'); }
    }
    async function rateLimit(userId) {
        const count = await command(['EVAL', "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],60) end; return n", 1, namespace + 'rate:' + userId]);
        if (Number(count) > 30) throw new QuoteError('Too many quote requests. Please wait a minute.', 429);
    }
    async function getSnapshot(admin, symbol, onSnapshot = async () => {}) {
        if (!/^[A-Z0-9]{2,20}USDT$/.test(symbol)) throw new QuoteError('Unsupported symbol', 400);
        const key = namespace + 'quote:' + symbol;
        const cached = await command(['GET', key]);
        if (cached) {
            try {
                const snapshot = JSON.parse(cached);
                const age = now() - Date.parse(snapshot.received_at);
                if (snapshot.id && age >= 0 && age < 3000) return snapshot;
            } catch (_) { /* Replace a malformed cached entry. */ }
        }
        const lockKey = key + ':lock', lockOwner = uuid();
        const acquired = await command(['SET', lockKey, lockOwner, 'NX', 'EX', 30]);
        if (acquired !== 'OK') throw new QuoteError('A fresh quote is being prepared. Please try again shortly.');
        try {
            // Recheck after locking: another worker may have completed between GET and SET.
            const latest = await command(['GET', key]);
            if (latest) {
                try {
                    const snapshot = JSON.parse(latest), age = now() - Date.parse(snapshot.received_at);
                    if (snapshot.id && age >= 0 && age < 3000) return snapshot;
                } catch (_) { /* Fetch a replacement. */ }
            }
            const response = await fetcher('https://api.binance.com/api/v3/ticker/bookTicker?symbol=' + encodeURIComponent(symbol), { signal: AbortSignal.timeout(5000) });
            if (!response.ok) throw new QuoteError('Market data is temporarily unavailable.');
            const book = await response.json(), bid = Number(book.bidPrice), ask = Number(book.askPrice);
            if (!Number.isFinite(bid) || !Number.isFinite(ask) || !(bid > 0 && ask >= bid)) throw new QuoteError('Market data is temporarily unavailable.');
            const { data: snapshot, error } = await admin.from('market_snapshots').insert({
                source: 'BINANCE_BOOK_TICKER', symbol, bid_price: bid, ask_price: ask, depth: [],
                received_at: new Date(now()).toISOString(), sequence_id: uuid()
            }).select('id, bid_price, ask_price, received_at').abortSignal(AbortSignal.timeout(4000)).single();
            if (error) throw new QuoteError('Unable to prepare a quote. Please try again shortly.');
            await onSnapshot(snapshot);
            await command(['SET', key, JSON.stringify(snapshot), 'EX', 3]);
            return snapshot;
        } finally {
            // Do not delete a successor's lock if this worker exceeded its lease.
            await command(['EVAL', "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end", 1, lockKey, lockOwner]).catch(() => {});
        }
    }
    return { getSnapshot, rateLimit };
}
