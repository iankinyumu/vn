/* HTTP handlers for the funding Edge Functions (docs/REAL_FUNDING_DESIGN.md §9).
 *
 * Each supabase/functions/<name>/index.ts only wires Deno.env, supabase-js and
 * EdgeRuntime.waitUntil into one of these factories, so the Node suite drives
 * the same request handling (methods, body limits, configuration, JWT, cron
 * secret, CORS, database failures) with fakes. A handler never puts a caught
 * exception, secret or SQL text in a response: errors go through errorResponse.
 */

import { preflightResponse } from './cors.mjs';
import { CALLBACK_ACK, createDarajaClient, DarajaConfigError, loadDarajaConfig } from './daraja.mjs';
import { FundingError, handleCallback, initiateDeposit, reconcileOpenPayments } from './funding-flow.mjs';
import { createRequestId, errorResponse, jsonResponse } from './http.mjs';

export const MAX_DEPOSIT_BODY_BYTES = 4 * 1024;
export const MAX_CALLBACK_BODY_BYTES = 16 * 1024;
export const MAX_RECONCILE_BODY_BYTES = 1024;
export const CALLBACK_RETRY = Object.freeze({ ResultCode: 1, ResultDesc: 'Retry' });

const present = (value) => typeof value === 'string' && value.trim() !== '';

/**
 * Reads at most `limit` bytes of a request body. Content-Length is checked when
 * present, but a chunked body has none, so the stream itself is counted and
 * abandoned past the limit. Returns null when the body is too large.
 */
export async function readBodyText(request, limit) {
    const declared = request.headers.get('Content-Length');
    if (declared !== null && (!/^[0-9]+$/.test(declared.trim()) || Number(declared) > limit)) return null;
    if (!request.body) return '';
    const reader = request.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) {
            await reader.cancel().catch(() => {});
            return null;
        }
        chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder().decode(bytes);
}

/** Constant-time comparison for the cron secret. */
export function sameSecret(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

/** A service-role RPC caller, or null when the service configuration is missing. */
function serviceRpc(createClient, env) {
    if (!present(env.SUPABASE_URL) || !present(env.SUPABASE_SERVICE_ROLE_KEY)) return null;
    const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    return async (name, args) => {
        const { data, error } = await admin.rpc(name, args);
        if (error) throw new Error(error.message);
        return data;
    };
}

function darajaFor(config, fetch) {
    return createDarajaClient(fetch ? { config, fetch } : { config });
}

function configFailure(error) {
    return `daraja config: ${error instanceof DarajaConfigError ? error.code : 'config_error'}`;
}

/** POST {quote_id, phone, idempotency_key} with the customer's Supabase JWT. */
export function createDepositHandler({ getEnv, createClient, fetch = null, logger = console }) {
    return async function handleDeposit(request) {
        const env = getEnv() ?? {};
        const requestId = createRequestId();
        const allowedOrigins = env.ALLOWED_ORIGINS ?? null;
        const respond = { requestId, requestOrigin: request.headers.get('Origin'), allowedOrigins, logger };

        if (request.method === 'OPTIONS') return preflightResponse(request, allowedOrigins);
        if (request.method !== 'POST') return errorResponse({ ...respond, code: 'method_not_allowed', detail: `method ${request.method}` });
        const authorization = request.headers.get('Authorization') ?? '';
        if (!/^Bearer [^\s]+$/.test(authorization)) return errorResponse({ ...respond, code: 'unauthorized', detail: 'missing bearer token' });

        let config;
        try {
            config = loadDarajaConfig(env);
        } catch (error) {
            return errorResponse({ ...respond, code: 'payments_unavailable', detail: configFailure(error) });
        }
        const rpc = serviceRpc(createClient, env);
        if (!rpc || !present(env.SUPABASE_ANON_KEY)) return errorResponse({ ...respond, code: 'payments_unavailable', detail: 'supabase configuration missing' });

        try {
            const caller = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
                global: { headers: { Authorization: authorization } }, auth: { persistSession: false, autoRefreshToken: false },
            });
            const { data, error: authError } = await caller.auth.getUser();
            const user = data?.user;
            if (authError || !user?.id) return errorResponse({ ...respond, code: 'unauthorized', detail: authError ?? 'no user' });

            const text = await readBodyText(request, MAX_DEPOSIT_BODY_BYTES);
            if (text === null) return errorResponse({ ...respond, code: 'payload_too_large', detail: 'deposit body over limit' });
            let body;
            try {
                body = JSON.parse(text);
            } catch {
                return errorResponse({ ...respond, code: 'validation_failed', detail: 'body is not JSON' });
            }
            const { quote_id: quoteId, phone, idempotency_key: idempotencyKey } = body ?? {};
            if (typeof quoteId !== 'string' || typeof phone !== 'string' || typeof idempotencyKey !== 'string') {
                return errorResponse({ ...respond, code: 'validation_failed', detail: 'quote_id, phone and idempotency_key are required' });
            }
            const view = await initiateDeposit({ rpc, daraja: darajaFor(config, fetch), config, userId: user.id, quoteId, phone, idempotencyKey });
            return jsonResponse(view, respond);
        } catch (error) {
            if (error instanceof FundingError) return errorResponse({ ...respond, code: error.code, detail: error.code });
            return errorResponse({ ...respond, code: 'internal', detail: error });
        }
    };
}

// Without a valid provider config the callback is still recorded; the status
// query waits for the funding-reconcile sweep.
const unavailableDaraja = Object.freeze({
    environment: 'SANDBOX',
    stkPush: () => { throw new Error('daraja_unavailable'); },
    stkQuery: async () => ({ outcome: 'ERROR', resultCode: null, resultDesc: 'daraja_config_unavailable' }),
});

/**
 * Public Daraja callback, POST only. An oversized body is acknowledged and
 * ignored. 500 (so Daraja retries) only when the record itself cannot be made.
 * Nothing from the body or the token is logged.
 */
export function createCallbackHandler({ getEnv, createClient, fetch = null, defer = (work) => work, logger = console }) {
    return async function handleDarajaCallback(request) {
        if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST', 'Cache-Control': 'no-store' } });
        const token = new URL(request.url).searchParams.get('t');
        const bodyText = await readBodyText(request, MAX_CALLBACK_BODY_BYTES);
        if (bodyText === null) return Response.json(CALLBACK_ACK);
        const env = getEnv() ?? {};
        const rpc = serviceRpc(createClient, env);
        if (!rpc) {
            logger.error('daraja-callback: supabase configuration missing');
            return Response.json(CALLBACK_RETRY, { status: 500 });
        }
        let daraja;
        try {
            daraja = darajaFor(loadDarajaConfig(env), fetch);
        } catch {
            daraja = unavailableDaraja;
        }
        try {
            const result = await handleCallback({ rpc, daraja, bodyText, token, defer, logger });
            return Response.json(result.body, { status: result.status });
        } catch (error) {
            logger.error(`daraja-callback failed: ${error?.name ?? 'Error'}`);
            return Response.json(CALLBACK_RETRY, { status: 500 });
        }
    };
}

/**
 * Scheduler endpoint, POST only, authenticated by X-Funding-Cron-Secret.
 * {"action":"sweep"} (default) or {"action":"daily","business_date":"YYYY-MM-DD"}
 * (default: yesterday, Nairobi time).
 */
export function createReconcileHandler({ getEnv, createClient, fetch = null, logger = console, now = () => Date.now() }) {
    return async function handleReconcile(request) {
        const requestId = createRequestId();
        const respond = { requestId, logger };
        if (request.method !== 'POST') return errorResponse({ ...respond, code: 'method_not_allowed', detail: `method ${request.method}` });
        const env = getEnv() ?? {};
        const secret = env.FUNDING_CRON_SECRET ?? '';
        if (secret.length < 32 || !sameSecret(request.headers.get('X-Funding-Cron-Secret') ?? '', secret)) {
            return errorResponse({ ...respond, code: 'unauthorized', detail: 'funding cron secret missing or mismatched' });
        }
        let config;
        try {
            config = loadDarajaConfig(env);
        } catch (error) {
            return errorResponse({ ...respond, code: 'payments_unavailable', detail: configFailure(error) });
        }
        const rpc = serviceRpc(createClient, env);
        if (!rpc) return errorResponse({ ...respond, code: 'payments_unavailable', detail: 'supabase configuration missing' });

        const text = await readBodyText(request, MAX_RECONCILE_BODY_BYTES);
        if (text === null) return errorResponse({ ...respond, code: 'payload_too_large', detail: 'reconcile body over limit' });
        let body = {};
        if (text.trim() !== '') {
            try {
                body = JSON.parse(text) ?? {};
            } catch {
                return errorResponse({ ...respond, code: 'validation_failed', detail: 'body is not JSON' });
            }
        }
        const action = body.action ?? 'sweep';
        if (action !== 'sweep' && action !== 'daily') return errorResponse({ ...respond, code: 'validation_failed', detail: 'unknown action' });
        if (body.business_date !== undefined && (typeof body.business_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.business_date))) {
            return errorResponse({ ...respond, code: 'validation_failed', detail: 'business_date must be YYYY-MM-DD' });
        }

        try {
            if (action === 'daily') {
                const yesterday = new Date(now() + 3 * 3600 * 1000 - 86400 * 1000).toISOString().slice(0, 10);
                const run = await rpc('funding_svc_reconcile', { p_environment: config.environment, p_business_date: body.business_date ?? yesterday });
                return jsonResponse({ run_id: run.run_id, status: run.status, differences: run.differences.length }, respond);
            }
            const sweep = await reconcileOpenPayments({ rpc, daraja: darajaFor(config, fetch), logger });
            return jsonResponse(sweep, respond);
        } catch (error) {
            return errorResponse({ ...respond, code: 'internal', detail: error });
        }
    };
}
