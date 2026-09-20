/* Order-form mechanics: precision, side-aware presets, retry identity and the
 * inline status region.
 *
 * These are the parts of the order flow that were silently wrong before:
 *
 *   - the percent presets sized every order from the BASE asset balance, so a
 *     new demo account (USDT only) always computed zero;
 *   - the price and amount inputs were pinned to toFixed(2)/toFixed(4), which
 *     prints $0.00 for a sub-cent pair and can round an amount UP past the
 *     customer's balance;
 *   - a fresh idempotency key was minted per click, so a retry of the same
 *     payload created a second order instead of returning the first.
 *
 * Keeping them here, away from the chart and the registry wiring in trade.js,
 * is what lets each rule be tested on its own.
 */
(function () {
    'use strict';

    /* 0.1% fee + up to 0.05% slippage on the fill + the 0.2% reserve headroom the
     * demo engine holds. A buy sized to exactly the balance would be rejected for
     * insufficient funds, which is why every preset divides by this. */
    var BUY_COST_FACTOR = 1.0035;

    var MIN_PRICE_DECIMALS = 2;
    var MIN_QUANTITY_DECIMALS = 4;
    var MAX_DECIMALS = 8;

    /**
     * Price precision derived from the price's own magnitude. A fixed 2 decimals
     * renders a sub-cent pair as $0.00, and the market registry does not carry
     * real tick sizes yet, so magnitude is the best available signal.
     */
    function decimalsForPrice(price) {
        if (!Number.isFinite(price) || price <= 0) return MIN_PRICE_DECIMALS;
        if (price >= 1) return MIN_PRICE_DECIMALS;
        return Math.min(MAX_DECIMALS, MIN_PRICE_DECIMALS + Math.ceil(-Math.log10(price)));
    }

    /** Quantity precision: always finer than the price, so small orders stay exact. */
    function decimalsForQuantity(price) {
        if (!Number.isFinite(price) || price <= 0) return MIN_QUANTITY_DECIMALS;
        return Math.min(MAX_DECIMALS, Math.max(MIN_QUANTITY_DECIMALS, decimalsForPrice(price) + 3));
    }

    /**
     * Truncates towards zero at the given precision. toFixed() is never used to
     * size an order: it rounds, and rounding up can exceed the available balance
     * by one unit of precision, which the engine rejects.
     */
    function floorTo(value, decimals) {
        if (!Number.isFinite(value) || value <= 0) return 0;
        var factor = Math.pow(10, decimals);
        return Number((Math.floor(value * factor) / factor).toFixed(decimals));
    }

    function stepFor(decimals) {
        return Number(Math.pow(10, -decimals).toFixed(decimals));
    }

    function formatPrice(value, decimals) {
        if (!Number.isFinite(value) || value <= 0) return '';
        return value.toFixed(decimals);
    }

    /**
     * The order size a percentage preset should fill in.
     *
     * BUY spends quote currency, so it only needs the USDT balance and the price.
     * SELL spends the base asset, which exists only once the customer has bought
     * some - that asymmetry is the bug this function exists to fix.
     */
    function amountFromPercent(options) {
        var percent = Number(options && options.percent);
        var side = String((options && options.side) || 'buy').toLowerCase();
        var decimals = Number(options && options.decimals);
        if (!Number.isFinite(percent) || percent <= 0) return 0;
        if (!Number.isFinite(decimals)) decimals = MIN_QUANTITY_DECIMALS;

        if (side === 'sell') {
            return floorTo(Number(options.availableBase || 0) * percent / 100, decimals);
        }

        var price = Number(options.price || 0);
        var availableUsdt = Number(options.availableUsdt || 0);
        if (!Number.isFinite(price) || price <= 0) return 0;
        return floorTo((availableUsdt * percent / 100) / (price * BUY_COST_FACTOR), decimals);
    }

    /** The fields that define an order intent. Any change means a new intent. */
    function intentFingerprint(intent) {
        var values = [
            intent.symbol, intent.side, intent.type,
            intent.quantity, intent.limitPrice, intent.stopPrice
        ];
        return values.map(function (value) {
            return value === null || value === undefined ? '' : String(value);
        }).join('|');
    }

    function randomKey() {
        if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
        return 'key-' + Date.now() + '-' + Math.floor(Math.random() * 1e9);
    }

    /**
     * Holds one idempotency key per order intent. A retry after a network blip
     * reuses the key and is de-duplicated by submit_demo_order; editing any field
     * changes the fingerprint and therefore the key, so the next submission is
     * genuinely a new order.
     */
    function createIntentStore(makeKey) {
        var generatedKey = makeKey || randomKey;
        var currentFingerprint = null;
        var currentKey = null;
        return {
            keyFor: function (fingerprint) {
                if (currentFingerprint !== fingerprint || !currentKey) {
                    currentFingerprint = fingerprint;
                    currentKey = generatedKey();
                }
                return currentKey;
            },
            reset: function () { currentFingerprint = null; currentKey = null; }
        };
    }

    /* ------------------------------------------------------ status region --- */

    function statusRegion() {
        return document.getElementById('orderStatus');
    }

    /**
     * Writes an inline, screen-reader-announced message under the buttons.
     * alert() used to be the only feedback channel, which blocked the page and
     * could not be styled, dismissed or read back.
     */
    function setStatus(kind, message) {
        var region = statusRegion();
        if (!region) return;
        region.hidden = false;
        region.classList.remove('order-status-success', 'order-status-error');
        region.classList.add(kind === 'success' ? 'order-status-success' : 'order-status-error');
        region.textContent = message;
    }

    function clearStatus() {
        var region = statusRegion();
        if (!region) return;
        region.hidden = true;
        region.textContent = '';
        region.classList.remove('order-status-success', 'order-status-error');
    }

    window.SmartProfitOrderForm = Object.freeze({
        BUY_COST_FACTOR: BUY_COST_FACTOR,
        decimalsForPrice: decimalsForPrice,
        decimalsForQuantity: decimalsForQuantity,
        floorTo: floorTo,
        stepFor: stepFor,
        formatPrice: formatPrice,
        amountFromPercent: amountFromPercent,
        intentFingerprint: intentFingerprint,
        createIntentStore: createIntentStore,
        setStatus: setStatus,
        clearStatus: clearStatus
    });
})();
