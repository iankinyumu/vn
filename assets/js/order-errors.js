/* Customer-facing translation of the two failures an order can hit.
 *
 * Every order goes browser -> functions.invoke('refresh-market-quote') ->
 * submit_demo_order, and each hop fails differently:
 *
 *   - the function hop returns { error: { code, message }, request_id } for a
 *     handled failure, or no response at all when the request never left the
 *     browser (CORS, offline, DNS);
 *   - the RPC hop raises a bare machine string such as 'insufficient available
 *     USDT', which the customer must never read.
 *
 * Both are mapped here so no raw server text can reach the interface. An
 * unrecognised failure still shows a generic sentence, but with a short
 * reference id that is also written to the console next to the full error, so a
 * support request can be tied back to the actual cause.
 */
(function () {
    'use strict';

    var GENERIC_ORDER_FAILURE = "We couldn't place your order.";
    var UNREACHABLE_MESSAGE = "We couldn't reach the trading service. Check your connection and try again.";
    var SESSION_EXPIRED_MESSAGE = 'Your session has expired. Please sign in again.';
    var PAIR_UNAVAILABLE_MESSAGE = "This pair isn't available for trading right now.";
    var PRICES_UNAVAILABLE_MESSAGE = 'Live prices are temporarily unavailable. Please try again in a moment.';

    /* Codes the refreshed functions return. They are stable strings, so the
     * browser never has to pattern-match on a sentence. */
    var QUOTE_CODE_MESSAGES = {
        unauthorized: SESSION_EXPIRED_MESSAGE,
        rate_limited: 'Too many requests. Please wait a moment and try again.',
        unsupported_symbol: PAIR_UNAVAILABLE_MESSAGE,
        pair_not_available: PAIR_UNAVAILABLE_MESSAGE,
        market_data_unavailable: PRICES_UNAVAILABLE_MESSAGE,
        registry_unavailable: PRICES_UNAVAILABLE_MESSAGE
    };

    /* submit_demo_order prefixes, in the order they must be tested. The USDT case
     * has to come before the generic asset case, otherwise a cash shortfall would
     * tell the customer to "buy first" when they already hold dollars. */
    var ORDER_PREFIX_MESSAGES = [
        { prefix: 'trading_restricted', message: 'Your account is currently restricted from trading. Contact support for details.' },
        { prefix: 'symbol_trading_paused', message: 'Trading on this pair is temporarily paused.' },
        { prefix: 'symbol_not_tradable', message: PAIR_UNAVAILABLE_MESSAGE },
        { prefix: 'unknown symbol', message: PAIR_UNAVAILABLE_MESSAGE },
        { prefix: 'insufficient available USDT', message: 'Not enough USDT available for this order.' },
        { prefix: 'insufficient available ', message: null, assetTemplate: "You don't have enough {asset} to sell. Demo accounts start with USDT only, so buy first." },
        { prefix: 'minimum order notional is 10 USDT', message: 'The minimum order size is 10 USDT.' },
        { prefix: 'invalid symbol or quantity precision', message: 'That amount has too many decimal places.' },
        { prefix: 'order rate limit exceeded', message: "You're placing orders too quickly. Please wait a minute." },
        { prefix: 'a fresh server market quote is required', message: 'Prices are updating. Please try again in a few seconds.' },
        { prefix: 'invalid price fields for order type', message: 'Please check the price fields for this order type.' },
        { prefix: 'authentication required', message: SESSION_EXPIRED_MESSAGE },
        { prefix: 'an active DEMO account is required', message: 'An active practice account is required to trade. Refresh and try again.' }
    ];

    var ASSET_FROM_INSUFFICIENT = /^insufficient available ([A-Z0-9]{2,12})$/;

    function createReferenceId() {
        var bytes = new Uint8Array(4);
        if (window.crypto && window.crypto.getRandomValues) {
            window.crypto.getRandomValues(bytes);
        } else {
            for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
        }
        return Array.prototype.map.call(bytes, function (byte) {
            return ('0' + byte.toString(16)).slice(-2);
        }).join('').toUpperCase();
    }

    /** True when the browser never received a response (offline, CORS, DNS). */
    function isTransportFailure(error) {
        if (!error) return false;
        var name = String(error.name || '');
        if (name === 'FunctionsFetchError' || name === 'FunctionsRelayError' || name === 'TypeError') return true;
        if (error.context) return false;
        return error instanceof TypeError;
    }

    /** Reads the server's JSON body out of a FunctionsHttpError, if there is one. */
    async function readErrorPayload(error) {
        var context = error && error.context;
        if (!context) return null;
        if (typeof context.json === 'function') {
            try { return await context.json(); } catch (_) { return null; }
        }
        if (typeof context === 'object') return context;
        return null;
    }

    /**
     * Returns the customer sentence for a failed refresh-market-quote call, or
     * null when the failure is not one this module can explain.
     */
    async function describeQuoteFailure(error) {
        if (isTransportFailure(error)) return { message: UNREACHABLE_MESSAGE, code: 'network' };

        var payload = await readErrorPayload(error);
        var code = payload && payload.error && payload.error.code;
        if (code && QUOTE_CODE_MESSAGES[code]) return { message: QUOTE_CODE_MESSAGES[code], code: code };

        // A 401 also arrives as a plain message when the body is unreadable.
        if (/unauthori[sz]ed|jwt|session/i.test(String((error && error.message) || ''))) {
            return { message: SESSION_EXPIRED_MESSAGE, code: 'unauthorized' };
        }
        return null;
    }

    /** Returns the customer sentence for a failed submit_demo_order call, or null. */
    function describeOrderFailure(error) {
        var message = String((error && error.message) || '').trim();
        if (!message) return null;

        for (var i = 0; i < ORDER_PREFIX_MESSAGES.length; i++) {
            var entry = ORDER_PREFIX_MESSAGES[i];
            if (message.indexOf(entry.prefix) !== 0) continue;
            if (entry.message) return { message: entry.message, code: entry.prefix.trim() };
            var match = ASSET_FROM_INSUFFICIENT.exec(message);
            var asset = match ? match[1] : 'that asset';
            return { message: entry.assetTemplate.replace('{asset}', asset), code: 'insufficient_available' };
        }
        return null;
    }

    /** The sentence shown when nothing matched, carrying a traceable reference. */
    function genericFailure(referenceId) {
        return GENERIC_ORDER_FAILURE + ' Reference: ' + referenceId;
    }

    window.SmartProfitOrderErrors = Object.freeze({
        createReferenceId: createReferenceId,
        describeQuoteFailure: describeQuoteFailure,
        describeOrderFailure: describeOrderFailure,
        genericFailure: genericFailure,
        unreachableMessage: UNREACHABLE_MESSAGE
    });
})();
