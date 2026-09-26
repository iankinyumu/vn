// Request handling of the three funding Edge Functions
// (supabase/functions/_shared/funding-handlers.mjs, wired by each index.ts):
// methods, body limits (declared and chunked), configuration, JWT, cron secret,
// CORS, database failures and safe error bodies. supabase-js and Daraja are
// fakes; nothing leaves the process.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createCallbackHandler, createDepositHandler, createReconcileHandler, readBodyText } from '../supabase/functions/_shared/funding-handlers.mjs';

const ORIGIN = 'https://app.example.test';
const SECRETS = ['ck-test-consumer-key', 'cs-test-consumer-secret', 'pk-test-passkey', 'service-role-test-secret', 'anon-test-key', 'c'.repeat(40)];
const ENV = Object.freeze({
    DARAJA_ENV: 'sandbox',
    DARAJA_SANDBOX_CONSUMER_KEY: SECRETS[0],
    DARAJA_SANDBOX_CONSUMER_SECRET: SECRETS[1],
    DARAJA_SANDBOX_SHORTCODE: '174379',
    DARAJA_SANDBOX_PASSKEY: SECRETS[2],
    DARAJA_CALLBACK_BASE_URL: 'https://abcdefghijklmnopqrst.supabase.co/functions/v1',
    SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: SECRETS[3],
    SUPABASE_ANON_KEY: SECRETS[4],
    FUNDING_CRON_SECRET: SECRETS[5],
    ALLOWED_ORIGINS: ORIGIN,
});
const URL_BASE = 'https://abcdefghijklmnopqrst.supabase.co/functions/v1';

function fakeSupabase({ user = { id: '00000000-0000-4000-8000-000000000006' }, authError = null, rpc = async () => ({ data: null, error: null }) } = {}) {
    const calls = { clients: [], rpc: [], getUser: 0 };
    const createClient = (url, key, options) => {
        calls.clients.push({ url, key, options });
        return {
            auth: { getUser: async () => { calls.getUser += 1; return { data: { user: authError ? null : user }, error: authError }; } },
            rpc: async (name, args) => { calls.rpc.push({ name, args }); return rpc(name, args); },
        };
    };
    return { createClient, calls };
}

function capture() {
    const lines = [];
    return { lines, logger: { error: (...args) => lines.push(args.join(' ')), log: () => {}, warn: () => {} } };
}

/** A body stream with no Content-Length, like a chunked upload. */
function chunked(bytes, chunk = 1024) {
    let sent = 0;
    return new ReadableStream({
        pull(controller) {
            if (sent >= bytes) { controller.close(); return; }
            const size = Math.min(chunk, bytes - sent);
            sent += size;
            controller.enqueue(new Uint8Array(size).fill(0x61));
        },
    });
}

const post = (path, { body, headers = {}, stream = null, method = 'POST' } = {}) => new Request(`${URL_BASE}${path}`, {
    method, headers, ...(stream ? { body: stream, duplex: 'half' } : body !== undefined ? { body } : {}),
});

async function json(response) {
    const text = await response.text();
    return text ? JSON.parse(text) : null;
}

function assertNoSecrets(texts) {
    for (const text of texts) for (const secret of SECRETS) assert.equal(String(text).includes(secret), false, `a secret leaked: ${text}`);
}

const darajaFetch = (calls = []) => async (url, init) => {
    calls.push(String(url));
    if (String(url).includes('/oauth/')) return Response.json({ access_token: 'daraja-access-token', expires_in: '3599' });
    return Response.json({ MerchantRequestID: 'MR-1', CheckoutRequestID: 'ws_CO_HANDLER_1', ResponseCode: '0', ResponseDescription: 'Success. Request accepted for processing' });
};

// ------------------------------------------------------------------ body reader

test('readBodyText enforces the limit on declared and chunked bodies', async () => {
    assert.equal(await readBodyText(post('/x', { body: 'hello' }), 10), 'hello');
    assert.equal(await readBodyText(post('/x', { body: 'x'.repeat(11) }), 10), null);
    assert.equal(await readBodyText(post('/x', { stream: chunked(5000) }), 4096), null);
    assert.equal((await readBodyText(post('/x', { stream: chunked(4096) }), 4096)).length, 4096);
    assert.equal(await readBodyText(post('/x', { body: 'hi', headers: { 'Content-Length': 'abc' } }), 10), null);
    assert.equal(await readBodyText(post('/x'), 10), '');
});

// ------------------------------------------------------------------ funding-deposit

test('deposit: preflight and CORS follow the allowlist on every response', async () => {
    const { createClient } = fakeSupabase();
    const handle = createDepositHandler({ getEnv: () => ENV, createClient, logger: capture().logger });
    const preflight = await handle(post('/funding-deposit', { method: 'OPTIONS', headers: { Origin: ORIGIN } }));
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), ORIGIN);
    assert.match(preflight.headers.get('Access-Control-Allow-Headers'), /x-client-info/);
    const foreign = await handle(post('/funding-deposit', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }));
    assert.equal(foreign.headers.get('Access-Control-Allow-Origin'), null);
    const denied = await handle(post('/funding-deposit', { headers: { Origin: ORIGIN } }));
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get('Access-Control-Allow-Origin'), ORIGIN, 'error bodies stay readable by the site');
    assert.equal(denied.headers.get('Cache-Control'), 'no-store');
});

test('deposit: other methods get 405; a missing or invalid JWT gets 401 before any body or database work', async () => {
    const supa = fakeSupabase({ authError: { message: 'invalid JWT: signature' } });
    const handle = createDepositHandler({ getEnv: () => ENV, createClient: supa.createClient, logger: capture().logger });
    for (const method of ['GET', 'PUT', 'DELETE']) {
        const response = await handle(post('/funding-deposit', { method }));
        assert.equal(response.status, 405);
        assert.equal((await json(response)).error.code, 'method_not_allowed');
    }
    for (const authorization of [undefined, '', 'Basic abc', 'Bearer']) {
        const response = await handle(post('/funding-deposit', { body: '{}', headers: authorization === undefined ? {} : { Authorization: authorization } }));
        assert.equal(response.status, 401);
    }
    assert.equal(supa.calls.getUser, 0);
    const invalid = await handle(post('/funding-deposit', { body: '{}', headers: { Authorization: 'Bearer not-a-real-jwt' } }));
    assert.equal(invalid.status, 401);
    assert.equal((await json(invalid)).error.code, 'unauthorized');
    assert.equal(supa.calls.getUser, 1);
    assert.equal(supa.calls.rpc.length, 0);
});

test('deposit: missing configuration answers 503 without naming a value', async () => {
    const { lines, logger } = capture();
    const supa = fakeSupabase();
    for (const drop of ['DARAJA_SANDBOX_PASSKEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY', 'DARAJA_ENV']) {
        const env = { ...ENV };
        delete env[drop];
        const handle = createDepositHandler({ getEnv: () => env, createClient: supa.createClient, logger });
        const response = await handle(post('/funding-deposit', { body: '{}', headers: { Authorization: 'Bearer token' } }));
        const body = await json(response);
        assert.equal(response.status, 503, drop);
        assert.equal(body.error.code, 'payments_unavailable');
        assertNoSecrets([JSON.stringify(body)]);
    }
    const production = createDepositHandler({ getEnv: () => ({ ...ENV, DARAJA_PRODUCTION_PASSKEY: 'prod-passkey' }), createClient: supa.createClient, logger });
    assert.equal((await production(post('/funding-deposit', { body: '{}', headers: { Authorization: 'Bearer token' } }))).status, 503, 'sandbox refuses production credentials');
    assert.equal(supa.calls.rpc.length, 0);
    assertNoSecrets(lines);
});

test('deposit: oversized, chunked, non-JSON and incomplete bodies are refused', async () => {
    const supa = fakeSupabase();
    const handle = createDepositHandler({ getEnv: () => ENV, createClient: supa.createClient, logger: capture().logger });
    const auth = { Authorization: 'Bearer token' };
    assert.equal((await handle(post('/funding-deposit', { body: 'x'.repeat(5000), headers: auth }))).status, 413);
    assert.equal((await handle(post('/funding-deposit', { stream: chunked(64 * 1024), headers: auth }))).status, 413);
    assert.equal((await handle(post('/funding-deposit', { body: 'not json', headers: auth }))).status, 400);
    const missing = await handle(post('/funding-deposit', { body: JSON.stringify({ quote_id: 'q' }), headers: auth }));
    assert.equal(missing.status, 400);
    assert.equal((await json(missing)).error.code, 'validation_failed');
    assert.equal(supa.calls.rpc.length, 0);
});

test('deposit: a database failure is a safe 500; a funding refusal keeps its code', async () => {
    const { lines, logger } = capture();
    const body = JSON.stringify({ quote_id: '11111111-1111-4111-8111-111111111111', phone: '0712345678', idempotency_key: 'handler-key-1' });
    const auth = { Authorization: 'Bearer token', Origin: ORIGIN };
    const broken = fakeSupabase({ rpc: async () => ({ data: null, error: { message: `connection to server failed: password ${SECRETS[3]} select * from funding.payments` } }) });
    let response = await createDepositHandler({ getEnv: () => ENV, createClient: broken.createClient, logger })(post('/funding-deposit', { body, headers: auth }));
    let payload = await json(response);
    assert.equal(response.status, 500);
    assert.equal(payload.error.code, 'internal');
    assert.match(payload.request_id, /^[0-9A-F]{8}$/);
    assert.equal(JSON.stringify(payload).includes('select'), false, 'no SQL or driver text in the body');
    assertNoSecrets([JSON.stringify(payload)]);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), ORIGIN);

    const paused = fakeSupabase({ rpc: async () => ({ data: null, error: { message: 'treasury_paused' } }) });
    response = await createDepositHandler({ getEnv: () => ENV, createClient: paused.createClient, logger })(post('/funding-deposit', { body, headers: auth }));
    payload = await json(response);
    assert.equal(response.status, 503);
    assert.equal(payload.error.code, 'treasury_paused');
    const limited = fakeSupabase({ rpc: async () => ({ data: null, error: { message: 'deposit_limit_reached' } }) });
    response = await createDepositHandler({ getEnv: () => ENV, createClient: limited.createClient, logger })(post('/funding-deposit', { body, headers: auth }));
    assert.equal(response.status, 409);
    assert.equal((await json(response)).error.code, 'deposit_limit_reached');
    assert.ok(lines.length > 0, 'the real detail goes to the server log');
});

test('deposit: a valid request pushes once with the server-side amount, shortcode and callback token', async () => {
    const fetchCalls = [];
    const supa = fakeSupabase({
        rpc: async (name) => {
            if (name === 'funding_svc_begin_payment') return { data: { payment_id: 'p1', environment: 'SANDBOX', state: 'INITIATING', kes_due: 649, account_reference: 'SPABCDEF1234', existing: false }, error: null };
            return { data: { payment_id: 'p1', environment: 'SANDBOX', state: 'PENDING', status_message: 'Check your phone', usd_amount: 5, kes_due: 649 }, error: null };
        },
    });
    const handle = createDepositHandler({ getEnv: () => ENV, createClient: supa.createClient, fetch: darajaFetch(fetchCalls), logger: capture().logger });
    const response = await handle(post('/funding-deposit', { body: JSON.stringify({ quote_id: 'q1', phone: '0712 345 678', idempotency_key: 'handler-key-2' }), headers: { Authorization: 'Bearer token' } }));
    assert.equal(response.status, 200);
    assert.deepEqual(await json(response), { payment_id: 'p1', environment: 'SANDBOX', state: 'PENDING', status_message: 'Check your phone', usd_amount: 5, kes_due: 649 });
    const begin = supa.calls.rpc.find((c) => c.name === 'funding_svc_begin_payment').args;
    assert.equal(begin.p_user, '00000000-0000-4000-8000-000000000006', 'the user comes from the verified JWT');
    assert.equal(begin.p_phone, '254712345678');
    assert.equal(begin.p_shortcode, '174379');
    assert.match(begin.p_callback_token_hash, /^[0-9a-f]{64}$/);
    assert.deepEqual(supa.calls.rpc.map((c) => c.name), ['funding_svc_begin_payment', 'funding_svc_record_initiation']);
    assert.equal(fetchCalls.filter((url) => url.includes('/stkpush/')).length, 1);
    // The user client carries the caller's JWT; the service client the service key.
    assert.deepEqual(supa.calls.clients.map((c) => c.key), [SECRETS[3], SECRETS[4]]);
    assert.equal(supa.calls.clients[1].options.global.headers.Authorization, 'Bearer token');
});

// ------------------------------------------------------------------ daraja-callback

const ACK = { ResultCode: 0, ResultDesc: 'Accepted' };
const TOKEN = 'a'.repeat(64);
const CALLBACK = JSON.stringify({ Body: { stkCallback: { MerchantRequestID: 'MR', CheckoutRequestID: 'ws_CO_1', ResultCode: 1032, ResultDesc: 'Request cancelled by user' } } });

test('callback: POST only; oversized or chunked bodies are acknowledged and never recorded', async () => {
    const supa = fakeSupabase();
    const handle = createCallbackHandler({ getEnv: () => ENV, createClient: supa.createClient, logger: capture().logger });
    for (const method of ['GET', 'PUT']) {
        const response = await handle(post(`/daraja-callback?t=${TOKEN}`, { method }));
        assert.equal(response.status, 405);
        assert.equal(response.headers.get('Allow'), 'POST');
    }
    let response = await handle(post(`/daraja-callback?t=${TOKEN}`, { body: 'x'.repeat(17 * 1024) }));
    assert.equal(response.status, 200);
    assert.deepEqual(await json(response), ACK);
    response = await handle(post(`/daraja-callback?t=${TOKEN}`, { stream: chunked(1024 * 1024, 8192) }));
    assert.deepEqual(await json(response), ACK);
    assert.equal(supa.calls.rpc.length, 0);
    assert.equal(supa.calls.clients.length, 0);
});

test('callback: records with the token hash only; missing service configuration or a database failure asks Daraja to retry', async () => {
    const { lines, logger } = capture();
    const ok = fakeSupabase({ rpc: async () => ({ data: { accepted: true, payment_id: 'p1', needs_query: false }, error: null }) });
    let response = await createCallbackHandler({ getEnv: () => ENV, createClient: ok.createClient, logger })(post(`/daraja-callback?t=${TOKEN}`, { body: CALLBACK }));
    assert.equal(response.status, 200);
    assert.deepEqual(await json(response), ACK);
    const args = ok.calls.rpc[0].args;
    assert.match(args.p_token_hash, /^[0-9a-f]{64}$/);
    assert.notEqual(args.p_token_hash, TOKEN);
    assert.equal(JSON.stringify(ok.calls.rpc).includes(TOKEN), false, 'the raw token never reaches the database');

    // Without Daraja config the callback is still recorded (the sweep verifies later).
    const noDaraja = { ...ENV };
    delete noDaraja.DARAJA_SANDBOX_PASSKEY;
    const recorded = fakeSupabase({ rpc: async () => ({ data: { accepted: true, payment_id: 'p1', needs_query: true, checkout_request_id: 'ws_CO_1' }, error: null }) });
    response = await createCallbackHandler({ getEnv: () => noDaraja, createClient: recorded.createClient, logger })(post(`/daraja-callback?t=${TOKEN}`, { body: CALLBACK }));
    assert.equal(response.status, 200);
    assert.deepEqual(recorded.calls.rpc.map((c) => c.name), ['funding_svc_record_callback', 'funding_svc_record_status']);
    assert.equal(recorded.calls.rpc[1].args.p_outcome, 'ERROR', 'no provider call was possible');

    const noService = { ...ENV };
    delete noService.SUPABASE_SERVICE_ROLE_KEY;
    response = await createCallbackHandler({ getEnv: () => noService, createClient: ok.createClient, logger })(post(`/daraja-callback?t=${TOKEN}`, { body: CALLBACK }));
    assert.equal(response.status, 500);
    assert.deepEqual(await json(response), { ResultCode: 1, ResultDesc: 'Retry' });

    const broken = fakeSupabase({ rpc: async () => ({ data: null, error: { message: 'database unavailable' } }) });
    response = await createCallbackHandler({ getEnv: () => ENV, createClient: broken.createClient, logger })(post(`/daraja-callback?t=${TOKEN}`, { body: CALLBACK }));
    assert.equal(response.status, 500);
    assert.deepEqual(await json(response), { ResultCode: 1, ResultDesc: 'Retry' });
    assert.equal(lines.some((line) => line.includes(TOKEN) || line.includes('Request cancelled')), false, 'neither the token nor the body is logged');
    assertNoSecrets(lines);
});

// ------------------------------------------------------------------ funding-reconcile

const cron = (body, secret = ENV.FUNDING_CRON_SECRET, extra = {}) => post('/funding-reconcile', {
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body), headers: { 'X-Funding-Cron-Secret': secret, ...extra },
});

test('reconcile: POST only and the cron secret must match a configured secret of at least 32 characters', async () => {
    const supa = fakeSupabase();
    const handle = createReconcileHandler({ getEnv: () => ENV, createClient: supa.createClient, logger: capture().logger });
    assert.equal((await handle(post('/funding-reconcile', { method: 'GET', headers: { 'X-Funding-Cron-Secret': ENV.FUNDING_CRON_SECRET } }))).status, 405);
    for (const secret of ['', 'wrong', `${ENV.FUNDING_CRON_SECRET}x`, 'c'.repeat(39)]) {
        const response = await handle(cron({ action: 'sweep' }, secret));
        assert.equal(response.status, 401);
        assert.equal((await json(response)).error.code, 'unauthorized');
    }
    for (const configured of [undefined, 'short-secret']) {
        const env = { ...ENV, FUNDING_CRON_SECRET: configured };
        const response = await createReconcileHandler({ getEnv: () => env, createClient: supa.createClient, logger: capture().logger })(cron({ action: 'sweep' }, configured ?? ''));
        assert.equal(response.status, 401, 'an unset or short secret never authorizes');
    }
    assert.equal(supa.calls.rpc.length, 0);
});

test('reconcile: bad bodies are refused; configuration and database failures are safe', async () => {
    const { lines, logger } = capture();
    const supa = fakeSupabase();
    const handle = createReconcileHandler({ getEnv: () => ENV, createClient: supa.createClient, logger });
    assert.equal((await handle(cron('not json'))).status, 400);
    assert.equal((await handle(cron({ action: 'drop' }))).status, 400);
    assert.equal((await handle(cron({ action: 'daily', business_date: '26-09-2026' }))).status, 400);
    assert.equal((await handle(cron('x'.repeat(2048)))).status, 413);
    assert.equal(supa.calls.rpc.length, 0);

    const noDaraja = { ...ENV };
    delete noDaraja.DARAJA_SANDBOX_CONSUMER_SECRET;
    assert.equal((await createReconcileHandler({ getEnv: () => noDaraja, createClient: supa.createClient, logger })(cron({ action: 'sweep' }))).status, 503);

    const broken = fakeSupabase({ rpc: async () => ({ data: null, error: { message: `relation funding.payments: ${SECRETS[3]}` } }) });
    const response = await createReconcileHandler({ getEnv: () => ENV, createClient: broken.createClient, logger })(cron({ action: 'daily' }));
    const payload = await json(response);
    assert.equal(response.status, 500);
    assert.equal(payload.error.code, 'internal');
    assertNoSecrets([JSON.stringify(payload)]);
});

test('reconcile: sweep and daily call the service RPCs; daily defaults to yesterday in Nairobi', async () => {
    const supa = fakeSupabase({
        rpc: async (name) => ({
            data: name === 'funding_svc_expire_stale' ? { to_unknown: 0, expired: 0 }
                : name === 'funding_svc_open_payments' ? []
                    : { run_id: 'r1', status: 'DIFFERENCES', differences: [{ kind: 'statement_missing' }] },
            error: null,
        }),
    });
    // 2026-09-26 22:30 UTC is 2026-09-27 01:30 in Nairobi, so yesterday is 2026-09-26.
    const handle = createReconcileHandler({ getEnv: () => ENV, createClient: supa.createClient, logger: capture().logger, now: () => Date.parse('2026-09-26T22:30:00Z') });
    let response = await handle(cron(undefined));
    assert.equal(response.status, 200);
    assert.deepEqual(await json(response), { expired: { to_unknown: 0, expired: 0 }, checked: 0, results: [] });
    response = await handle(cron({ action: 'daily' }));
    assert.deepEqual(await json(response), { run_id: 'r1', status: 'DIFFERENCES', differences: 1 });
    assert.deepEqual(supa.calls.rpc.at(-1), { name: 'funding_svc_reconcile', args: { p_environment: 'SANDBOX', p_business_date: '2026-09-26' } });
    await handle(cron({ action: 'daily', business_date: '2026-09-20' }));
    assert.equal(supa.calls.rpc.at(-1).args.p_business_date, '2026-09-20');
});
