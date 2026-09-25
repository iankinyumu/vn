// Daraja adapter (supabase/functions/_shared/daraja.mjs) against a mock fetch.
// Every value here is a fixture; no network call is made.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
    CALLBACK_ACK, DarajaConfigError, SANDBOX_BASE_URL, callbackUrl, createDarajaClient, darajaTimestamp, describeDarajaConfig,
    loadDarajaConfig, maskMsisdn, normalizeMsisdn, parseStkCallback, stkPassword,
} from '../supabase/functions/_shared/daraja.mjs';

const SANDBOX_ENV = Object.freeze({
    DARAJA_ENV: 'sandbox',
    DARAJA_SANDBOX_CONSUMER_KEY: 'fixture-key',
    DARAJA_SANDBOX_CONSUMER_SECRET: 'fixture-secret',
    DARAJA_SANDBOX_SHORTCODE: '174379',
    DARAJA_SANDBOX_PASSKEY: 'fixture-passkey',
    DARAJA_CALLBACK_BASE_URL: 'https://abcdefghijklmnopqrst.supabase.co/functions/v1/',
});
const codeOf = (fn) => { try { fn(); return null; } catch (error) { assert.ok(error instanceof DarajaConfigError); return error.code; } };

test('sandbox config is explicit and refuses production credentials and hosts', () => {
    const config = loadDarajaConfig(SANDBOX_ENV);
    assert.equal(config.environment, 'SANDBOX');
    assert.equal(config.baseUrl, SANDBOX_BASE_URL);
    assert.equal(config.callbackBase, 'https://abcdefghijklmnopqrst.supabase.co/functions/v1');
    assert.equal(config.transactionType, 'CustomerPayBillOnline');
    assert.ok(Object.isFrozen(config));
    assert.equal(codeOf(() => loadDarajaConfig({ ...SANDBOX_ENV, DARAJA_PRODUCTION_CONSUMER_KEY: 'x' })), 'sandbox_refuses_production_credentials');
    assert.equal(codeOf(() => loadDarajaConfig({ ...SANDBOX_ENV, DARAJA_SANDBOX_BASE_URL: 'https://api.safaricom.co.ke' })), 'sandbox_refuses_non_sandbox_endpoint');
    assert.equal(codeOf(() => loadDarajaConfig({ ...SANDBOX_ENV, DARAJA_SANDBOX_PASSKEY: '' })), 'missing:DARAJA_SANDBOX_PASSKEY');
    assert.equal(codeOf(() => loadDarajaConfig({ ...SANDBOX_ENV, DARAJA_CALLBACK_BASE_URL: 'https://smartprofit.vercel.app/api' })), 'invalid:DARAJA_CALLBACK_BASE_URL');
    assert.equal(codeOf(() => loadDarajaConfig({ ...SANDBOX_ENV, DARAJA_SANDBOX_TRANSACTION_TYPE: 'BusinessPayment' })), 'invalid:DARAJA_SANDBOX_TRANSACTION_TYPE');
    assert.equal(codeOf(() => loadDarajaConfig({ ...SANDBOX_ENV, DARAJA_ENV: '' })), 'daraja_env_invalid');
});

test('production mode refuses sandbox values and is not released', () => {
    const production = {
        DARAJA_ENV: 'production', DARAJA_PRODUCTION_CONSUMER_KEY: 'k', DARAJA_PRODUCTION_CONSUMER_SECRET: 's', DARAJA_PRODUCTION_SHORTCODE: '600000',
        DARAJA_PRODUCTION_PASSKEY: 'p', DARAJA_CALLBACK_BASE_URL: SANDBOX_ENV.DARAJA_CALLBACK_BASE_URL,
    };
    assert.equal(codeOf(() => loadDarajaConfig({ ...production, DARAJA_SANDBOX_PASSKEY: 'x' })), 'production_refuses_sandbox_credentials');
    assert.equal(codeOf(() => loadDarajaConfig({ ...production, DARAJA_PRODUCTION_BASE_URL: SANDBOX_BASE_URL })), 'production_refuses_non_production_endpoint');
    assert.equal(codeOf(() => loadDarajaConfig(production)), 'production_not_released');
});

test('config readiness is reported by name only', () => {
    const report = describeDarajaConfig(SANDBOX_ENV);
    assert.equal(report.verdict, 'ready');
    assert.equal(report.variables.DARAJA_SANDBOX_PASSKEY, 'present');
    assert.equal(report.variables.DARAJA_PRODUCTION_PASSKEY, 'absent');
    assert.doesNotMatch(JSON.stringify(report), /fixture-/);
    assert.equal(describeDarajaConfig({}).verdict, 'daraja_env_invalid');
});

test('timestamps are Nairobi time and the password is base64(shortcode + passkey + timestamp)', () => {
    assert.equal(darajaTimestamp(new Date('2026-09-25T21:30:05Z')), '20260926003005');
    assert.equal(stkPassword('174379', 'pk', '20260926003005'), Buffer.from('174379pk20260926003005').toString('base64'));
});

test('MSISDN normalization and masking', () => {
    for (const input of ['0712345678', '712345678', '+254712345678', '254 712 345 678', '254712345678']) assert.equal(normalizeMsisdn(input), '254712345678', input);
    assert.equal(normalizeMsisdn('0112345678'), '254112345678');
    for (const input of ['0812345678', '25471234567', 'abc', '', null, '2547123456789']) assert.equal(normalizeMsisdn(input), null, String(input));
    assert.equal(maskMsisdn('254712345678'), '2547*****678');
});

function mockFetch(routes) {
    const calls = [];
    const fetcher = async (url, init) => {
        calls.push({ url, init });
        const path = new URL(url).pathname;
        const handler = routes[path];
        if (!handler) throw new Error(`unexpected ${path}`);
        return handler(init, calls.length);
    };
    return { fetcher, calls };
}
const json = (status, body) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const oauth = () => json(200, { access_token: 'fixture-token', expires_in: '3599' });
const now = () => new Date('2026-09-25T09:00:00Z');
const PUSH = { amount: 649, phone: '254712345678', accountReference: 'SPABCDEF1234XYZ', description: 'Deposit for account', callbackUrl: 'https://x/cb' };

test('STK Push sends the documented body and classifies accepted, rejected and ambiguous answers', async () => {
    const config = loadDarajaConfig(SANDBOX_ENV);
    let answer = () => json(200, { MerchantRequestID: 'MR1', CheckoutRequestID: 'ws_CO_1', ResponseCode: '0', ResponseDescription: 'Success', CustomerMessage: 'Success' });
    const { fetcher, calls } = mockFetch({ '/oauth/v1/generate': oauth, '/mpesa/stkpush/v1/processrequest': () => answer() });
    const client = createDarajaClient({ config, fetch: fetcher, now });
    assert.deepEqual(await client.stkPush(PUSH), { outcome: 'ACCEPTED', merchantRequestId: 'MR1', checkoutRequestId: 'ws_CO_1', responseCode: '0', responseDescription: 'Success' });
    assert.equal(calls[0].init.headers.Authorization, `Basic ${Buffer.from('fixture-key:fixture-secret').toString('base64')}`);
    const body = JSON.parse(calls[1].init.body);
    assert.deepEqual(Object.keys(body).sort(), ['AccountReference', 'Amount', 'BusinessShortCode', 'CallBackURL', 'PartyA', 'PartyB', 'Password', 'PhoneNumber', 'Timestamp', 'TransactionDesc', 'TransactionType']);
    assert.equal(body.Amount, 649);
    assert.equal(body.Timestamp, '20260925120000');
    assert.equal(body.AccountReference, 'SPABCDEF1234');
    assert.equal(body.TransactionDesc, 'Deposit for a');
    assert.equal(calls[1].init.headers.Authorization, 'Bearer fixture-token');

    answer = () => json(400, { requestId: 'r', errorCode: '400.002.02', errorMessage: 'Bad Request - Invalid PhoneNumber' });
    assert.equal((await client.stkPush(PUSH)).outcome, 'REJECTED');
    answer = () => json(200, { ResponseCode: '1', ResponseDescription: 'Rejected' });
    assert.equal((await client.stkPush(PUSH)).outcome, 'REJECTED');
    answer = () => json(503, 'upstream down');
    assert.equal((await client.stkPush(PUSH)).outcome, 'AMBIGUOUS');
    answer = () => { throw new DOMException('timed out', 'TimeoutError'); };
    assert.equal((await client.stkPush(PUSH)).outcome, 'AMBIGUOUS');
    assert.equal(calls.filter((c) => c.url.includes('/oauth/')).length, 1, 'the token is cached');
    await assert.rejects(client.stkPush({ ...PUSH, amount: 648.1 }), /stk_amount_invalid/);
});

test('an OAuth failure is a safe rejection: nothing reached the phone', async () => {
    const { fetcher, calls } = mockFetch({ '/oauth/v1/generate': () => json(401, { errorMessage: 'Invalid credentials' }) });
    const client = createDarajaClient({ config: loadDarajaConfig(SANDBOX_ENV), fetch: fetcher, now });
    const result = await client.stkPush(PUSH);
    assert.equal(result.outcome, 'REJECTED');
    assert.equal(result.responseCode, 'oauth_failed');
    assert.equal(calls.length, 1);
});

test('STK Push Query distinguishes result, still-processing and error', async () => {
    let answer;
    const { fetcher } = mockFetch({ '/oauth/v1/generate': oauth, '/mpesa/stkpushquery/v1/query': () => answer() });
    const client = createDarajaClient({ config: loadDarajaConfig(SANDBOX_ENV), fetch: fetcher, now });
    answer = () => json(200, { ResponseCode: '0', ResponseDescription: 'accepted', MerchantRequestID: 'MR1', CheckoutRequestID: 'ws_CO_1', ResultCode: '0', ResultDesc: 'processed successfully' });
    assert.deepEqual(await client.stkQuery('ws_CO_1'), { outcome: 'RESULT', resultCode: '0', resultDesc: 'processed successfully' });
    answer = () => json(200, { ResponseCode: '0', CheckoutRequestID: 'ws_CO_1', ResultCode: '1032', ResultDesc: 'Request cancelled by user' });
    assert.equal((await client.stkQuery('ws_CO_1')).resultCode, '1032');
    answer = () => json(200, { ResponseCode: '0', CheckoutRequestID: 'ws_CO_OTHER', ResultCode: '0' });
    assert.equal((await client.stkQuery('ws_CO_1')).outcome, 'ERROR', 'an answer about another checkout is not a result');
    answer = () => json(500, { requestId: 'r', errorCode: '500.001.1001', errorMessage: 'The transaction is being processed' });
    assert.equal((await client.stkQuery('ws_CO_1')).outcome, 'PROCESSING');
    answer = () => json(503, 'x');
    assert.equal((await client.stkQuery('ws_CO_1')).outcome, 'ERROR');
});

test('callback parsing accepts the documented shape and bounds every field', () => {
    const good = JSON.stringify({ Body: { stkCallback: { MerchantRequestID: 'MR1', CheckoutRequestID: 'ws_CO_1', ResultCode: 0, ResultDesc: 'ok',
        CallbackMetadata: { Item: [{ Name: 'Amount', Value: 649.0 }, { Name: 'MpesaReceiptNumber', Value: 'TST0000001' }, { Name: 'Balance' }, { Name: 'TransactionDate', Value: 20260925120000 }, { Name: 'PhoneNumber', Value: 254712345678 }] } } } });
    assert.deepEqual(parseStkCallback(good), { ok: true, checkoutRequestId: 'ws_CO_1', merchantRequestId: 'MR1', resultCode: 0, resultDesc: 'ok', amount: 649, receipt: 'TST0000001', phone: '254712345678' });
    const cancelled = parseStkCallback(JSON.stringify({ Body: { stkCallback: { CheckoutRequestID: 'ws_CO_1', ResultCode: 1032, ResultDesc: 'cancelled' } } }));
    assert.equal(cancelled.resultCode, 1032);
    assert.equal(cancelled.amount, null);
    for (const bad of ['', 'not json', '{}', '{"Body":{"stkCallback":{"ResultCode":0}}}', 'x'.repeat(20000)]) assert.equal(parseStkCallback(bad).ok, false);
    const hostile = parseStkCallback(JSON.stringify({ Body: { stkCallback: { CheckoutRequestID: 'ws', ResultCode: 0, CallbackMetadata: { Item: [{ Name: 'MpesaReceiptNumber', Value: "x'; drop table" }, { Name: 'Amount', Value: -5 }] } } } }));
    assert.equal(hostile.receipt, null);
    assert.equal(hostile.amount, null);
    assert.deepEqual(CALLBACK_ACK, { ResultCode: 0, ResultDesc: 'Accepted' });
    assert.equal(callbackUrl(loadDarajaConfig(SANDBOX_ENV), 'abc'), 'https://abcdefghijklmnopqrst.supabase.co/functions/v1/daraja-callback?t=abc');
});
