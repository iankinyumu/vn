// The CBK homepage rate parser (supabase/functions/_shared/cbk-rate.mjs). The
// fixture mirrors the shape of the homepage's "Daily KES Exchange Rates" box as
// seen on 2026-09-26; it is synthetic, not a copy of the page.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CbkRateError, fetchCbkRate, parseCbkHomepage } from '../supabase/functions/_shared/cbk-rate.mjs';

const box = ({ usd = '129.62', posted = '25-09-2026', title = 'Daily KES Exchange Rates' } = {}) => `
<html><head><style>.tg td{font-family:Arial}</style><script>var x = "US DOLLAR 999.99";</script></head><body>
<div class="widget"><h3>${title}</h3>
<div class="tg-wrap"><table class="tg">
  <tr><td class="tg-4eph" colspan="2"><small>US DOLLAR</small></td><td class="tg-rlfi"><small>${usd}</small></td></tr>
  <tr><td class="tg-4eph" colspan="2"><small>STG POUND</small></td><td class="tg-rlfi"><small>171.44</small></td></tr>
  <tr><td class="tg-4eph" colspan="2"><small>EURO</small></td><td class="tg-rlfi"><small>147.47</small></td></tr>
</table></div><a href="/rates/forex-exchange-rates/">More...</a>
<p>Posted On: ${posted}</p></div></body></html>`;

const codeOf = (fn) => { try { fn(); return null; } catch (error) { assert.ok(error instanceof CbkRateError); return error.code; } };

test('the homepage box yields the USD mean and its posted date', () => {
    assert.deepEqual(parseCbkHomepage(box()), { kesPerUsd: 129.62, rateDate: '2026-09-25' });
    assert.deepEqual(parseCbkHomepage(box({ usd: '130.1275', posted: '28-09-2026' })), { kesPerUsd: 130.1275, rateDate: '2026-09-28' });
});

test('a changed page shape fails with a named reason instead of a wrong figure', () => {
    assert.equal(codeOf(() => parseCbkHomepage('')), 'empty_page');
    assert.equal(codeOf(() => parseCbkHomepage(box({ title: 'Exchange rates' }))), 'rates_box_missing');
    assert.equal(codeOf(() => parseCbkHomepage(box({ usd: 'n/a' }))), 'usd_rate_missing');
    assert.equal(codeOf(() => parseCbkHomepage(box({ posted: 'today' }))), 'posted_date_missing');
    assert.equal(codeOf(() => parseCbkHomepage(box({ posted: '31-02-2026' }))), 'posted_date_invalid');
    assert.equal(codeOf(() => parseCbkHomepage(box({ usd: '12.96' }))), 'usd_rate_out_of_bounds');
    assert.equal(codeOf(() => parseCbkHomepage(box({ usd: '999.99' }))), 'usd_rate_out_of_bounds', 'a figure inside a script is ignored');
});

test('fetch failures become named errors', async () => {
    const failing = async (fetch) => { try { await fetchCbkRate({ fetch }); return null; } catch (error) { return error.code; } };
    assert.equal(await failing(async () => new Response('down', { status: 503 })), 'http_503');
    assert.equal(await failing(async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); }), 'fetch_timeout');
    assert.equal(await failing(async () => { throw new TypeError('network'); }), 'fetch_failed');
    const calls = [];
    assert.deepEqual(await fetchCbkRate({ fetch: async (url, init) => { calls.push({ url, init }); return new Response(box()); } }), { kesPerUsd: 129.62, rateDate: '2026-09-25' });
    assert.equal(calls[0].url, 'https://www.centralbank.go.ke/');
});
