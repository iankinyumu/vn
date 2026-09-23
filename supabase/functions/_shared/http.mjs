/* JSON response envelope for the trading edge functions.
 *
 * Every response, success or failure, carries the CORS headers, and every failure
 * carries the same shape:
 *
 *   { "error": { "code": "<stable code>", "message": "<customer-safe text>" },
 *     "request_id": "8F3A21C0" }
 *
 * The customer-facing message comes from the code catalogue, never from a caught
 * exception, so an internal message cannot leak storage keys, SQL or stack traces.
 * The same request id is logged server-side next to the real detail, which is what
 * makes a customer-quoted reference actionable by support.
 */

import { corsHeaders } from './cors.mjs';
import { errorMessage, errorStatus, isErrorCode } from './errors.mjs';

// A request id is the first 32 random bits of a v4 UUID as eight uppercase hex characters.
export function createRequestId(randomUUID = () => crypto.randomUUID()) {
    return randomUUID().slice(0, 8).toUpperCase();
}

export function jsonResponse(body, { status = 200, requestOrigin = null, allowedOrigins = null, headers = {} } = {}) {
    return Response.json(body, {
        status,
        headers: { ...corsHeaders(requestOrigin, allowedOrigins), ...headers }
    });
}

/**
 * Logs the real reason (with the request id) and returns the customer a stable
 * code plus a safe sentence. `detail` is never serialised into the response.
 */
export function errorResponse({
    requestId,
    code = 'internal',
    detail = null,
    requestOrigin = null,
    allowedOrigins = null,
    headers = {},
    logger = console
}) {
    const resolvedCode = isErrorCode(code) ? code : 'internal';
    if (detail !== null && detail !== undefined) {
        const reason = detail instanceof Error ? `${detail.name}: ${detail.message}` : String(detail);
        logger.error(`[${requestId}] ${resolvedCode} - ${reason}`);
        if (detail instanceof Error && detail.stack) logger.error(`[${requestId}] stack - ${detail.stack}`);
    }
    return jsonResponse(
        { error: { code: resolvedCode, message: errorMessage(resolvedCode) }, request_id: requestId },
        { status: errorStatus(resolvedCode), requestOrigin, allowedOrigins, headers }
    );
}
