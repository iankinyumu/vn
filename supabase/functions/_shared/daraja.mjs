/* Daraja (M-Pesa Express / STK Push) adapter for the funding Edge Functions.
 *
 * A plain .mjs module: the Node test suite imports it with a mock fetch, and the
 * Deno runtime loads the same file. It knows the provider's wire format and how
 * to classify each answer; it decides nothing about money. The database state
 * machine (supabase/migrations/20260926110000_funding_rpc.sql) does that.
 *
 * Contract: docs/REAL_FUNDING_DESIGN.md §1. Secrets are read by name from the
 * environment object handed in and are never logged, returned or thrown.
 */

export const SANDBOX_BASE_URL = 'https://sandbox.safaricom.co.ke';
export const PRODUCTION_BASE_URL = 'https://api.safaricom.co.ke';
export const PRODUCTION_RELEASED = false;

const SANDBOX_REQUIRED = ['DARAJA_SANDBOX_CONSUMER_KEY', 'DARAJA_SANDBOX_CONSUMER_SECRET', 'DARAJA_SANDBOX_SHORTCODE', 'DARAJA_SANDBOX_PASSKEY', 'DARAJA_CALLBACK_BASE_URL'];
const PRODUCTION_REQUIRED = ['DARAJA_PRODUCTION_CONSUMER_KEY', 'DARAJA_PRODUCTION_CONSUMER_SECRET', 'DARAJA_PRODUCTION_SHORTCODE', 'DARAJA_PRODUCTION_PASSKEY', 'DARAJA_CALLBACK_BASE_URL'];
const TRANSACTION_TYPES = ['CustomerPayBillOnline', 'CustomerBuyGoodsOnline'];
const CALLBACK_BASE = /^https:\/\/[a-z0-9]{20}\.supabase\.co\/functions\/v1$/;
const PROCESSING_ERROR_CODE = '500.001.1001';
const MAX_CALLBACK_BYTES = 16 * 1024;

export class DarajaConfigError extends Error {
    constructor(code) { super(code); this.name = 'DarajaConfigError'; this.code = code; }
}

const present = (value) => typeof value === 'string' && value.trim() !== '';

/**
 * Validates the environment and returns a frozen config. Sandbox refuses any
 * production credential or host; production refuses any sandbox credential or
 * host and, in this release, is refused outright.
 */
export function loadDarajaConfig(env) {
    const names = Object.keys(env || {});
    const mode = String(env?.DARAJA_ENV ?? '').trim();
    if (mode === 'sandbox') {
        if (names.some((name) => name.startsWith('DARAJA_PRODUCTION_') && present(env[name]))) throw new DarajaConfigError('sandbox_refuses_production_credentials');
        const baseUrl = present(env.DARAJA_SANDBOX_BASE_URL) ? env.DARAJA_SANDBOX_BASE_URL.trim().replace(/\/+$/, '') : SANDBOX_BASE_URL;
        if (baseUrl !== SANDBOX_BASE_URL) throw new DarajaConfigError('sandbox_refuses_non_sandbox_endpoint');
        return freezeConfig('SANDBOX', baseUrl, env, 'DARAJA_SANDBOX_', SANDBOX_REQUIRED);
    }
    if (mode === 'production') {
        if (names.some((name) => name.startsWith('DARAJA_SANDBOX_') && present(env[name]))) throw new DarajaConfigError('production_refuses_sandbox_credentials');
        const baseUrl = present(env.DARAJA_PRODUCTION_BASE_URL) ? env.DARAJA_PRODUCTION_BASE_URL.trim().replace(/\/+$/, '') : PRODUCTION_BASE_URL;
        if (baseUrl !== PRODUCTION_BASE_URL) throw new DarajaConfigError('production_refuses_non_production_endpoint');
        freezeConfig('PRODUCTION', baseUrl, env, 'DARAJA_PRODUCTION_', PRODUCTION_REQUIRED);
        if (!PRODUCTION_RELEASED) throw new DarajaConfigError('production_not_released');
    }
    throw new DarajaConfigError('daraja_env_invalid');
}

function freezeConfig(environment, baseUrl, env, prefix, required) {
    for (const name of required) if (!present(env[name])) throw new DarajaConfigError(`missing:${name}`);
    const shortcode = env[`${prefix}SHORTCODE`].trim();
    if (!/^[0-9]{5,8}$/.test(shortcode)) throw new DarajaConfigError(`invalid:${prefix}SHORTCODE`);
    const transactionType = present(env[`${prefix}TRANSACTION_TYPE`]) ? env[`${prefix}TRANSACTION_TYPE`].trim() : 'CustomerPayBillOnline';
    if (!TRANSACTION_TYPES.includes(transactionType)) throw new DarajaConfigError(`invalid:${prefix}TRANSACTION_TYPE`);
    const callbackBase = env.DARAJA_CALLBACK_BASE_URL.trim().replace(/\/+$/, '');
    if (!CALLBACK_BASE.test(callbackBase)) throw new DarajaConfigError('invalid:DARAJA_CALLBACK_BASE_URL');
    const partyB = present(env[`${prefix}PARTY_B`]) ? env[`${prefix}PARTY_B`].trim() : shortcode;
    if (!/^[0-9]{5,8}$/.test(partyB)) throw new DarajaConfigError(`invalid:${prefix}PARTY_B`);
    return Object.freeze({
        environment, baseUrl, shortcode, partyB, transactionType, callbackBase,
        consumerKey: env[`${prefix}CONSUMER_KEY`].trim(),
        consumerSecret: env[`${prefix}CONSUMER_SECRET`].trim(),
        passkey: env[`${prefix}PASSKEY`].trim(),
    });
}

/** Names-only readiness report for evidence: present / absent / invalid, never values. */
export function describeDarajaConfig(env) {
    const names = [...new Set(['DARAJA_ENV', ...SANDBOX_REQUIRED, 'DARAJA_SANDBOX_TRANSACTION_TYPE', ...PRODUCTION_REQUIRED])];
    const status = Object.fromEntries(names.map((name) => [name, present(env?.[name]) ? 'present' : 'absent']));
    let verdict = 'ready';
    try { loadDarajaConfig(env); } catch (error) { verdict = error instanceof DarajaConfigError ? error.code : 'invalid'; }
    return { variables: status, verdict };
}

/** Daraja timestamps are Nairobi local time (UTC+3, no DST), YYYYMMDDHHmmss. */
export function darajaTimestamp(date = new Date()) {
    const t = new Date(date.getTime() + 3 * 3600 * 1000);
    const p = (n) => String(n).padStart(2, '0');
    return `${t.getUTCFullYear()}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}${p(t.getUTCHours())}${p(t.getUTCMinutes())}${p(t.getUTCSeconds())}`;
}

export function stkPassword(shortcode, passkey, timestamp) {
    return btoa(`${shortcode}${passkey}${timestamp}`);
}

/** Accepts 07XXXXXXXX, 01XXXXXXXX, 7XXXXXXXX, +2547XXXXXXXX and 2547XXXXXXXX. */
export function normalizeMsisdn(input) {
    const digits = String(input ?? '').replace(/[\s()+-]/g, '');
    if (!/^[0-9]+$/.test(digits)) return null;
    let msisdn = digits;
    if (/^0[17][0-9]{8}$/.test(digits)) msisdn = `254${digits.slice(1)}`;
    else if (/^[17][0-9]{8}$/.test(digits)) msisdn = `254${digits}`;
    return /^254[17][0-9]{8}$/.test(msisdn) ? msisdn : null;
}

export function maskMsisdn(msisdn) {
    return /^[0-9]{12}$/.test(String(msisdn)) ? `${msisdn.slice(0, 4)}*****${msisdn.slice(-3)}` : null;
}

export function callbackUrl(config, token) {
    return `${config.callbackBase}/daraja-callback?t=${encodeURIComponent(token)}`;
}

async function readJson(response) {
    const text = await response.text();
    try { return JSON.parse(text); } catch { return null; }
}

/**
 * Provider client. `fetch` and `now` are injected so tests can drive every
 * outcome. Every call has a timeout; a timeout on a money-moving call is an
 * AMBIGUOUS outcome, never a failure.
 */
export function createDarajaClient({ config, fetch: fetcher = globalThis.fetch, now = () => new Date(), timeoutMs = 15000 }) {
    let token = null;
    let tokenExpiresAt = 0;

    async function call(path, init) {
        return fetcher(`${config.baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    }

    async function accessToken() {
        if (token && now().getTime() < tokenExpiresAt) return token;
        const response = await call('/oauth/v1/generate?grant_type=client_credentials', {
            method: 'GET', headers: { Authorization: `Basic ${btoa(`${config.consumerKey}:${config.consumerSecret}`)}` },
        });
        const body = await readJson(response);
        if (!response.ok || !body || typeof body.access_token !== 'string') throw new Error(`oauth_failed:${response.status}`);
        const ttl = Math.max(60, Number(body.expires_in) || 3599);
        token = body.access_token;
        tokenExpiresAt = now().getTime() + (ttl - 60) * 1000;
        return token;
    }

    async function authorizedPost(path, payload) {
        const bearer = await accessToken();
        return call(path, { method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    }

    /** Returns { outcome: ACCEPTED | REJECTED | AMBIGUOUS, ... }. Never throws. */
    async function stkPush({ amount, phone, accountReference, description, callbackUrl: url }) {
        if (!Number.isInteger(amount) || amount <= 0) throw new Error('stk_amount_invalid');
        if (!/^254[17][0-9]{8}$/.test(phone)) throw new Error('stk_phone_invalid');
        try {
            await accessToken();
        } catch (error) {
            // Nothing was sent to the customer's phone: a safe, final rejection.
            return { outcome: 'REJECTED', responseCode: 'oauth_failed', responseDescription: String(error.message).slice(0, 100) };
        }
        const timestamp = darajaTimestamp(now());
        const payload = {
            BusinessShortCode: config.shortcode,
            Password: stkPassword(config.shortcode, config.passkey, timestamp),
            Timestamp: timestamp,
            TransactionType: config.transactionType,
            Amount: amount,
            PartyA: phone,
            PartyB: config.partyB,
            PhoneNumber: phone,
            CallBackURL: url,
            AccountReference: String(accountReference).slice(0, 12),
            TransactionDesc: String(description || 'Deposit').slice(0, 13),
        };
        let response;
        try {
            response = await authorizedPost('/mpesa/stkpush/v1/processrequest', payload);
        } catch (error) {
            return { outcome: 'AMBIGUOUS', responseCode: 'network', responseDescription: String(error?.name || 'error').slice(0, 100) };
        }
        const body = await readJson(response);
        if (response.status >= 500 || (response.ok && !body)) {
            return { outcome: 'AMBIGUOUS', responseCode: String(body?.errorCode ?? response.status), responseDescription: String(body?.errorMessage ?? 'provider_error').slice(0, 200) };
        }
        if (response.ok && String(body.ResponseCode) === '0' && typeof body.CheckoutRequestID === 'string' && body.CheckoutRequestID) {
            return { outcome: 'ACCEPTED', merchantRequestId: String(body.MerchantRequestID ?? ''), checkoutRequestId: body.CheckoutRequestID,
                responseCode: '0', responseDescription: String(body.ResponseDescription ?? '').slice(0, 200) };
        }
        return { outcome: 'REJECTED', responseCode: String(body?.ResponseCode ?? body?.errorCode ?? response.status),
            responseDescription: String(body?.ResponseDescription ?? body?.errorMessage ?? 'rejected').slice(0, 200) };
    }

    /** Returns { outcome: RESULT | PROCESSING | ERROR, resultCode, resultDesc }. Never throws. */
    async function stkQuery(checkoutRequestId) {
        const timestamp = darajaTimestamp(now());
        let response;
        try {
            response = await authorizedPost('/mpesa/stkpushquery/v1/query', {
                BusinessShortCode: config.shortcode, Password: stkPassword(config.shortcode, config.passkey, timestamp),
                Timestamp: timestamp, CheckoutRequestID: checkoutRequestId,
            });
        } catch (error) {
            return { outcome: 'ERROR', resultCode: null, resultDesc: String(error?.message || 'network').slice(0, 100) };
        }
        const body = await readJson(response);
        if (body && String(body.errorCode ?? '') === PROCESSING_ERROR_CODE) return { outcome: 'PROCESSING', resultCode: null, resultDesc: String(body.errorMessage ?? '').slice(0, 200) };
        if (response.ok && body && String(body.ResponseCode) === '0' && body.ResultCode !== undefined && /^[0-9]+$/.test(String(body.ResultCode))
            && body.CheckoutRequestID === checkoutRequestId) {
            return { outcome: 'RESULT', resultCode: String(Number(body.ResultCode)), resultDesc: String(body.ResultDesc ?? '').slice(0, 200) };
        }
        return { outcome: 'ERROR', resultCode: body?.errorCode ? String(body.errorCode) : null, resultDesc: String(body?.errorMessage ?? `http_${response.status}`).slice(0, 200) };
    }

    return { stkPush, stkQuery, environment: config.environment };
}

/**
 * Parses an STK callback body. Returns { ok: false, reason } for anything that is
 * not the documented shape; the fields are otherwise typed and bounded.
 */
export function parseStkCallback(text) {
    if (typeof text !== 'string' || text.length === 0 || text.length > MAX_CALLBACK_BYTES) return { ok: false, reason: 'size' };
    let body;
    try { body = JSON.parse(text); } catch { return { ok: false, reason: 'json' }; }
    const cb = body?.Body?.stkCallback;
    if (!cb || typeof cb !== 'object') return { ok: false, reason: 'shape' };
    const checkoutRequestId = typeof cb.CheckoutRequestID === 'string' ? cb.CheckoutRequestID.slice(0, 100) : null;
    const resultCode = Number.isInteger(cb.ResultCode) ? cb.ResultCode : (/^[0-9]+$/.test(String(cb.ResultCode)) ? Number(cb.ResultCode) : null);
    if (!checkoutRequestId || resultCode === null) return { ok: false, reason: 'fields' };
    const items = Array.isArray(cb.CallbackMetadata?.Item) ? cb.CallbackMetadata.Item : [];
    const item = (name) => items.find((entry) => entry && entry.Name === name)?.Value;
    const amount = Number(item('Amount'));
    const receipt = item('MpesaReceiptNumber');
    const phone = item('PhoneNumber');
    return {
        ok: true,
        checkoutRequestId,
        merchantRequestId: typeof cb.MerchantRequestID === 'string' ? cb.MerchantRequestID.slice(0, 100) : null,
        resultCode,
        resultDesc: typeof cb.ResultDesc === 'string' ? cb.ResultDesc.slice(0, 200) : null,
        amount: Number.isFinite(amount) && amount > 0 ? amount : null,
        receipt: typeof receipt === 'string' && /^[A-Z0-9]{6,20}$/.test(receipt) ? receipt : null,
        phone: phone !== undefined && /^[0-9]{12}$/.test(String(phone)) ? String(phone) : null,
    };
}

export const CALLBACK_ACK = Object.freeze({ ResultCode: 0, ResultDesc: 'Accepted' });
