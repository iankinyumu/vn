// Real-mode funding, Daraja sandbox (docs/REAL_FUNDING_DESIGN.md), on real
// PostgreSQL. The Edge Function flow (supabase/functions/_shared/funding-flow.mjs)
// runs against the migrations with a scripted Daraja double: no network call is
// made and no provider identifier here is real. The tests share one database and
// run in order.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { handleCallback, initiateDeposit, reconcileOpenPayments, sha256Hex } from '../supabase/functions/_shared/funding-flow.mjs';
import { FUNDING_MIGRATIONS, V3_MIGRATIONS, asUser, createRealDatabase, identities } from './helpers/pg-real.mjs';

const SHORTCODE = '174379';
const CONFIG = Object.freeze({ environment: 'SANDBOX', shortcode: SHORTCODE, callbackBase: 'https://abcdefghijklmnopqrst.supabase.co/functions/v1' });
const PHONE = '0712345678';
const MSISDN = '254712345678';
const errorOf = async (promise) => { try { await promise; return null; } catch (error) { return error.name === 'FundingError' ? error.code : error.message; } };

let T, db;
before(async () => {
    T = await createRealDatabase({ extra: [...V3_MIGRATIONS, ...FUNDING_MIGRATIONS] });
    db = T.db;
    // Test fixture: the suite's placeholder number joins the sandbox test MSISDN allowlist.
    await db.query(`insert into funding.sandbox_msisdns(msisdn, note) values ($1, 'test fixture number')`, [MSISDN]);
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

/** A further sandbox customer: an auth user on the tester list. */
async function addCustomer(name, n) {
    identities[name] = { id: `00000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`, email: `${name}@example.test` };
    await db.query('insert into auth.users values($1,$2,now(),$3)', [identities[name].id, identities[name].email, JSON.stringify({ display_name: name })]);
    await as('ian', `select public.funding_set_sandbox_tester($1, true, 'Sandbox tester for funding evidence')`, [identities[name].id]);
}

let checkoutSeq = 0;
let receiptSeq = 0;
const nextReceipt = (prefix = 'GEN') => `${prefix}${String(++receiptSeq).padStart(7, '0')}`;

/** Scripted Daraja: each call takes the next scripted answer (or the default). */
function fakeDaraja({ push = [], query = [] } = {}) {
    const calls = { push: [], query: [] };
    return {
        calls,
        environment: 'SANDBOX',
        async stkPush(request) {
            calls.push.push(request);
            const next = push.shift() ?? 'ACCEPTED';
            if (next === 'ACCEPTED') { checkoutSeq += 1; return { outcome: 'ACCEPTED', merchantRequestId: `MR-${checkoutSeq}`, checkoutRequestId: `ws_CO_TEST_${checkoutSeq}`, responseCode: '0', responseDescription: 'Success. Request accepted for processing' }; }
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

function callbackBody({ checkout, code = 0, amount, receipt, phone = MSISDN }) {
    const items = code === 0 ? [{ Name: 'Amount', Value: amount }, { Name: 'MpesaReceiptNumber', Value: receipt }, { Name: 'TransactionDate', Value: 20260925120000 }, { Name: 'PhoneNumber', Value: Number(phone) }] : undefined;
    return JSON.stringify({ Body: { stkCallback: { MerchantRequestID: 'MR', CheckoutRequestID: checkout, ResultCode: code, ResultDesc: code === 0 ? 'The service request is processed successfully.' : 'Request cancelled by user', ...(items ? { CallbackMetadata: { Item: items } } : {}) } } });
}

const nairobiDay = (offsetDays = 0) => new Date(Date.now() + 3 * 3600 * 1000 + offsetDays * 86400 * 1000).toISOString().slice(0, 10);
const nairobiToday = () => nairobiDay(0);
const quote = async (name, usd) => (await one(name, 'select public.funding_create_deposit_quote($1) q', [usd])).q;
const payment = async (id) => (await db.query('select * from funding.payments where id=$1', [id])).rows[0];
const testBalance = async (name) => Number((await db.query(`select coalesce(sum(amount),0) b from funding.usd_ledger_entries where account_code='CUSTOMER_TEST_BALANCE' and user_id=$1`, [identities[name].id])).rows[0].b);
const kesReceipt = async (id) => (await db.query(`select kes_amount::text a, business_date::text d from funding.kes_clearing_entries where payment_id=$1 and kind='RECEIPT'`, [id])).rows[0] ?? null;
const scalar = async (sql, params) => Object.values((await db.query(sql, params)).rows[0])[0];

/** Runs one deposit to PENDING and returns the payment id, checkout id and callback token. */
async function startDeposit(name, usd, daraja, key = `key-${Math.random().toString(16).slice(2)}`) {
    const q = await quote(name, usd);
    const token = `tok${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`;
    const view = await initiateDeposit({ rpc: serviceRpc, daraja, config: CONFIG, userId: identities[name].id, quoteId: q.quote_id, phone: PHONE, idempotencyKey: key, token });
    const row = await payment(view.payment_id);
    return { q, view, token, key, id: view.payment_id, checkout: row.checkout_request_id, row };
}

/** A deposit that runs to CONFIRMED (callback plus provider status). */
async function confirmedDeposit(name, usd) {
    const daraja = fakeDaraja();
    const d = await startDeposit(name, usd, daraja);
    const kes = Math.ceil(Math.round(usd * 100) * 129.62 / 100 - 1e-9);
    await handleCallback({ rpc: serviceRpc, daraja, bodyText: callbackBody({ checkout: d.checkout, amount: kes, receipt: nextReceipt('LIM') }), token: d.token });
    return { ...d, row: await payment(d.id) };
}

/** Publishes a new deposit policy version (policy changes ship as reviewed migrations; here the test does it directly). */
async function publishPolicy(overrides) {
    const base = (await db.query('select * from funding.deposit_policy_versions order by version desc limit 1')).rows[0];
    const p = { ...base, ...overrides, version: base.version + 1 };
    await db.query(`insert into funding.deposit_policy_versions(version, min_usd, max_usd_per_deposit, max_usd_rolling_24h, max_deposits_rolling_24h, max_kes,
        quote_ttl_seconds, rate_max_age_hours, spread_bp, stress_bp, alert_coverage_bp, pause_coverage_bp, incident_coverage_bp, treasury_max_age_hours)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [p.version, p.min_usd, p.max_usd_per_deposit, p.max_usd_rolling_24h, p.max_deposits_rolling_24h, p.max_kes, p.quote_ttl_seconds,
        p.rate_max_age_hours, p.spread_bp, p.stress_bp, p.alert_coverage_bp, p.pause_coverage_bp, p.incident_coverage_bp, p.treasury_max_age_hours]);
}

/** Runs `fn` in a transaction that is always rolled back. */
async function rolledBack(fn) {
    await db.exec('begin');
    try { return await fn(); } finally { await db.exec('rollback'); }
}

const snapshot = (reserve, note) => as('ian', `select public.funding_record_treasury_snapshot('SANDBOX', $1, $2)`, [reserve, note]);

async function recordItem(staff, { receipt = nextReceipt('SIM'), kes, shortcode = SHORTCODE, at = new Date(), accountReference = null, msisdn = null,
    kind = 'SANDBOX_SIMULATED', environment = 'SANDBOX' }) {
    const sha = await sha256Hex(`simulated statement line ${receipt}`);
    return (await one(staff, `select public.funding_record_statement_item($1, $2, $3, $4, $5, $6, $7, $8, 'sandbox simulated statement', $9, 'Sandbox statement line for evidence') id`,
        [environment, receipt, kes, shortcode, at.toISOString(), accountReference, msisdn, kind, sha])).id;
}

// ------------------------------------------------------------------ opening

test('sandbox is closed until the owner opens the module and lists the tester; an empty treasury admits nothing', async () => {
    assert.match(await errorOf(as('customer', 'select public.funding_create_deposit_quote(5)')), /sandbox_not_enabled/);
    assert.deepEqual((await one('customer', 'select public.funding_sandbox_overview() o')).o, { available: false });
    await as('ian', `select public.funding_set_sandbox_module(true, 'Open Daraja sandbox for the owner test run')`);
    assert.match(await errorOf(as('customer', 'select public.funding_create_deposit_quote(5)')), /sandbox_not_enabled/, 'module on, but not a tester');
    assert.match(await errorOf(as('administrator', `select public.funding_set_sandbox_tester($1, true, 'administrators cannot manage funding')`, [identities.customer.id])), /forbidden/);
    for (const name of ['customer', 'customer2']) {
        await as('ian', `select public.funding_set_sandbox_tester($1, true, 'Sandbox tester for Phase 2 evidence')`, [identities[name].id]);
    }
    await as('ian', `select public.funding_publish_rate(129.62, $1::date, 'https://www.centralbank.go.ke/rates/forex-exchange-rates/', 'CBK mean rate for the test day')`, [nairobiToday()]);
    const overview = (await one('customer', 'select public.funding_sandbox_overview() o')).o;
    assert.equal(overview.available, true);
    assert.equal(overview.label, 'Daraja Sandbox - test funds only');
    assert.equal(overview.spendable, false);
    assert.equal(overview.test_balance_usd, 0);
    assert.deepEqual(overview.test_msisdns, ['254708374149', MSISDN]);
    assert.deepEqual((await one('administrator', 'select public.funding_sandbox_overview() o')).o, { available: false }, 'not a tester');
    // No treasury snapshot yet: a quote is allowed, a payment is not.
    const q = await quote('customer', 5);
    assert.equal(await errorOf(initiateDeposit({ rpc: serviceRpc, daraja: fakeDaraja(), config: CONFIG, userId: identities.customer.id, quoteId: q.quote_id, phone: PHONE, idempotencyKey: 'no-treasury-1' })), 'treasury_unknown');
    // A fresh snapshot of KES 0 with no liability reads as OK today, but the first
    // deposit would create an uncovered liability: projected coverage refuses it.
    await snapshot(0, 'Empty sandbox treasury before any float');
    assert.equal((await one('ian', `select public.funding_staff_overview('SANDBOX') o`)).o.treasury.status, 'OK');
    const daraja = fakeDaraja();
    assert.equal(await errorOf(initiateDeposit({ rpc: serviceRpc, daraja, config: CONFIG, userId: identities.customer.id, quoteId: q.quote_id, phone: PHONE, idempotencyKey: 'zero-reserve-1' })), 'treasury_paused');
    assert.equal(daraja.calls.push.length, 0);
    assert.equal(await scalar('select count(*)::int from funding.payments'), 0);
    await snapshot(10000000, 'Sandbox test float, not real cash');
});

// ------------------------------------------------------------------ limits (policy v1, as shipped)

test('policy v1 limits hold server-side: USD 5 minimum, USD 500 per deposit, USD 1,000 and three deposits per rolling 24 hours, KES 250,000 ceiling', async () => {
    const pol = (await db.query('select * from funding.deposit_policy_versions')).rows;
    assert.equal(pol.length, 1);
    assert.deepEqual([pol[0].min_usd, pol[0].max_usd_per_deposit, pol[0].max_usd_rolling_24h, pol[0].max_deposits_rolling_24h, pol[0].max_kes], ['5.00', '500.00', '1000.00', 3, 250000]);
    const rate = (await one('customer', 'select public.funding_reference_rate() r')).r;
    assert.deepEqual([rate.min_usd, rate.max_usd_per_deposit, rate.max_usd_rolling_24h, rate.max_deposits_rolling_24h], [5, 500, 1000, 3]);
    await addCustomer('limitsCount', 1);
    await addCustomer('limitsAmount', 2);

    // Per deposit, at quote time.
    assert.match(await errorOf(as('limitsCount', 'select public.funding_create_deposit_quote(4.99)')), /amount_below_minimum/);
    assert.match(await errorOf(as('limitsCount', 'select public.funding_create_deposit_quote(500.01)')), /amount_above_maximum/);
    assert.equal((await quote('limitsCount', 500)).kes_due, 64810);

    // Per deposit, at payment time, even for a quote row that bypassed the quote RPC.
    for (const [usd, code] of [[4, 'amount_below_minimum'], [600, 'amount_above_maximum']]) {
        const kes = Math.ceil(usd * 129.62);
        const forged = (await db.query(`insert into funding.deposit_quotes(user_id, environment, policy_version, rate_version, kes_per_usd, rate_date, usd_amount, kes_due, kes_rounding, expires_at)
            select $1::uuid, 'SANDBOX', 1, version, kes_per_usd, rate_date, $2::numeric, $3::integer, $3::integer - $2::numeric * kes_per_usd, now() + interval '5 minutes'
              from funding.fx_rate_versions order by version desc limit 1 returning id`,
        [identities.limitsCount.id, usd, kes])).rows[0].id;
        assert.equal(await errorOf(initiateDeposit({ rpc: serviceRpc, daraja: fakeDaraja(), config: CONFIG, userId: identities.limitsCount.id, quoteId: forged, phone: PHONE, idempotencyKey: `forged-${usd}-quote` })), code);
    }

    // The provider ceiling is a second, independent hard limit.
    assert.equal(await scalar(`select funding.limit_refusal($1, 'SANDBOX', 400, 250001, false)`, [identities.limitsCount.id]), 'amount_above_maximum');
    assert.match(await errorOf(publishPolicy({ max_kes: 250001 })), /check constraint/);

    // Three successful deposits per rolling 24 hours.
    const first = await confirmedDeposit('limitsCount', 5);
    for (let i = 0; i < 2; i += 1) assert.equal((await confirmedDeposit('limitsCount', 5)).row.state, 'CONFIRMED');
    assert.equal(first.row.state, 'CONFIRMED');
    assert.match(await errorOf(as('limitsCount', 'select public.funding_create_deposit_quote(5)')), /deposit_limit_reached/);
    // Rolling: once the first credit is more than 24 hours old it no longer counts.
    await db.exec('set session_replication_role = replica');
    try {
        await db.query(`update funding.usd_ledger_transactions set created_at = now() - interval '25 hours' where payment_id=$1`, [first.id]);
    } finally { await db.exec('set session_replication_role = origin'); }
    assert.equal((await quote('limitsCount', 5)).usd_amount, 5);

    // USD 1,000 per rolling 24 hours, checked at quote and again when the quote is used.
    assert.equal((await confirmedDeposit('limitsAmount', 500)).row.state, 'CONFIRMED');
    const second = await quote('limitsAmount', 500);
    const third = await quote('limitsAmount', 5);
    const daraja = fakeDaraja();
    await initiateDeposit({ rpc: serviceRpc, daraja, config: CONFIG, userId: identities.limitsAmount.id, quoteId: second.quote_id, phone: PHONE, idempotencyKey: 'amount-limit-2' });
    const p2 = (await db.query(`select * from funding.payments where quote_id=$1`, [second.quote_id])).rows[0];
    await serviceRpc('funding_svc_record_status', { p_payment: p2.id, p_checkout_request_id: p2.checkout_request_id, p_outcome: 'RESULT', p_result_code: '0', p_result_desc: 'ok' });
    assert.equal((await payment(p2.id)).state, 'CONFIRMED');
    assert.equal(await testBalance('limitsAmount'), 1000);
    assert.equal(await errorOf(initiateDeposit({ rpc: serviceRpc, daraja, config: CONFIG, userId: identities.limitsAmount.id, quoteId: third.quote_id, phone: PHONE, idempotencyKey: 'amount-limit-3' })), 'deposit_limit_reached');
    assert.match(await errorOf(as('limitsAmount', 'select public.funding_create_deposit_quote(5)')), /deposit_limit_reached/);

    // Limits are re-checked in the crediting transaction: a stricter policy
    // published while a payment is open holds the paid money in suspense.
    const held = await startDeposit('limitsCount', 5, fakeDaraja());
    await publishPolicy({ max_deposits_rolling_24h: 2 });
    await serviceRpc('funding_svc_record_status', { p_payment: held.id, p_checkout_request_id: held.checkout, p_outcome: 'RESULT', p_result_code: '0', p_result_desc: 'ok' });
    const row = await payment(held.id);
    assert.equal(row.state, 'MANUAL_REVIEW');
    assert.equal(row.attention_reason, 'funded_suspense_deposit_limit_reached');
    assert.ok(row.provider_confirmed_at, 'the money is recorded as received');
    assert.equal(row.credit_transaction_id, null);
    assert.equal((await kesReceipt(held.id)).a, '649.000000', 'the KES is booked as received');
    assert.equal(await testBalance('limitsCount'), 15, 'the three earlier credits, none for the held payment');

    // Limits fail closed without a policy.
    await rolledBack(async () => {
        await db.exec('set local session_replication_role = replica');
        await db.query('delete from funding.deposit_policy_versions');
        await db.exec('set local session_replication_role = origin');
        assert.match(await errorOf(db.query('select funding.policy()')), /deposit_policy_unavailable/);
    });

    // The remaining cases exercise the state machine, not the limits: a test
    // policy keeps the per-deposit limit and relaxes the rolling ones.
    await publishPolicy({ max_usd_rolling_24h: 100000, max_deposits_rolling_24h: 100 });
});

// ------------------------------------------------------------------ state machine

test('USD 5.00 quotes to KES 649 at 129.62 with KES 0.90 in the rounding account; bad amounts are refused', async () => {
    const q = await quote('customer', 5);
    assert.equal(q.kes_due, 649);
    assert.equal(Number(q.kes_per_usd), 129.62);
    assert.equal(q.environment, 'SANDBOX');
    assert.equal(q.kes_rounding, 0.9);
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
    assert.equal(d.row.shortcode, SHORTCODE);
    assert.deepEqual(daraja.calls.push.map((c) => [c.amount, c.phone]), [[649, MSISDN]]);
    assert.match(daraja.calls.push[0].callbackUrl, /^https:\/\/abcdefghijklmnopqrst\.supabase\.co\/functions\/v1\/daraja-callback\?t=/);
    assert.equal(await testBalance('customer'), 0, 'no credit before the callback and status');

    const body = callbackBody({ checkout: d.checkout, amount: 649, receipt: 'TST0000001' });
    assert.deepEqual(await handleCallback({ rpc: serviceRpc, daraja, bodyText: body, token: d.token }), { status: 200, body: { ResultCode: 0, ResultDesc: 'Accepted' } });
    let row = await payment(d.id);
    assert.equal(row.state, 'CONFIRMED');
    assert.equal(row.mpesa_receipt, null, 'a callback receipt is a claim, never the verified receipt');
    assert.equal(row.receipt_pending, true, 'identity waits for a statement item');
    assert.equal((await db.query(`select receipt from funding.provider_events where payment_id=$1 and source='CALLBACK'`, [d.id])).rows[0].receipt, 'TST0000001');
    assert.ok(row.provider_confirmed_at);
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

// ------------------------------------------------------------------ R1: callbacks never bind a checkout

let unboundPayment; // the ambiguous 7.5 USD payment, resolved later with statement evidence
let racePayment;

test('a leaked token with another customer\'s successful checkout id never credits an ambiguous initiation', async () => {
    const victimCheckout = (await db.query(`select checkout_request_id from funding.payments where user_id=$1 and state='CONFIRMED' order by created_at limit 1`, [identities.customer2.id])).rows[0].checkout_request_id;
    assert.ok(victimCheckout);
    const daraja = fakeDaraja({ push: ['AMBIGUOUS'] }); // the double would answer ResultCode 0 for any query
    const d = await startDeposit('customer', 7.5, daraja);
    unboundPayment = d.id;
    assert.equal(d.view.state, 'UNKNOWN');
    assert.equal(d.checkout, null);
    const next = await quote('customer', 5);
    assert.equal(await errorOf(initiateDeposit({ rpc: serviceRpc, daraja, config: CONFIG, userId: identities.customer.id, quoteId: next.quote_id, phone: PHONE, idempotencyKey: 'after-unknown-1' })), 'payment_in_progress');
    assert.equal(daraja.calls.push.length, 1, 'an ambiguous push is never retried');

    const before = await testBalance('customer');
    const body = callbackBody({ checkout: victimCheckout, amount: 973, receipt: 'TST0000005' }); // ceil(7.5 × 129.62) = 973
    assert.equal((await handleCallback({ rpc: serviceRpc, daraja, bodyText: body, token: d.token })).status, 200);
    await handleCallback({ rpc: serviceRpc, daraja, bodyText: body, token: d.token });
    const row = await payment(d.id);
    assert.equal(row.state, 'MANUAL_REVIEW');
    assert.equal(row.attention_reason, 'callback_without_initiation_checkout');
    assert.equal(row.checkout_request_id, null, 'a callback never supplies the verified checkout id');
    assert.equal(row.callback_checkout_request_id, victimCheckout);
    assert.equal(row.mpesa_receipt, null);
    assert.equal(row.provider_confirmed_at, null);
    assert.deepEqual(daraja.calls.query, [], 'the claimed checkout is never queried');
    assert.equal(await testBalance('customer'), before);
    const events = (await db.query(`select verdict, duplicate_count from funding.provider_events where payment_id=$1 and source='CALLBACK'`, [d.id])).rows;
    assert.deepEqual(events, [{ verdict: 'UNBOUND', duplicate_count: 1 }]);
    // Neither the sweep nor a direct status record can reach it.
    await db.query(`update funding.payments set updated_at = now() - interval '2 minutes' where id=$1`, [d.id]);
    assert.equal((await serviceRpc('funding_svc_open_payments', { p_min_age_seconds: 0, p_limit: 200 })).some((p) => p.payment_id === d.id), false);
    assert.match(await errorOf(serviceRpc('funding_svc_record_status', { p_payment: d.id, p_checkout_request_id: victimCheckout, p_outcome: 'RESULT', p_result_code: '0', p_result_desc: 'x' })), /checkout_mismatch/);
    assert.equal(await testBalance('customer'), before);
});

test('a leaked token on a pending payment cannot redirect verification to another checkout', async () => {
    const victimCheckout = (await db.query(`select checkout_request_id from funding.payments where user_id=$1 and state='CONFIRMED' order by created_at limit 1`, [identities.customer2.id])).rows[0].checkout_request_id;
    const daraja = fakeDaraja();
    const d = await startDeposit('customer2', 5, daraja);
    const before = await testBalance('customer2');
    await handleCallback({ rpc: serviceRpc, daraja, bodyText: callbackBody({ checkout: victimCheckout, amount: 649, receipt: nextReceipt() }), token: d.token });
    const row = await payment(d.id);
    assert.equal(row.state, 'MANUAL_REVIEW');
    assert.equal(row.attention_reason, 'callback_checkout_conflict');
    assert.equal(row.checkout_request_id, d.checkout);
    assert.deepEqual(daraja.calls.query, []);
    assert.equal(await testBalance('customer2'), before);
});

test('a callback that beats the initiation response goes to review; the later initiation does not credit it', async () => {
    const q = await quote('customer2', 7.5);
    const token = 'race-token-race-token-race-token';
    const begun = await serviceRpc('funding_svc_begin_payment', { p_user: identities.customer2.id, p_quote: q.quote_id, p_phone: MSISDN, p_idempotency_key: 'race-0001', p_callback_token_hash: await sha256Hex(token), p_shortcode: SHORTCODE });
    racePayment = begun.payment_id;
    const daraja = fakeDaraja();
    await handleCallback({ rpc: serviceRpc, daraja, bodyText: callbackBody({ checkout: 'ws_CO_RACE_1', amount: 973, receipt: nextReceipt() }), token });
    assert.equal((await payment(racePayment)).state, 'MANUAL_REVIEW');
    await serviceRpc('funding_svc_record_initiation', { p_payment: racePayment, p_outcome: 'ACCEPTED', p_merchant_request_id: 'MR-R', p_checkout_request_id: 'ws_CO_RACE_1', p_response_code: '0', p_response_desc: 'ok' });
    const view = await serviceRpc('funding_svc_record_status', { p_payment: racePayment, p_checkout_request_id: 'ws_CO_RACE_1', p_outcome: 'RESULT', p_result_code: '0', p_result_desc: 'ok' });
    assert.equal(view.state, 'MANUAL_REVIEW', 'review needs statement evidence');
    assert.equal((await payment(racePayment)).credit_transaction_id, null);
    assert.deepEqual(daraja.calls.query, []);
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

test('time rules: abandoned initiation becomes UNKNOWN, UNKNOWN expires at 24h, a later callback only opens review', async () => {
    // The Edge Function died after begin_payment: no initiation was ever recorded.
    const q = await quote('customer', 5);
    const token = 'abandoned-token-abandoned-token';
    const begun = await serviceRpc('funding_svc_begin_payment', { p_user: identities.customer.id, p_quote: q.quote_id, p_phone: MSISDN, p_idempotency_key: 'abandoned-0001', p_callback_token_hash: await sha256Hex(token), p_shortcode: SHORTCODE });
    assert.equal(begun.state, 'INITIATING');
    await db.query(`update funding.payments set created_at = now() - interval '3 minutes' where id=$1`, [begun.payment_id]);
    assert.deepEqual(await serviceRpc('funding_svc_expire_stale', {}), { to_unknown: 1, expired: 0 });
    assert.equal((await payment(begun.payment_id)).state, 'UNKNOWN');
    await db.query(`update funding.payments set created_at = now() - interval '25 hours' where id=$1`, [begun.payment_id]);
    assert.deepEqual(await serviceRpc('funding_svc_expire_stale', {}), { to_unknown: 0, expired: 1 });
    assert.equal((await payment(begun.payment_id)).state, 'EXPIRED');
    const daraja = fakeDaraja();
    const before = await testBalance('customer');
    await handleCallback({ rpc: serviceRpc, daraja, bodyText: callbackBody({ checkout: 'ws_CO_LATE_2', amount: 649, receipt: nextReceipt() }), token });
    assert.equal((await payment(begun.payment_id)).state, 'MANUAL_REVIEW');
    assert.deepEqual(daraja.calls.query, []);
    assert.equal(await testBalance('customer'), before);

    const errors = fakeDaraja({ query: ['ERROR'] });
    const d = await startDeposit('customer', 5, errors);
    await db.query(`update funding.payments set created_at = now() - interval '25 hours', updated_at = now() - interval '2 minutes' where id=$1`, [d.id]);
    await reconcileOpenPayments({ rpc: serviceRpc, daraja: errors });
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
    const pushes = daraja.calls.push.length;
    assert.equal(await errorOf(initiateDeposit({ rpc: serviceRpc, daraja, config: CONFIG, userId: identities.customer.id, quoteId: q.quote_id, phone: '0799999999', idempotencyKey: 'real-phone-0001' })), 'phone_not_allowed', 'sandbox never prompts a number outside the test allowlist');
    assert.equal(daraja.calls.push.length, pushes);

    await as('ian', `select public.funding_publish_rate(130.10, '2026-09-01', 'https://www.centralbank.go.ke/rates/forex-exchange-rates/', 'Old rate to prove staleness fails closed')`);
    assert.match(await errorOf(as('customer', 'select public.funding_create_deposit_quote(5)')), /rate_stale/);
    assert.match(await errorOf(as('ian', `select public.funding_publish_rate(129.00, $1::date + 2, 'x-ref', 'A future rate date is refused')`, [nairobiToday()])), /rate_invalid/);
    await as('ian', `select public.funding_publish_rate(129.62, $1::date, 'https://www.centralbank.go.ke/rates/forex-exchange-rates/', 'Restore the current CBK rate')`, [nairobiToday()]);
    // The issued quote keeps its locked rate.
    assert.equal(Number((await db.query('select kes_per_usd from funding.deposit_quotes where id=$1', [q.quote_id])).rows[0].kes_per_usd), 129.62);
});

// ------------------------------------------------------------------ R2: treasury

test('treasury coverage below 110% pauses new payments; statuses follow the snapshot', async () => {
    const status = async () => (await one('ian', `select public.funding_staff_overview('SANDBOX') o`)).o.treasury;
    const liability = Number((await status()).liability_usd);
    assert.ok(liability > 0);
    const stressed = liability * 129.62 * 1.1;
    await snapshot(Math.floor(stressed * 1.05), 'Coverage at 105 percent of stressed liability');
    assert.equal((await status()).status, 'PAUSED');
    const q = await quote('customer2', 5);
    assert.equal(await errorOf(initiateDeposit({ rpc: serviceRpc, daraja: fakeDaraja(), config: CONFIG, userId: identities.customer2.id, quoteId: q.quote_id, phone: PHONE, idempotencyKey: 'treasury-pause-1' })), 'treasury_paused');
    await snapshot(Math.floor(stressed * 0.95), 'Coverage at 95 percent of stressed liability');
    assert.equal((await status()).status, 'INCIDENT');
    await snapshot(Math.ceil(stressed * 1.15), 'Coverage at 115 percent of stressed liability');
    assert.equal((await status()).status, 'ALERT');
    await snapshot(10000000, 'Sandbox test float restored');
    assert.equal((await status()).status, 'OK');
});

/** Reserve (KES) at which admitting `usd` more lands exactly `factor` × the stressed projection. */
const reserveFor = async (usd, factor, rate = 129.62) => Number(await scalar(
    `select ceil((funding.liability_usd('SANDBOX') + funding.open_deposit_usd('SANDBOX') + $1) * $2 * 1.1 * $3)`, [usd, rate, factor]));

test('projected coverage: one deposit that would cross the pause threshold is refused while current coverage is healthy', async () => {
    await addCustomer('treasuryA', 11);
    await addCustomer('treasuryB', 12);
    await snapshot(await reserveFor(5, 1.09), 'Projected coverage 109 percent after one more deposit');
    assert.match((await one('ian', `select public.funding_staff_overview('SANDBOX') o`)).o.treasury.status, /^(OK|ALERT)$/, 'current coverage alone would admit it');
    const q = await quote('treasuryA', 5);
    const daraja = fakeDaraja();
    assert.equal(await errorOf(initiateDeposit({ rpc: serviceRpc, daraja, config: CONFIG, userId: identities.treasuryA.id, quoteId: q.quote_id, phone: PHONE, idempotencyKey: 'cross-0001' })), 'treasury_paused');
    assert.equal(daraja.calls.push.length, 0);
});

test('projected coverage: concurrent deposits cannot both use the same headroom', async () => {
    await snapshot(await reserveFor(5, 1.1) + 2, 'Headroom for exactly one more USD 5 deposit');
    const qa = await quote('treasuryA', 5);
    const qb = await quote('treasuryB', 5);
    const other = await T.connect();
    try {
        await other.query('begin');
        await other.query('set local role service_role');
        const first = (await other.query(`select public.funding_svc_begin_payment($1, $2, $3, 'concurrent-a-1', $4, $5) r`,
            [identities.treasuryA.id, qa.quote_id, MSISDN, await sha256Hex('concurrent-token-a-concurrent'), SHORTCODE])).rows[0].r;
        assert.equal(first.state, 'INITIATING');
        // B starts while A's admission is uncommitted and waits on the treasury lock.
        const second = errorOf(serviceRpc('funding_svc_begin_payment', { p_user: identities.treasuryB.id, p_quote: qb.quote_id, p_phone: MSISDN,
            p_idempotency_key: 'concurrent-b-1', p_callback_token_hash: await sha256Hex('concurrent-token-b-concurrent'), p_shortcode: SHORTCODE }));
        await new Promise((resolve) => setTimeout(resolve, 300));
        await other.query('commit');
        assert.match(await second, /treasury_paused/);
        // A proceeds normally and is credited: its credit fits the reserve.
        await serviceRpc('funding_svc_record_initiation', { p_payment: first.payment_id, p_outcome: 'ACCEPTED', p_merchant_request_id: 'MR-A', p_checkout_request_id: 'ws_CO_CONCURRENT_A', p_response_code: '0', p_response_desc: 'ok' });
        const view = await serviceRpc('funding_svc_record_status', { p_payment: first.payment_id, p_checkout_request_id: 'ws_CO_CONCURRENT_A', p_outcome: 'RESULT', p_result_code: '0', p_result_desc: 'ok' });
        assert.equal(view.state, 'CONFIRMED');
    } finally {
        await other.query('rollback').catch(() => {});
        await other.end();
    }
    assert.equal(await testBalance('treasuryA'), 5);
    assert.equal(await testBalance('treasuryB'), 0);
});

let suspensePayment;

test('projected coverage is re-checked at credit: a rate rise after the quote holds the paid money in funded suspense', async () => {
    await snapshot(await reserveFor(5, 1.21), 'Admits one deposit at the quoted rate');
    const daraja = fakeDaraja();
    const d = await startDeposit('treasuryB', 5, daraja);
    assert.equal(d.view.state, 'PENDING');
    await as('ian', `select public.funding_publish_rate(200.00, $1::date, 'https://www.centralbank.go.ke/rates/forex-exchange-rates/', 'Sharp rate rise between quote and credit')`, [nairobiToday()]);
    const receipt = nextReceipt('SUS');
    await handleCallback({ rpc: serviceRpc, daraja, bodyText: callbackBody({ checkout: d.checkout, amount: 649, receipt }), token: d.token });
    const row = await payment(d.id);
    suspensePayment = { id: d.id, receipt };
    assert.equal(row.state, 'MANUAL_REVIEW');
    assert.equal(row.attention_reason, 'funded_suspense_treasury_paused');
    assert.ok(row.provider_confirmed_at);
    assert.equal(row.mpesa_receipt, null);
    assert.equal((await kesReceipt(d.id)).a, '649.000000', 'the customer money is recorded, not lost');
    assert.equal(await testBalance('treasuryB'), 0, 'no unbacked balance');
    assert.match(await errorOf(as('owner', `select public.funding_request_action($1, 'RESOLVE_FAILED', 'Trying to fail a paid payment')`, [d.id])), /payment_funds_received/);
    await as('ian', `select public.funding_publish_rate(129.62, $1::date, 'https://www.centralbank.go.ke/rates/forex-exchange-rates/', 'Restore the current CBK rate')`, [nairobiToday()]);
});

test('stale treasury snapshots refuse admission and hold a paid credit', async () => {
    await snapshot(10000000, 'Sandbox test float restored');
    const daraja = fakeDaraja();
    const d = await startDeposit('treasuryA', 5, daraja);
    const q = await quote('treasuryB', 5);
    await rolledBack(async () => {
        await db.exec('set local session_replication_role = replica');
        await db.query(`update funding.treasury_snapshots set recorded_at = recorded_at - interval '25 hours'`);
        await db.exec('set local session_replication_role = origin');
        await handleCallback({ rpc: serviceRpc, daraja, bodyText: callbackBody({ checkout: d.checkout, amount: 649, receipt: nextReceipt() }), token: d.token });
        const row = await payment(d.id);
        assert.equal(row.state, 'MANUAL_REVIEW');
        assert.equal(row.attention_reason, 'funded_suspense_treasury_unknown');
        assert.equal(row.credit_transaction_id, null);
        // Last in the transaction: the refusal aborts it.
        assert.match(await errorOf(db.query(`select public.funding_svc_begin_payment($1, $2, $3, 'stale-treasury-1', $4, $5)`,
            [identities.treasuryB.id, q.quote_id, MSISDN, await sha256Hex('stale-token-stale-token-stale'), SHORTCODE])), /treasury_unknown/);
    });
    assert.equal((await payment(d.id)).state, 'PENDING', 'rolled back');
    await handleCallback({ rpc: serviceRpc, daraja, bodyText: callbackBody({ checkout: d.checkout, amount: 649, receipt: nextReceipt() }), token: d.token });
    assert.equal((await payment(d.id)).state, 'CONFIRMED');
});

// ------------------------------------------------------------------ R3: manual confirmation needs provider evidence

test('manual confirmation needs a binding provider statement item and three different people', async () => {
    const p = await payment(unboundPayment);
    assert.equal(p.state, 'MANUAL_REVIEW');
    assert.equal(p.kes_due, 973);
    const before = await testBalance('customer');
    assert.match(await errorOf(as('owner', `select public.funding_request_action($1, 'RESOLVE_CONFIRMED', 'Customer says the money left their phone')`, [p.id])), /statement_evidence_required/);

    const created = new Date(p.created_at);
    const bad = {
        kes_amount: await recordItem('ian', { kes: 972, accountReference: p.account_reference, msisdn: MSISDN }),
        shortcode: await recordItem('ian', { kes: 973, shortcode: '600000', accountReference: p.account_reference }),
        account_reference: await recordItem('ian', { kes: 973, accountReference: 'SPWRONG0001' }),
        phone: await recordItem('ian', { kes: 973, msisdn: '254799999999' }),
        transaction_time: await recordItem('ian', { kes: 973, accountReference: p.account_reference, at: new Date(created.getTime() - 3600 * 1000) }),
    };
    for (const [reason, item] of Object.entries(bad)) {
        assert.match(await errorOf(as('owner', `select public.funding_request_action($1, 'RESOLVE_CONFIRMED', 'Statement line checked by owner', $2)`, [p.id, item])),
            new RegExp(`statement_evidence_invalid: ${reason}`), reason);
    }

    // The ambiguous race payment is resolved first with a phone-only line.
    const phoneOnly = await recordItem('ian', { kes: 973, msisdn: MSISDN });
    const race = (await one('owner', `select public.funding_request_action($1, 'RESOLVE_CONFIRMED', 'Statement shows the race payment', $2) id`, [racePayment, phoneOnly])).id;
    await as('owner2', `select public.funding_approve_action($1, 'Second owner checked the statement line')`, [race]);
    assert.equal((await payment(racePayment)).state, 'CONFIRMED');
    // A statement line binds to one payment only.
    assert.match(await errorOf(as('owner', `select public.funding_request_action($1, 'RESOLVE_CONFIRMED', 'Reusing a statement line', $2)`, [p.id, phoneOnly])), /statement_evidence_invalid: already_used/);

    const receipt = nextReceipt('SIM');
    const good = await recordItem('ian', { receipt, kes: 973, accountReference: p.account_reference, msisdn: MSISDN });
    assert.match(await errorOf(recordItem('ian', { receipt, kes: 973, accountReference: p.account_reference })), /statement_item_duplicate/);
    assert.match(await errorOf(as('ian', `select public.funding_request_action($1, 'RESOLVE_CONFIRMED', 'I recorded the line myself', $2)`, [p.id, good])), /independent_reviewer_required/);
    const action = (await one('owner', `select public.funding_request_action($1, 'RESOLVE_CONFIRMED', 'Statement line matches amount, reference and phone', $2) id`, [p.id, good])).id;
    assert.match(await errorOf(as('owner', `select public.funding_approve_action($1, 'Approving my own request')`, [action])), /second_approver_required/);
    assert.match(await errorOf(as('ian', `select public.funding_approve_action($1, 'The statement recorder approving')`, [action])), /independent_reviewer_required/);
    await as('owner2', `select public.funding_approve_action($1, 'Independent second owner approves')`, [action]);
    const row = await payment(p.id);
    assert.equal(row.state, 'CONFIRMED');
    assert.equal(row.statement_item_id, String(good));
    assert.equal(row.mpesa_receipt, receipt);
    assert.equal(row.receipt_pending, false);
    assert.equal(await testBalance('customer'), before + 7.5);
    assert.deepEqual(await kesReceipt(p.id), { a: '973.000000', d: (await db.query('select business_date::text d from funding.provider_statement_items where id=$1', [good])).rows[0].d });

    // The funded-suspense payment: the credit still needs coverage (restored earlier in this suite).
    const heldItem = await recordItem('ian', { receipt: suspensePayment.receipt, kes: 649, msisdn: MSISDN });
    const heldAction = (await one('owner', `select public.funding_request_action($1, 'RESOLVE_CONFIRMED', 'Held payment is on the statement', $2) id`, [suspensePayment.id, heldItem])).id;
    await snapshot(0, 'Reserve drained to prove approval rechecks coverage');
    assert.match(await errorOf(as('owner2', `select public.funding_approve_action($1, 'Approve while the treasury is empty')`, [heldAction])), /treasury_paused/);
    assert.equal((await payment(suspensePayment.id)).state, 'MANUAL_REVIEW', 'the refused approval changed nothing');
    await snapshot(10000000, 'Sandbox test float restored');
    await as('owner2', `select public.funding_approve_action($1, 'Approve after the float is restored')`, [heldAction]);
    assert.equal((await payment(suspensePayment.id)).state, 'CONFIRMED');
    assert.equal(await testBalance('treasuryB'), 5);
    assert.equal(await scalar(`select count(*)::int from funding.kes_clearing_entries where payment_id=$1 and kind='RECEIPT'`, [suspensePayment.id]), 1, 'KES booked once');

    // Evidence rules.
    assert.match(await errorOf(recordItem('ian', { kes: 649, msisdn: MSISDN, environment: 'PRODUCTION' })), /validation_failed/, 'production needs a downloaded statement');
    assert.match(await errorOf(recordItem('ian', { kes: 649 })), /validation_failed/, 'a line needs an account reference or phone');
    assert.match(await errorOf(recordItem('administrator', { kes: 649, msisdn: MSISDN })), /forbidden/);
    assert.match(await errorOf(db.query(`update funding.provider_statement_items set kes_amount = 1`)), /funding_record_immutable/);
});

// ------------------------------------------------------------------ R7: a callback receipt is only a claim

test('a leaked token with the right checkout and amount cannot plant a fabricated receipt', async () => {
    const daraja = fakeDaraja();
    const d = await startDeposit('customer2', 5, daraja);
    const before = await testBalance('customer2');
    const fabricated = 'FAKE00RCPT01';
    await handleCallback({ rpc: serviceRpc, daraja, bodyText: callbackBody({ checkout: d.checkout, amount: 649, receipt: fabricated }), token: d.token });
    let row = await payment(d.id);
    assert.equal(row.state, 'CONFIRMED', 'the bound checkout really succeeded, so the non-spendable credit posts');
    assert.equal(await testBalance('customer2'), before + 5);
    assert.equal(row.mpesa_receipt, null, 'the fabricated receipt is not the payment receipt');
    assert.equal(row.receipt_pending, true);
    assert.equal((await one('customer2', 'select public.funding_my_payments() p')).p.find((v) => v.payment_id === d.id).mpesa_receipt, null);
    assert.equal(await scalar(`select count(*)::int from funding.payments where mpesa_receipt=$1`, [fabricated]), 0);

    // Reconciliation stays open while the identity is unverified.
    const run = await serviceRpc('funding_svc_reconcile', { p_environment: 'SANDBOX', p_business_date: nairobiToday() });
    assert.equal(run.status, 'DIFFERENCES');
    assert.ok(run.differences.some((x) => x.kind === 'receipt_unverified' && x.payment_id === d.id));

    // Only a bound statement line, with three different people, makes a receipt authoritative.
    const real = nextReceipt('REAL');
    const line = await recordItem('ian', { receipt: real, kes: 649, accountReference: row.account_reference, msisdn: MSISDN });
    assert.match(await errorOf(as('owner', `select public.funding_request_action($1, 'BIND_RECEIPT', 'Bind without evidence')`, [d.id])), /statement_evidence_required/);
    assert.match(await errorOf(as('ian', `select public.funding_request_action($1, 'BIND_RECEIPT', 'I recorded the line myself', $2)`, [d.id, line])), /independent_reviewer_required/);
    const wrong = await recordItem('ian', { kes: 650, accountReference: row.account_reference });
    assert.match(await errorOf(as('owner', `select public.funding_request_action($1, 'BIND_RECEIPT', 'Line with the wrong amount', $2)`, [d.id, wrong])), /statement_evidence_invalid: kes_amount/);
    const bind = (await one('owner', `select public.funding_request_action($1, 'BIND_RECEIPT', 'Statement line matches the payment', $2) id`, [d.id, line])).id;
    assert.match(await errorOf(as('ian', `select public.funding_approve_action($1, 'The statement recorder approving')`, [bind])), /independent_reviewer_required/);
    await as('owner2', `select public.funding_approve_action($1, 'Independent owner binds the statement receipt')`, [bind]);
    row = await payment(d.id);
    assert.equal(row.mpesa_receipt, real);
    assert.equal(row.receipt_pending, false);
    assert.equal(row.statement_item_id, String(line));
    assert.equal(await testBalance('customer2'), before + 5, 'binding the identity moves no money');
    assert.match(await errorOf(as('owner', `select public.funding_request_action($1, 'BIND_RECEIPT', 'Binding a second line', $2)`,
        [d.id, await recordItem('ian', { kes: 649, msisdn: MSISDN })])), /payment_state_invalid/);
    const after = await serviceRpc('funding_svc_reconcile', { p_environment: 'SANDBOX', p_business_date: nairobiToday() });
    assert.equal(after.differences.some((x) => x.kind === 'receipt_unverified' && x.payment_id === d.id), false);
});

// ------------------------------------------------------------------ R4 and staff

test('reversal needs two owners; reconciliation rolls the KES statement forward and keeps differences open', async () => {
    const confirmed = (await db.query(`select id, usd_amount from funding.payments where user_id=$1 and state='CONFIRMED' order by created_at limit 1`, [identities.customer.id])).rows[0];
    const before = await testBalance('customer');
    const request = (await one('ian', `select public.funding_request_action($1, 'REVERSE', 'Customer dispute in sandbox drill') id`, [confirmed.id])).id;
    assert.match(await errorOf(as('ian', `select public.funding_approve_action($1, 'Approving my own request')`, [request])), /second_approver_required/);
    assert.match(await errorOf(as('administrator', `select public.funding_approve_action($1, 'Administrator cannot approve')`, [request])), /forbidden/);
    await as('owner', `select public.funding_approve_action($1, 'Second owner approves the reversal')`, [request]);
    assert.equal((await payment(confirmed.id)).state, 'REVERSED');
    assert.equal(await testBalance('customer'), before - Number(confirmed.usd_amount));

    const review = (await db.query(`select id from funding.payments where state='MANUAL_REVIEW' and provider_confirmed_at is null order by created_at limit 1`)).rows[0].id;
    const resolve = (await one('owner', `select public.funding_request_action($1, 'RESOLVE_FAILED', 'Statement shows no receipt for this payment') id`, [review])).id;
    await as('ian', `select public.funding_approve_action($1, 'Checked against the sandbox statement')`, [resolve]);
    assert.equal((await payment(review)).state, 'FAILED');

    const day = nairobiToday();
    const kinds = (run) => [...new Set(run.differences.map((d) => d.kind))].sort();
    let run = await serviceRpc('funding_svc_reconcile', { p_environment: 'SANDBOX', p_business_date: day });
    assert.ok(kinds(run).includes('statement_missing'), 'no statement is a difference, not a match');
    assert.equal(run.status, 'DIFFERENCES');

    const gross = Number(await scalar(`select coalesce(sum(kes_amount),0) from funding.kes_clearing_entries where kind='RECEIPT' and business_date=$1`, [day]));
    const reversals = -Number(await scalar(`select coalesce(sum(kes_amount),0) from funding.kes_clearing_entries where kind='REVERSAL' and business_date=$1`, [day]));
    assert.ok(gross > 0 && reversals > 0);
    const opening = 50000;
    const fees = 25;
    const settlement = 1000;
    const closing = opening + gross - reversals - fees - settlement;
    const statement = async (businessDate, values, staff = 'owner') => as(staff, `select public.funding_record_statement_total('SANDBOX', $1::date, $2, $3, $4, $5, $6, $7, 'SANDBOX_SIMULATED', 'sandbox simulated statement', $8, 'Sandbox statement summary for the day')`,
        [businessDate, values.opening, values.gross, values.reversals, values.fees, values.settlement, values.closing, await sha256Hex(`statement ${businessDate} ${values.closing}`)]);
    await statement(nairobiDay(-1), { opening: 49000, gross: 1000, reversals: 0, fees: 0, settlement: 0, closing: opening });
    await statement(day, { opening, gross, reversals, fees, settlement, closing });

    run = await serviceRpc('funding_svc_reconcile', { p_environment: 'SANDBOX', p_business_date: day });
    assert.deepEqual(kinds(run).filter((k) => !['needs_attention', 'statement_item_unmatched', 'receipt_unverified'].includes(k)), [], JSON.stringify(run.differences));
    const unmatched = run.differences.filter((d) => d.kind === 'statement_item_unmatched').map((d) => d.receipt);
    assert.ok(unmatched.length >= 4, 'the rejected evidence lines stay open as statement lines without a payment');
    assert.equal(Number(run.summary.customer_balance_usd), Number(run.summary.confirmed_usd));
    assert.equal(run.summary.statement.simulated, true);
    assert.equal(run.summary.statement.evidence_kind, 'SANDBOX_SIMULATED');
    assert.equal(Number(run.summary.statement.fees), fees);
    assert.equal(Number(run.summary.statement.net_settlement), settlement);
    assert.ok(Number(run.summary.kes.funded_suspense) > 0, 'the limits-held payment is still owed');

    // A statement that does not roll forward, or opens away from yesterday's close, is a difference.
    await statement(day, { opening: opening + 1, gross, reversals, fees, settlement, closing });
    run = await serviceRpc('funding_svc_reconcile', { p_environment: 'SANDBOX', p_business_date: day });
    assert.ok(kinds(run).includes('statement_rollforward_mismatch'));
    assert.ok(kinds(run).includes('statement_opening_mismatch'));
    await statement(day, { opening, gross: gross + 649, reversals, fees, settlement, closing: closing + 649 });
    run = await serviceRpc('funding_svc_reconcile', { p_environment: 'SANDBOX', p_business_date: day });
    assert.ok(kinds(run).includes('statement_gross_mismatch'));
    assert.equal(run.summary.statement.simulated, true);

    // Differences stay open until someone who recorded none of the day's evidence resolves them.
    assert.match(await errorOf(as('owner', `select public.funding_resolve_reconciliation($1, 'Recorder resolving own statement')`, [run.run_id])), /second_approver_required/);
    assert.match(await errorOf(as('ian', `select public.funding_resolve_reconciliation($1, 'Item recorder resolving the day')`, [run.run_id])), /second_approver_required/);
    await as('owner2', `select public.funding_resolve_reconciliation($1, 'Independent owner explains the sandbox differences')`, [run.run_id]);
    assert.match(await errorOf(as('owner', `select public.funding_record_statement_total('PRODUCTION', $1::date, 0, 0, 0, 0, 0, 0, 'SANDBOX_SIMULATED', 'x-ref', $2, 'Simulated figures for production')`,
        [day, await sha256Hex('x')])), /validation_failed/);
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
        assert.match(await errorOf(db.query(`select * from funding.provider_statement_items`)), /permission denied/);
    } finally { await db.exec('reset role'); }
    assert.match(await errorOf(db.query(`update funding.usd_ledger_entries set amount = amount * 2`)), /funding_record_immutable/);
    assert.match(await errorOf(db.query(`delete from funding.payments`)), /funding_record_immutable/);
    assert.match(await errorOf(db.query(`update funding.fx_rate_versions set kes_per_usd = 1`)), /funding_record_immutable/);
    assert.match(await errorOf(db.query(`update funding.deposit_policy_versions set max_usd_per_deposit = 1000000`)), /funding_record_immutable/);
    assert.match(await errorOf(db.query(`update funding.statement_totals set kes_fees = 0`)), /funding_record_immutable/);
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
