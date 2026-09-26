// CBK KES/USD reference rate from the Central Bank of Kenya homepage.
//
// CBK's machine-readable feeds (the wpDataTables endpoint behind
// /rates/forex-exchange-rates/ and uploads/fx_rates/historical_data.csv) ended
// in January 2024, checked on 2026-09-26. The homepage's "Daily KES Exchange
// Rates" box still shows the current mean with a "Posted On: DD-MM-YYYY" date,
// so this module reads that. It only extracts figures; the database
// (funding_svc_record_rate_observation) decides whether one is published,
// held for owner approval or ignored.
//
// A plain .mjs module so the Node tests can drive it with fixture HTML.

export const CBK_HOMEPAGE_URL = 'https://www.centralbank.go.ke/';
const MAX_HTML_BYTES = 2 * 1024 * 1024;

export class CbkRateError extends Error {
    constructor(code) {
        super(code);
        this.name = 'CbkRateError';
        this.code = code;
    }
}

const text = (html) => html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');

/**
 * Extracts {kesPerUsd, rateDate} from the homepage HTML, or throws
 * CbkRateError with a short code when the page no longer has the expected shape.
 */
export function parseCbkHomepage(html) {
    if (typeof html !== 'string' || html.length === 0) throw new CbkRateError('empty_page');
    const plain = text(html);
    const box = plain.indexOf('Daily KES Exchange Rates');
    if (box < 0) throw new CbkRateError('rates_box_missing');
    const section = plain.slice(box, box + 600);
    const usd = section.match(/US DOLLAR\s+(\d{2,3}(?:\.\d{1,4})?)\b/i);
    if (!usd) throw new CbkRateError('usd_rate_missing');
    const posted = section.match(/Posted On:\s*(\d{2})-(\d{2})-(\d{4})/i);
    if (!posted) throw new CbkRateError('posted_date_missing');
    const [, day, month, year] = posted;
    const rateDate = `${year}-${month}-${day}`;
    const check = new Date(`${rateDate}T00:00:00Z`);
    if (Number.isNaN(check.getTime()) || check.toISOString().slice(0, 10) !== rateDate) throw new CbkRateError('posted_date_invalid');
    const kesPerUsd = Number(usd[1]);
    if (!(kesPerUsd >= 50 && kesPerUsd <= 500)) throw new CbkRateError('usd_rate_out_of_bounds');
    return { kesPerUsd, rateDate };
}

/** Fetches and parses the homepage. Network and HTTP failures become CbkRateError too. */
export async function fetchCbkRate({ fetch: fetcher = globalThis.fetch, timeoutMs = 20000 } = {}) {
    let response;
    try {
        response = await fetcher(CBK_HOMEPAGE_URL, { headers: { 'User-Agent': 'SmartProfit-rate-sync/1.0 (+https://smartprofitbinaryv2.vercel.app)' }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
        throw new CbkRateError(error?.name === 'TimeoutError' ? 'fetch_timeout' : 'fetch_failed');
    }
    if (!response.ok) throw new CbkRateError(`http_${response.status}`);
    const html = await response.text();
    if (html.length > MAX_HTML_BYTES) throw new CbkRateError('page_too_large');
    return parseCbkHomepage(html);
}
