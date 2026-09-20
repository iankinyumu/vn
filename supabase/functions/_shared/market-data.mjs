/* Public market data ingestion for the trading edge functions.
 *
 * Two things about the upstream host matter operationally:
 *
 * 1. `data-api.binance.vision` is Binance's public market-data mirror and is not
 *    subject to the regional blocking that `api.binance.com` occasionally applies
 *    to an Edge runtime's egress IP. It is tried first; the primary host is kept as
 *    a fallback so a mirror outage does not stop quoting.
 * 2. A per-host timeout keeps one slow host from consuming the whole invocation
 *    budget, which would leave the customer waiting on a quote that never arrives.
 *
 * A quote is only accepted when the book is plausible. A crossed or zero book is
 * worse than no quote: it would price a fill the market never offered.
 */

import { QuoteError } from './errors.mjs';

export const MARKET_DATA_HOSTS = Object.freeze([
    'https://data-api.binance.vision',
    'https://api.binance.com'
]);

export const MARKET_DATA_TIMEOUT_MS = 3000;

export function bookTickerUrl(host, symbol) {
    return `${host}/api/v3/ticker/bookTicker?symbol=${encodeURIComponent(symbol)}`;
}

function readBook(payload) {
    const bid = Number(payload?.bidPrice);
    const ask = Number(payload?.askPrice);
    if (!Number.isFinite(bid) || !Number.isFinite(ask)) throw new Error('book ticker was not numeric');
    if (!(bid > 0)) throw new Error('bid price must be positive');
    if (!(ask >= bid)) throw new Error('ask price must not be below the bid');
    return { bid, ask };
}

/**
 * Fetches the best bid/ask for `symbol`, trying each host in order.
 * Throws a `market_data_unavailable` QuoteError only when every host failed.
 */
export async function fetchBookTicker(symbol, {
    fetcher = fetch,
    timeoutMs = MARKET_DATA_TIMEOUT_MS,
    hosts = MARKET_DATA_HOSTS,
    logger = console
} = {}) {
    const failures = [];
    for (const host of hosts) {
        try {
            const response = await fetcher(bookTickerUrl(host, symbol), { signal: AbortSignal.timeout(timeoutMs) });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const { bid, ask } = readBook(await response.json());
            return { bid, ask, host };
        } catch (error) {
            failures.push(`${host}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    logger.warn(`market-data: every host failed for ${symbol} - ${failures.join('; ')}`);
    throw new QuoteError('Live prices are temporarily unavailable.', 503, 'market_data_unavailable');
}
