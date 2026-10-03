/* Funding flow orchestration for the Edge Functions (docs/REAL_FUNDING_DESIGN.md).
 *
 * Each function relays provider facts into one funding_svc_* RPC and lets the
 * database state machine decide. `rpc(name, args)` resolves to the RPC result or
 * throws an Error whose message starts with the database exception code; the
 * Edge Function wraps supabase-js, the tests wrap a real PostgreSQL client.
 */

import { CALLBACK_ACK, callbackUrl, normalizeMsisdn, parseStkCallback } from './daraja.mjs';

export class FundingError extends Error {
    constructor(code, detail = null) { super(code); this.name = 'FundingError'; this.code = code; this.detail = detail; }
}

export const FUNDING_ERROR_CODES = Object.freeze([
    'phone_invalid', 'quote_not_found', 'quote_expired', 'quote_used', 'payment_in_progress', 'sandbox_not_enabled',
    'production_payments_disabled', 'treasury_paused', 'treasury_unknown', 'idempotency_key_reused', 'validation_failed',
    'amount_invalid', 'amount_below_minimum', 'amount_above_maximum', 'rate_stale', 'rate_unavailable',
    'deposit_limit_reached', 'deposit_policy_unavailable', 'phone_not_allowed',
]);

/** Maps a database exception to a stable funding code, or null for an internal fault. */
export function fundingCodeOf(error) {
    const message = String(error?.message ?? '');
    return FUNDING_ERROR_CODES.find((code) => message === code || message.startsWith(`${code}:`) || message.includes(`${code}`)) ?? null;
}

export async function sha256Hex(text) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 244 random bits (two v4 UUIDs) as 64 hex characters. Only its sha256 is stored. */
export function randomToken() {
    return `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, '');
}

/**
 * Starts an STK Push for a quote the user owns. A repeated idempotency key
 * returns the existing payment and never pushes again.
 */
export async function initiateDeposit({ rpc, daraja, config, userId, quoteId, phone, idempotencyKey, token = randomToken() }) {
    const msisdn = normalizeMsisdn(phone);
    if (!msisdn) throw new FundingError('phone_invalid');
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8 || idempotencyKey.length > 100) throw new FundingError('validation_failed');
    let begun;
    try {
        begun = await rpc('funding_svc_begin_payment', {
            p_user: userId, p_quote: quoteId, p_phone: msisdn, p_idempotency_key: idempotencyKey, p_callback_token_hash: await sha256Hex(token),
            p_shortcode: config.shortcode,
        });
    } catch (error) {
        const code = fundingCodeOf(error);
        if (code) throw new FundingError(code);
        throw error;
    }
    if (begun.existing) return publicView(begun);
    if (begun.environment !== config.environment) throw new FundingError('production_payments_disabled');

    const result = await daraja.stkPush({
        amount: Number(begun.kes_due), phone: msisdn, accountReference: begun.account_reference,
        description: 'Deposit', callbackUrl: callbackUrl(config, token),
    });
    const recorded = await rpc('funding_svc_record_initiation', {
        p_payment: begun.payment_id, p_outcome: result.outcome, p_merchant_request_id: result.merchantRequestId ?? null,
        p_checkout_request_id: result.checkoutRequestId ?? null, p_response_code: result.responseCode ?? null,
        p_response_desc: result.responseDescription ?? null,
    });
    return publicView(recorded);
}

function publicView(view) {
    return { payment_id: view.payment_id, environment: view.environment, state: view.state, status_message: view.status_message,
        usd_amount: view.usd_amount, kes_due: view.kes_due };
}

/** Asks Daraja for the real status and records it. The only automatic credit path. */
export async function verifyPayment({ rpc, daraja, paymentId, checkoutRequestId }) {
    const status = await daraja.stkQuery(checkoutRequestId);
    return rpc('funding_svc_record_status', {
        p_payment: paymentId, p_checkout_request_id: checkoutRequestId, p_outcome: status.outcome,
        p_result_code: status.resultCode, p_result_desc: status.resultDesc,
    });
}

/**
 * Handles a Daraja callback. Returns { status, body }: 200 with the documented
 * acknowledgement for anything that was handled or ignored, 500 only when the
 * database could not record a well-formed, token-bound callback (so Daraja may
 * retry). Verification runs after the record; `defer` lets the Edge Function
 * finish it after responding.
 */
export async function handleCallback({ rpc, daraja, bodyText, token, defer = (work) => work, logger = console }) {
    const ack = { status: 200, body: CALLBACK_ACK };
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) return ack;
    const parsed = parseStkCallback(bodyText);
    let recorded;
    try {
        recorded = await rpc('funding_svc_record_callback', {
            p_token_hash: await sha256Hex(token),
            p_checkout_request_id: parsed.ok ? parsed.checkoutRequestId : null,
            p_merchant_request_id: parsed.ok ? parsed.merchantRequestId : null,
            p_result_code: parsed.ok ? parsed.resultCode : null,
            p_result_desc: parsed.ok ? parsed.resultDesc : null,
            p_amount: parsed.ok ? parsed.amount : null,
            p_receipt: parsed.ok ? parsed.receipt : null,
            p_phone: parsed.ok ? parsed.phone : null,
            p_payload_sha256: await sha256Hex(String(bodyText ?? '')),
        });
    } catch (error) {
        logger.error(`daraja-callback record failed: ${error?.message ?? error}`);
        return { status: 500, body: { ResultCode: 1, ResultDesc: 'Retry' } };
    }
    if (recorded?.accepted && recorded.needs_query && recorded.checkout_request_id) {
        await defer(verifyPayment({ rpc, daraja, paymentId: recorded.payment_id, checkoutRequestId: recorded.checkout_request_id })
            .catch((error) => logger.error(`daraja-callback verification deferred to reconcile: ${error?.message ?? error}`)));
    }
    return ack;
}

/** Scheduled sweep: resolve abandoned initiations, then query every open payment. */
export async function reconcileOpenPayments({ rpc, daraja, minAgeSeconds = 60, limit = 50, logger = console }) {
    const expired = await rpc('funding_svc_expire_stale', {});
    const open = await rpc('funding_svc_open_payments', { p_min_age_seconds: minAgeSeconds, p_limit: limit });
    const results = [];
    for (const payment of open) {
        try {
            const view = await verifyPayment({ rpc, daraja, paymentId: payment.payment_id, checkoutRequestId: payment.checkout_request_id });
            results.push({ payment_id: payment.payment_id, state: view.state });
        } catch (error) {
            logger.error(`funding-reconcile ${payment.payment_id}: ${error?.message ?? error}`);
            results.push({ payment_id: payment.payment_id, error: 'verification_failed' });
        }
    }
    return { expired, checked: results.length, results };
}
