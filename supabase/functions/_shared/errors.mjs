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
