/* Shared error vocabulary for the trading edge functions.
 *
 * Two audiences read a failure. The customer needs one plain sentence; whoever is
 * on support needs a stable machine code plus the raw detail in the server log.
 * Keeping the code list in one place is what lets the browser map a failure
 * without pattern-matching on prose, and what stops an internal exception message
 * from ever reaching a customer.
 */

export const ERROR_CODES = Object.freeze({
    unauthorized: { status: 401, message: 'Your session has expired. Please sign in again.' },
    rate_limited: { status: 429, message: 'Too many requests. Please wait a moment and try again.' },
    unsupported_symbol: { status: 400, message: "This pair isn't available for trading right now." },
    pair_not_available: { status: 400, message: "This pair isn't available for trading right now." },
    market_data_unavailable: { status: 503, message: 'Live prices are temporarily unavailable. Please try again in a moment.' },
    registry_unavailable: { status: 503, message: 'Live prices are temporarily unavailable. Please try again in a moment.' },
    // Funding (docs/REAL_FUNDING_DESIGN.md §9).
    method_not_allowed: { status: 405, message: 'This request is not supported.' },
    payload_too_large: { status: 413, message: 'This request is too large.' },
    validation_failed: { status: 400, message: 'Some details were missing or invalid. Please check and try again.' },
    phone_invalid: { status: 400, message: 'Enter a Safaricom M-Pesa number, for example 0712 345 678.' },
    quote_not_found: { status: 404, message: 'This deposit quote was not found. Request a new quote.' },
    quote_expired: { status: 409, message: 'This quote has expired. Request a new quote to see the current rate.' },
    quote_used: { status: 409, message: 'This quote has already been used. Request a new quote.' },
    idempotency_key_reused: { status: 409, message: 'This request was already used for a different quote. Request a new quote.' },
    payment_in_progress: { status: 409, message: 'You already have a payment in progress. Wait for it to finish before starting another.' },
    sandbox_not_enabled: { status: 403, message: 'Deposits are not available on this account.' },
    production_payments_disabled: { status: 403, message: 'Deposits are not available yet.' },
    treasury_paused: { status: 503, message: 'Deposits are paused right now. Please try again later.' },
    treasury_unknown: { status: 503, message: 'Deposits are paused right now. Please try again later.' },
    phone_not_allowed: { status: 400, message: 'Sandbox deposits can only use the Daraja sandbox test number.' },
    deposit_limit_reached: { status: 409, message: 'This deposit would exceed your deposit limit for the last 24 hours.' },
    deposit_policy_unavailable: { status: 503, message: 'Deposits are paused right now. Please try again later.' },
    amount_below_minimum: { status: 400, message: 'The minimum deposit is USD 5.00.' },
    amount_above_maximum: { status: 400, message: 'This amount is above the maximum for a single deposit.' },
    payments_unavailable: { status: 503, message: 'M-Pesa deposits are temporarily unavailable. Please try again later.' },
    internal: { status: 500, message: 'Something went wrong on our side. Please try again in a moment.' }
});

export function isErrorCode(code) {
    return Object.prototype.hasOwnProperty.call(ERROR_CODES, code);
}

export function errorStatus(code) {
    return (ERROR_CODES[code] || ERROR_CODES.internal).status;
}

export function errorMessage(code) {
    return (ERROR_CODES[code] || ERROR_CODES.internal).message;
}

/**
 * An error that already knows which stable code it maps to. Anything else that is
 * thrown is an internal fault and is reported as `internal`.
 */
export class QuoteError extends Error {
    constructor(message, status = errorStatus('internal'), code = 'internal') {
        super(message);
        this.name = 'QuoteError';
        this.code = isErrorCode(code) ? code : 'internal';
        this.status = status || errorStatus(this.code);
    }
}

export function toQuoteError(error, fallbackCode = 'internal') {
    if (error instanceof QuoteError) return error;
    const detail = error instanceof Error ? error.message : String(error);
    return new QuoteError(detail, errorStatus(fallbackCode), fallbackCode);
}
