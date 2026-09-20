/* CORS for the trading edge functions.
 *
 * A plain .mjs module so the Node test suite can import it directly; the Deno
 * runtime loads the same file unchanged.
 *
 * The allow-header list is not boilerplate. supabase-js attaches `x-client-info`
 * to every functions.invoke call, so a preflight that does not list it makes the
 * browser reject the request before it is sent, and the customer sees it as a
 * generic "we couldn't place your order" with nothing in the console. That is
 * exactly the failure this file exists to prevent, so the list is explicit.
 */

export const CORS_ALLOW_HEADERS = 'authorization, x-client-info, apikey, content-type';
export const CORS_ALLOW_METHODS = 'POST, OPTIONS';
export const CORS_MAX_AGE = '86400';

function parseAllowlist(allowedOrigins) {
    return String(allowedOrigins == null ? '' : allowedOrigins)
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean);
}

/**
 * Returns the value for Access-Control-Allow-Origin, or null when the caller's
 * origin is not allowed (in which case no header is emitted and the browser
 * blocks the response).
 *
 * An unconfigured allowlist falls back to "*" rather than refusing everything:
 * these functions authenticate with a bearer header, not a cookie, so a wildcard
 * origin does not expose ambient credentials.
 */
export function resolveAllowOrigin(requestOrigin, allowedOrigins) {
    const allowlist = parseAllowlist(allowedOrigins);
    if (allowlist.length === 0) return '*';
    if (!requestOrigin) return null;
    return allowlist.includes(requestOrigin) ? requestOrigin : null;
}

/**
 * The complete CORS header set. Every response carries it, including 4xx and 5xx
 * bodies: a browser discards the body of an error response it cannot read
 * cross-origin, which would hide the very error we want to show.
 */
export function corsHeaders(requestOrigin, allowedOrigins) {
    const headers = {
        'Access-Control-Allow-Headers': CORS_ALLOW_HEADERS,
        'Access-Control-Allow-Methods': CORS_ALLOW_METHODS,
        'Access-Control-Max-Age': CORS_MAX_AGE,
        'Access-Control-Expose-Headers': 'content-type, x-request-id',
        Vary: 'Origin',
        'Cache-Control': 'no-store'
    };
    const allowOrigin = resolveAllowOrigin(requestOrigin, allowedOrigins);
    if (allowOrigin) headers['Access-Control-Allow-Origin'] = allowOrigin;
    return headers;
}

export function requestOriginOf(request) {
    return request && request.headers ? request.headers.get('Origin') : null;
}

/**
 * A preflight is answered before any auth check or body parsing. An OPTIONS
 * request never carries an Authorization header, so treating it like a normal
 * call would reject it with 401 and the browser would then never send the POST.
 */
export function preflightResponse(request, allowedOrigins) {
    return new Response(null, { status: 204, headers: corsHeaders(requestOriginOf(request), allowedOrigins) });
}
