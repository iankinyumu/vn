// Real-mode funding, Daraja sandbox (docs/REAL_FUNDING_DESIGN.md), on real
// PostgreSQL. The Edge Function flow (supabase/functions/_shared/funding-flow.mjs)
// runs against the migrations with a scripted Daraja double: no network call is
// made and no provider identifier here is real.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { handleCallback, initiateDeposit, reconcileOpenPayments, sha256Hex } from '../supabase/functions/_shared/funding-flow.mjs';
import { FUNDING_MIGRATIONS, V3_MIGRATIONS, asUser, createRealDatabase, identities } from './helpers/pg-real.mjs';

const CONFIG = Object.freeze({ environment: 'SANDBOX', callbackBase: 'https://abcdefghijklmnopqrst.supabase.co/functions/v1' });
const PHONE = '0712345678';
const errorOf = async (promise) => { try { await promise; return null; } catch (error) { return error.name === 'FundingError' ? error.code : error.message; } };

let T, db;
before(async () => {
    T = await createRealDatabase({ extra: [...V3_MIGRATIONS, ...FUNDING_MIGRATIONS] });
    db = T.db;
});
after(async () => { await T?.close(); });

const as = (name, sql, params) => asUser(db, name, () => db.query(sql, params));
const one = async (name, sql, params) => (await as(name, sql, params)).rows[0];

async function serviceRpc(name, args) {
    const keys = Object.keys(args);
    await db.exec('set role service_role');
    try {
        const { rows } = await db.query(`select public.${name}(${keys.map((key, i) => `${key} => $${i + 1}`).join(', ')}) as r`, keys.map((key) => args[key]));
        return rows[0].r;
    } finally { await db.exec('reset role'); }
}

/** Scripted Daraja: each call takes the next scripted answer (or the default). */
function fakeDaraja({ push = [], query = [] } = {}) {
    const calls = { push: [], query: [] };
    let n = 0;
    return {
        calls,
        environment: 'SANDBOX',
        async stkPush(request) {
            calls.push.push(request);
            const next = push.shift() ?? 'ACCEPTED';
            if (next === 'ACCEPTED') { n += 1; return { outcome: 'ACCEPTED', merchantRequestId: `MR-${n}`, checkoutRequestId: `ws_CO_TEST_${Date.now()}_${n}`, responseCode: '0', responseDescription: 'Success. Request accepted for processing' }; }
            if (next === 'REJECTED') return { outcome: 'REJECTED', responseCode: '400.002.02', responseDescription: 'Bad Request - Invalid PhoneNumber' };
            return { outcome: 'AMBIGUOUS', responseCode: 'network', responseDescription: 'TimeoutError' };
        },
        async stkQuery(checkoutRequestId) {
            calls.query.push(checkoutRequestId);
            const next = query.shift() ?? '0';
            if (next === 'PROCESSING') return { outcome: 'PROCESSING', resultCode: null, resultDesc: 'The transaction is being processed' };
            if (next === 'ERROR') return { outcome: 'ERROR', resultCode: null, resultDesc: 'http_503' };
            return { outcome: 'RESULT', resultCode: next, resultDesc: next === '0' ? 'The service request is processed successfully.' : 'Request cancelled by user' };
        },
    };
}

function callbackBody({ checkout, code = 0, amount, receipt, phone = '254712345678' }) {
    const items = code === 0 ? [{ Name: 'Amount', Value: amount }, { Name: 'MpesaReceiptNumber', Value: receipt }, { Name: 'TransactionDate', Value: 20260925120000 }, { Name: 'PhoneNumber', Value: Number(phone) }] : undefined;
    return JSON.stringify({ Body: { stkCallback: { MerchantRequestID: 'MR', CheckoutRequestID: checkout, ResultCode: code, ResultDesc: code === 0 ? 'The service request is processed successfully.' : 'Request cancelled by user', ...(items ? { CallbackMetadata: { Item: items } } : {}) } } });
}

const nairobiToday = () => new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
const quote = async (name, usd) => (await one(name, 'select public.funding_create_deposit_quote($1) q', [usd])).q;
const payment = async (id) => (await db.query('select * from funding.payments where id=$1', [id])).rows[0];
const testBalance = async (name) => Number((await db.query(`select coalesce(sum(amount),0) b from funding.usd_ledger_entries where account_code='CUSTOMER_TEST_BALANCE' and user_id=$1`, [identities[name].id])).rows[0].b);

/** Runs one deposit to PENDING and returns the payment id, checkout id and callback token. */
async function startDeposit(name, usd, daraja, key = `key-${Math.random().toString(16).slice(2)}`) {
    const q = await quote(name, usd);
    const token = `tok${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`;
    const view = await initiateDeposit({ rpc: serviceRpc, daraja, config: CONFIG, userId: identities[name].id, quoteId: q.quote_id, phone: PHONE, idempotencyKey: key, token });
    const row = await payment(view.payment_id);
    return { q, view, token, key, id: view.payment_id, checkout: row.checkout_request_id };
}

test('sandbox is closed until the owner opens the module and lists the tester', async () => {
    assert.match(await errorOf(as('customer', 'select public.funding_create_deposit_quote(5)')), /sandbox_not_enabled/);
    await as('ian', `select public.funding_set_sandbox_module(true, 'Open Daraja sandbox for the owner test run')`);
    assert.match(await errorOf(as('customer', 'select public.funding_create_deposit_quote(5)')), /sandbox_not_enabled/, 'module on, but not a tester');
    assert.match(await errorOf(as('administrator', `select public.funding_set_sandbox_tester($1, true, 'administrators cannot manage funding')`, [identities.customer.id])), /forbidden/);
    for (const name of ['customer', 'customer2']) {
        await as('ian', `select public.funding_set_sandbox_tester($1, true, 'Sandbox tester for Phase 2 evidence')`, [identities[name].id]);
    }
    await as('ian', `select public.funding_publish_rate(129.62, $1::date, 'https://www.centralbank.go.ke/rates/forex-exchange-rates/', 'CBK mean rate for the test day')`, [nairobiToday()]);
    // No treasury snapshot yet: a quote is allowed, a payment is not.
    const q = await quote('customer', 5);
    assert.equal(await errorOf(initiateDeposit({ rpc: serviceRpc, daraja: fakeDaraja(), config: CONFIG, userId: identities.customer.id, quoteId: q.quote_id, phone: PHONE, idempotencyKey: 'no-treasury-1' })), 'treasury_unknown');
    await as('ian', `select public.funding_record_treasury_snapshot('SANDBOX', 10000000, 'Sandbox test float, not real cash')`);
});

test('USD 5.00 quotes to KES 649 at 129.62 with KES 0.90 in the rounding account; bad amounts are refused', async () => {
    const q = await quote('customer', 5);
    assert.equal(q.kes_due, 649);
    assert.equal(Number(q.kes_per_usd), 129.62);
    assert.equal(q.environment, 'SANDBOX');
    const row = (await db.query('select kes_rounding::text r, extract(epoch from expires_at - created_at)::int ttl from funding.deposit_quotes where id=$1', [q.quote_id])).rows[0];
    assert.equal(row.r, '0.900000');
    assert.equal(row.ttl, 300);
    assert.equal(Number((await quote('customer', 12.34)).kes_due), Math.ceil(12.34 * 129.62)); // 1599.5108 → 1600
    assert.match(await errorOf(as('customer', 'select public.funding_create_deposit_quote(4.99)')), /amount_below_minimum/);
    assert.match(await errorOf(as('customer', 'select public.funding_create_deposit_quote(5.001)')), /amount_invalid/);
    assert.match(await errorOf(as('customer', 'select public.funding_create_deposit_quote(2000)')), /amount_above_maximum/);
});

test('happy path: push, callback, provider status confirms, USD credited once; replay does nothing', async () => {
    const daraja = fakeDaraja();
    const d = await startDeposit('customer', 5, daraja);
    assert.equal(d.view.state, 'PENDING');
    assert.deepEqual(daraja.calls.push.map((c) => [c.amount, c.phone]), [[649, '254712345678']]);
    assert.match(daraja.calls.push[0].callbackUrl, /^https:\/\/abcdefghijklmnopqrst\.supabase\.co\/functions\/v1\/daraja-callback\?t=/);
    assert.equal(await testBalance('customer'), 0, 'no credit before the callback and status');

    const body = callbackBody({ checkout: d.checkout, amount: 649, receipt: 'TST0000001' });
    assert.deepEqual(await handleCallback({ rpc: serviceRpc, daraja, bodyText: body, token: d.token }), { status: 200, body: { ResultCode: 0, ResultDesc: 'Accepted' } });
    let row = await payment(d.id);
    assert.equal(row.state, 'CONFIRMED');
    assert.equal(row.mpesa_receipt, 'TST0000001');
    assert.equal(row.receipt_pending, false);
    assert.equal(await testBalance('customer'), 5);
    const kes = (await db.query(`select kind, kes_amount::text a from funding.kes_clearing_entries where payment_id=$1 order by kind`, [d.id])).rows;
    assert.deepEqual(kes.map((k) => [k.kind, k.a]), [['RECEIPT', '649.000000'], ['ROUNDING', '0.900000']]);

    for (let i = 0; i < 3; i += 1) await handleCallback({ rpc: serviceRpc, daraja, bodyText: body, token: d.token });
    assert.equal(await testBalance('customer'), 5, 'replays never credit again');
    const event = (await db.query(`select duplicate_count from funding.provider_events where payment_id=$1 and source='CALLBACK'`, [d.id])).rows[0];
    assert.equal(event.duplicate_count, 3);
    assert.equal((await db.query(`select count(*)::int n from public.ledger_entries`)).rows[0].n > 0, true);
    assert.equal((await db.query(`select count(*)::int n from public.trading_accounts where execution_mode='REAL'`)).rows[0].n, 0, 'no Real account exists or is created');

    const mine = (await one('customer', 'select public.funding_my_payments() p')).p;
    assert.equal(mine[0].state, 'CONFIRMED');
    assert.match(mine[0].status_message, /non-spendable sandbox test balance/);
    assert.equal(mine[0].phone_masked, '2547*****678');
    assert.equal((await one('customer2', 'select public.funding_my_payments() p')).p.length, 0, 'another user sees none of it');
});

test('a repeated idempotency key never pushes twice; a reused key on another quote is refused', async () => {
    const daraja = fakeDaraja({ query: ['1032'] });
    const d = await startDeposit('customer2', 5, daraja, 'same-key-0001');
    const again = await initiateDeposit({ rpc: serviceRpc, daraja, config: CONFIG, userId: identities.customer2.id, quoteId: d.q.quote_id, phone: PHONE, idempotencyKey: 'same-key-0001' });
    assert.equal(again.payment_id, d.id);
    assert.equal(daraja.calls.push.length, 1);
    const other = await quote('customer2', 6);
    assert.equal(await errorOf(initiateDeposit({ rpc: serviceRpc, daraja, config: CONFIG, userId: identities.customer2.id, quoteId: other.quote_id, phone: PHONE, idempotencyKey: 'same-key-0001' })), 'idempotency_key_reused');
    assert.equal(await errorOf(initiateDeposit({ rpc: serviceRpc, daraja, config: CONFIG, userId: identities.customer2.id, quoteId: other.quote_id, phone: PHONE, idempotencyKey: 'other-key-0002' })), 'payment_in_progress', 'one open payment per user');
    // Customer cancels on the phone: failure callback, provider agrees.
    await handleCallback({ rpc: serviceRpc, daraja, bodyText: callbackBody({ checkout: d.checkout, code: 1032 }), token: d.token });
    assert.equal((await payment(d.id)).state, 'FAILED');
    assert.equal(await testBalance('customer2'), 0);
    assert.equal(await errorOf(initiateDeposit({ rpc: serviceRpc, daraja, config: CONFIG, userId: identities.customer2.id, quoteId: d.q.quote_id, phone: PHONE, idempotencyKey: 'third-key-0003' })), 'quote_used');
});

test('forged callbacks without the payment token are ignored and write nothing', async () => {
    const daraja = fakeDaraja();
    const d = await startDeposit('customer2', 5, daraja);
    const before = (await db.query('select count(*)::int n from funding.provider_events')).rows[0].n;
    const forged = callbackBody({ checkout: d.checkout, amount: 649, receipt: 'FORGED0001' });
    for (const token of [undefined, 'short', 'x'.repeat(40), `${d.token}x`]) {
        assert.equal((await handleCallback({ rpc: serviceRpc, daraja, bodyText: forged, token })).status, 200);
    }
    assert.equal((await db.query('select count(*)::int n from funding.provider_events')).rows[0].n, before);
    assert.equal((await payment(d.id)).state, 'PENDING');
    assert.equal(daraja.calls.query.length, 0, 'no verification was triggered');
    // Callback lost: the reconcile sweep queries the provider and confirms with the receipt pending.
    assert.equal((await serviceRpc('funding_svc_open_payments', { p_min_age_seconds: 60, p_limit: 50 })).length, 0, 'too recent to sweep');
    await db.query(`update funding.payments set updated_at = now() - interval '2 minutes' where id=$1`, [d.id]);
    const swept = await reconcileOpenPayments({ rpc: serviceRpc, daraja, minAgeSeconds: 60 });
    assert.deepEqual(swept.results, [{ payment_id: d.id, state: 'CONFIRMED' }]);
    const row = await payment(d.id);
    assert.equal(row.receipt_pending, true);
    assert.equal(row.mpesa_receipt, null);
    assert.equal(await testBalance('customer2'), 5);
});

test('a malformed callback with the right token is recorded as a mismatch and only prompts a status query', async () => {
    const daraja = fakeDaraja({ query: ['PROCESSING'] });
    const d = await startDeposit('customer2', 5, daraja);
    await handleCallback({ rpc: serviceRpc, daraja, bodyText: '{"Body":{}}', token: d.token });
    assert.equal((await db.query(`select verdict from funding.provider_events where payment_id=$1 and source='CALLBACK'`, [d.id])).rows[0].verdict, 'MISMATCH');
    assert.deepEqual(daraja.calls.query, [d.checkout]);
    assert.equal((await payment(d.id)).state, 'PENDING', 'still processing at the provider');
    // The provider later reports the customer cancelled.
    const later = fakeDaraja({ query: ['1032'] });
    await db.query(`update funding.payments set updated_at = now() - interval '2 minutes' where id=$1`, [d.id]);
    await reconcileOpenPayments({ rpc: serviceRpc, daraja: later });
    assert.equal((await payment(d.id)).state, 'FAILED');
});

test('altered amount, checkout conflict and callback/status disagreement go to manual review without credit', async () => {
    const balance = await testBalance('customer');
    // Amount altered in the callback.
    let daraja = fakeDaraja();
    let d = await startDeposit('customer', 5, daraja);
    await handleCallback({ rpc: serviceRpc, daraja, bodyText: callbackBody({ checkout: d.checkout, amount: 1, receipt: 'TST0000002' }), token: d.token });
    let row = await payment(d.id);
    assert.equal(row.state, 'MANUAL_REVIEW');
    assert.equal(row.attention_reason, 'callback_mismatch');
    assert.equal(await testBalance('customer'), balance);

    // Callback says success, provider status says cancelled.
    daraja = fakeDaraja({ query: ['1032'] });
    d = await startDeposit('customer', 5, daraja);
    await handleCallback({ rpc: serviceRpc, daraja, bodyText: callbackBody({ checkout: d.checkout, amount: 649, receipt: 'TST0000003' }), token: d.token });
    row = await payment(d.id);
    assert.equal(row.state, 'MANUAL_REVIEW');
    assert.equal(row.attention_reason, 'status_failure_callback_success');
    assert.equal(await testBalance('customer'), balance);

    // A callback for a different checkout id than the one Daraja accepted.
    daraja = fakeDaraja();
    d = await startDeposit('customer', 5, daraja);
    await handleCallback({ rpc: serviceRpc, daraja, bodyText: callbackBody({ checkout: 'ws_CO_OTHER', amount: 649, receipt: 'TST0000004' }), token: d.token });
    row = await payment(d.id);
    assert.equal(row.state, 'MANUAL_REVIEW');
    assert.equal(row.attention_reason, 'callback_checkout_conflict');

    // A receipt already used by another payment.
    daraja = fakeDaraja();
    d = await startDeposit('customer', 5, daraja);
    await handleCallback({ rpc: serviceRpc, daraja, bodyText: callbackBody({ checkout: d.checkout, amount: 649, receipt: 'TST0000001' }), token: d.token });
    assert.equal((await payment(d.id)).state, 'MANUAL_REVIEW');
    assert.equal(await testBalance('customer'), balance);
});

test('ambiguous initiation: no retry push; a token-bound callback plus provider status resolves it', async () => {
    const daraja = fakeDaraja({ push: ['AMBIGUOUS'] });
    const d = await startDeposit('customer', 7.5, daraja);
    assert.equal(d.view.state, 'UNKNOWN');
    assert.equal(d.checkout, null);
    const next = await quote('customer', 5);
    assert.equal(await errorOf(initiateDeposit({ rpc: serviceRpc, daraja, config: CONFIG, userId: identities.customer.id, quoteId: next.quote_id, phone: PHONE, idempotencyKey: 'after-unknown-1' })), 'payment_in_progress');
    assert.equal(daraja.calls.push.length, 1);
    const before = await testBalance('customer');
    await handleCallback({ rpc: serviceRpc, daraja, bodyText: callbackBody({ checkout: 'ws_CO_LATE_1', amount: 973, receipt: 'TST0000005' }), token: d.token });
    const row = await payment(d.id);
    assert.equal(row.state, 'CONFIRMED');
    assert.equal(row.checkout_request_id, 'ws_CO_LATE_1');
    assert.equal(await testBalance('customer'), before + 7.5); // ceil(7.5 × 129.62) = 973
});

test('late and conflicting provider facts after a final state never change money', async () => {
    const daraja = fakeDaraja();
    const d = await startDeposit('customer2', 5, daraja);
    await handleCallback({ rpc: serviceRpc, daraja, bodyText: callbackBody({ checkout: d.checkout, amount: 649, receipt: 'TST0000010' }), token: d.token });
    const balance = await testBalance('customer2');
    assert.equal((await payment(d.id)).state, 'CONFIRMED');
    await handleCallback({ rpc: serviceRpc, daraja, bodyText: callbackBody({ checkout: d.checkout, code: 1032 }), token: d.token });
    const row = await payment(d.id);
    assert.equal(row.state, 'CONFIRMED', 'a credited payment is changed only by a two-person reversal');
    assert.equal(row.attention_reason, 'late_callback_conflict');
    assert.equal(await testBalance('customer2'), balance);
    const late = await serviceRpc('funding_svc_record_status', { p_payment: d.id, p_checkout_request_id: d.checkout, p_outcome: 'RESULT', p_result_code: '0', p_result_desc: 'again' });
    assert.equal(late.state, 'CONFIRMED');
    assert.equal(await testBalance('customer2'), balance);
    assert.match(await errorOf(serviceRpc('funding_svc_record_status', { p_payment: d.id, p_checkout_request_id: 'ws_CO_WRONG', p_outcome: 'RESULT', p_result_code: '0', p_result_desc: 'x' })), /checkout_mismatch/);
});

test('time rules: abandoned initiation becomes UNKNOWN, UNKNOWN expires at 24h, unresolved provider goes to review', async () => {
    // The Edge Function died after begin_payment: no initiation was ever recorded.
    const q = await quote('customer', 5);
    const begun = await serviceRpc('funding_svc_begin_payment', { p_user: identities.customer.id, p_quote: q.quote_id, p_phone: '254712345678', p_idempotency_key: 'abandoned-0001', p_callback_token_hash: await sha256Hex('abandoned-token-abandoned-token') });
    assert.equal(begun.state, 'INITIATING');
    await db.query(`update funding.payments set created_at = now() - interval '3 minutes' where id=$1`, [begun.payment_id]);
    assert.deepEqual(await serviceRpc('funding_svc_expire_stale', {}), { to_unknown: 1, expired: 0 });
    assert.equal((await payment(begun.payment_id)).state, 'UNKNOWN');
    await db.query(`update funding.payments set created_at = now() - interval '25 hours' where id=$1`, [begun.payment_id]);
    assert.deepEqual(await serviceRpc('funding_svc_expire_stale', {}), { to_unknown: 0, expired: 1 });
    assert.equal((await payment(begun.payment_id)).state, 'EXPIRED');

    const daraja = fakeDaraja({ query: ['ERROR'] });
    const d = await startDeposit('customer', 5, daraja);
    await db.query(`update funding.payments set created_at = now() - interval '25 hours', updated_at = now() - interval '2 minutes' where id=$1`, [d.id]);
    await reconcileOpenPayments({ rpc: serviceRpc, daraja });
    const row = await payment(d.id);
    assert.equal(row.state, 'MANUAL_REVIEW');
    assert.equal(row.attention_reason, 'provider_unresolved_24h');
});

test('provider rejection is final and moves no money; stale and expired quotes are refused', async () => {
    const daraja = fakeDaraja({ push: ['REJECTED'] });
    const d = await startDeposit('customer', 5, daraja);
    assert.equal(d.view.state, 'REJECTED');
    assert.match(d.view.status_message, /No money was taken/);

    const q = await quote('customer', 5);
    await db.query(`insert into funding.deposit_quotes(user_id, environment, policy_version, rate_version, kes_per_usd, rate_date, usd_amount, kes_due, kes_rounding, created_at, expires_at)
        select user_id, environment, policy_version, rate_version, kes_per_usd, rate_date, usd_amount, kes_due, kes_rounding, now() - interval '10 minutes', now() - interval '5 minutes'
          from funding.deposit_quotes where id=$1`, [q.quote_id]);
    const expired = (await db.query(`select id from funding.deposit_quotes where expires_at < now() order by created_at desc limit 1`)).rows[0].id;
    assert.equal(await errorOf(initiateDeposit({ rpc: serviceRpc, daraja, config: CONFIG, userId: identities.customer.id, quoteId: expired, phone: PHONE, idempotencyKey: 'expired-quote-1' })), 'quote_expired');
    assert.equal(await errorOf(initiateDeposit({ rpc: serviceRpc, daraja, config: CONFIG, userId: identities.customer2.id, quoteId: q.quote_id, phone: PHONE, idempotencyKey: 'not-my-quote-1' })), 'quote_not_found');
    assert.equal(await errorOf(initiateDeposit({ rpc: serviceRpc, daraja, config: CONFIG, userId: identities.customer.id, quoteId: q.quote_id, phone: '0812345678', idempotencyKey: 'bad-phone-0001' })), 'phone_invalid');

    await as('ian', `select public.funding_publish_rate(130.10, '2026-09-01', 'https://www.centralbank.go.ke/rates/forex-exchange-rates/', 'Old rate to prove staleness fails closed')`);
    assert.match(await errorOf(as('customer', 'select public.funding_create_deposit_quote(5)')), /rate_stale/);
    assert.match(await errorOf(as('ian', `select public.funding_publish_rate(129.00, $1::date + 2, 'x-ref', 'A future rate date is refused')`, [nairobiToday()])), /rate_invalid/);
    await as('ian', `select public.funding_publish_rate(129.62, $1::date, 'https://www.centralbank.go.ke/rates/forex-exchange-rates/', 'Restore the current CBK rate')`, [nairobiToday()]);
    // The issued quote keeps its locked rate.
    assert.equal(Number((await db.query('select kes_per_usd from funding.deposit_quotes where id=$1', [q.quote_id])).rows[0].kes_per_usd), 129.62);
});

test('treasury coverage below 110% pauses new payments; alert band still allows them', async () => {
    const status = async () => (await one('ian', `select public.funding_staff_overview('SANDBOX') o`)).o.treasury;
    const liability = Number((await status()).liability_usd);
    assert.ok(liability > 0);
    const stressed = liability * 129.62 * 1.1;
    await as('ian', `select public.funding_record_treasury_snapshot('SANDBOX', $1, 'Coverage at 105 percent of stressed liability')`, [Math.floor(stressed * 1.05)]);
    assert.equal((await status()).status, 'PAUSED');
    const q = await quote('customer2', 5);
    assert.equal(await errorOf(initiateDeposit({ rpc: serviceRpc, daraja: fakeDaraja(), config: CONFIG, userId: identities.customer2.id, quoteId: q.quote_id, phone: PHONE, idempotencyKey: 'treasury-pause-1' })), 'treasury_paused');
    await as('ian', `select public.funding_record_treasury_snapshot('SANDBOX', $1, 'Coverage at 95 percent of stressed liability')`, [Math.floor(stressed * 0.95)]);
    assert.equal((await status()).status, 'INCIDENT');
    await as('ian', `select public.funding_record_treasury_snapshot('SANDBOX', $1, 'Coverage at 115 percent of stressed liability')`, [Math.ceil(stressed * 1.15)]);
    assert.equal((await status()).status, 'ALERT');
    await as('ian', `select public.funding_record_treasury_snapshot('SANDBOX', 10000000, 'Sandbox test float restored')`);
    assert.equal((await status()).status, 'OK');
});

test('reversal and manual resolution need two different owners; reconciliation matches the ledger', async () => {
    const confirmed = (await db.query(`select id, usd_amount from funding.payments where user_id=$1 and state='CONFIRMED' order by created_at limit 1`, [identities.customer.id])).rows[0];
    const before = await testBalance('customer');
    const request = (await one('ian', `select public.funding_request_action($1, 'REVERSE', 'Customer dispute in sandbox drill') id`, [confirmed.id])).id;
    assert.match(await errorOf(as('ian', `select public.funding_approve_action($1, 'Approving my own request')`, [request])), /second_approver_required/);
    assert.match(await errorOf(as('administrator', `select public.funding_approve_action($1, 'Administrator cannot approve')`, [request])), /forbidden/);
    await as('owner', `select public.funding_approve_action($1, 'Second owner approves the reversal')`, [request]);
    assert.equal((await payment(confirmed.id)).state, 'REVERSED');
    assert.equal(await testBalance('customer'), before - Number(confirmed.usd_amount));

    const review = (await db.query(`select id from funding.payments where state='MANUAL_REVIEW' order by created_at limit 1`)).rows[0].id;
    const resolve = (await one('owner', `select public.funding_request_action($1, 'RESOLVE_FAILED', 'Statement shows no receipt for this payment') id`, [review])).id;
    await as('ian', `select public.funding_approve_action($1, 'Checked against the sandbox statement')`, [resolve]);
    assert.equal((await payment(review)).state, 'FAILED');

    const run = await serviceRpc('funding_svc_reconcile', { p_environment: 'SANDBOX', p_business_date: nairobiToday() });
    assert.deepEqual(run.differences.filter((d) => !['needs_attention'].includes(d.kind)), [], JSON.stringify(run.differences));
    assert.equal(Number(run.summary.customer_balance_usd), Number(run.summary.confirmed_usd));
    assert.equal(run.summary.receipt_pending, 1);
});

test('callers cannot reach service RPCs or funding tables, and records are immutable', async () => {
    for (const name of ['customer', 'administrator']) {
        assert.match(await errorOf(as(name, `select public.funding_svc_expire_stale()`)), /permission denied/);
        assert.match(await errorOf(as(name, `select * from funding.payments`)), /permission denied/);
    }
    await db.exec('set role anon');
    try {
        assert.match(await errorOf(db.query(`select public.funding_create_deposit_quote(5)`)), /permission denied/);
    } finally { await db.exec('reset role'); }
    await db.exec('set role service_role');
    try {
        assert.match(await errorOf(db.query(`select * from funding.usd_ledger_entries`)), /permission denied/);
    } finally { await db.exec('reset role'); }
    assert.match(await errorOf(db.query(`update funding.usd_ledger_entries set amount = amount * 2`)), /funding_record_immutable/);
    assert.match(await errorOf(db.query(`delete from funding.payments`)), /funding_record_immutable/);
    assert.match(await errorOf(db.query(`update funding.fx_rate_versions set kes_per_usd = 1`)), /funding_record_immutable/);
    const grants = (await db.query(`select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where (n.nspname='funding' or (n.nspname='public' and p.proname like 'funding\\_svc\\_%'))
          and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))`)).rows[0].n;
    assert.equal(grants, 0);
});

test('production payments are refused by the database', async () => {
    const q = await quote('customer2', 5);
    await db.query(`insert into funding.deposit_quotes(user_id, environment, policy_version, rate_version, kes_per_usd, rate_date, usd_amount, kes_due, kes_rounding, expires_at)
        select user_id, 'PRODUCTION', policy_version, rate_version, kes_per_usd, rate_date, usd_amount, kes_due, kes_rounding, now() + interval '5 minutes'
          from funding.deposit_quotes where id=$1`, [q.quote_id]);
    const prod = (await db.query(`select id from funding.deposit_quotes where environment='PRODUCTION'`)).rows[0].id;
    assert.equal(await errorOf(initiateDeposit({ rpc: serviceRpc, daraja: fakeDaraja(), config: CONFIG, userId: identities.customer2.id, quoteId: prod, phone: PHONE, idempotencyKey: 'production-1' })), 'production_payments_disabled');
    assert.equal((await db.query(`select enabled from public.platform_modules where module_key='daraja_production'`)).rows[0].enabled, false);
    assert.equal((await db.query(`select enabled from public.platform_modules where module_key='real_accounts'`)).rows[0].enabled, false);
    assert.equal(typeof await sha256Hex('x'), 'string');
});
