/* assets/js/market-ticker.js - the single live price ticker used by every page.
 *
 * The pair list comes from window.SmartProfitMarkets (backed by the
 * list_market_catalog RPC). This file contains no coin array, no seed price, and
 * no invented percentage: before the registry existed, trade.js, index.js and
 * profile.js each rendered their own hardcoded list with fabricated numbers,
 * so the home page could quote a BTC price the exchange had never seen.
 *
 * Prices come only from Binance's public mini-ticker stream. Until a real tick
 * arrives a cell shows the placeholder, never a number the browser invented.
 */
(function () {
    'use strict';

    var STREAM_URL = 'wss://stream.binance.com:9443/ws/!miniTicker@arr';
    var RECONNECT_DELAY_MS = 5000;
    var DEFAULT_LIMIT = 15;
    var PLACEHOLDER = '--';

    function formatPrice(value) {
        if (!isFinite(value)) return PLACEHOLDER;
        return '$' + Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function formatChange(value) {
        if (!isFinite(value)) return PLACEHOLDER;
        return (value >= 0 ? '+' : '') + Number(value).toFixed(2) + '%';
    }

    function cellId(kind, symbol) {
        return kind + '-' + symbol;
    }

    function itemHtml(row) {
        return '<div class="ticker-item">' +
            '<span class="ticker-pair">' + row.base_asset + '/USDT</span>' +
            '<span class="ticker-price" id="' + cellId('ticker-price', row.symbol) + '">' + PLACEHOLDER + '</span>' +
            '<span class="ticker-change" id="' + cellId('ticker-change', row.symbol) + '">' + PLACEHOLDER + '</span>' +
            '</div>';
    }

    function renderTrack(track, rows) {
        var html = rows.map(itemHtml).join('');
        /* Duplicated once so the CSS marquee can loop seamlessly; both copies
         * are updated because the stream writes every match, not one element. */
        track.innerHTML = html + html;
    }

    function updateCells(symbol, price, change) {
        var up = change >= 0;
        document.querySelectorAll('[id="' + cellId('ticker-price', symbol) + '"]').forEach(function (el) {
            el.textContent = formatPrice(price);
        });
        document.querySelectorAll('[id="' + cellId('ticker-change', symbol) + '"]').forEach(function (el) {
            el.className = 'ticker-change ' + (up ? 'positive' : 'negative');
            el.textContent = formatChange(change);
        });
    }

    function openStream(symbols) {
        var wanted = new Set(symbols);
        var socket = null;
        var reconnectTimer = null;
        var closed = false;

        function connect() {
            if (closed) return;
            try {
                socket = new WebSocket(STREAM_URL);
            } catch (_) {
                reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
                return;
            }
            socket.onmessage = function (event) {
                var tickers;
                try { tickers = JSON.parse(event.data); } catch (_) { return; }
                if (!Array.isArray(tickers)) return;
                tickers.forEach(function (ticker) {
                    if (!wanted.has(ticker.s)) return;
                    updateCells(ticker.s, parseFloat(ticker.c), parseFloat(ticker.P));
                });
            };
            socket.onerror = function () { setUnavailable(symbols); };
            socket.onclose = function () {
                if (closed) return;
                setUnavailable(symbols);
                reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
            };
        }

        function setUnavailable(list) {
            list.forEach(function (symbol) {
                updateCells(symbol, NaN, NaN);
            });
        }

        connect();

        return {
            close: function () {
                closed = true;
                clearTimeout(reconnectTimer);
                if (socket) { try { socket.close(); } catch (_) { /* already closed */ } }
            }
        };
    }

    function showUnavailable(track, message) {
        track.innerHTML = '<div class="ticker-item"><span class="ticker-pair">' + message + '</span></div>';
    }

    /* mount({ track, client, limit }) -> { close }
     * `track` is the .ticker-track element. Rejects only if the track is missing;
     * a registry failure is rendered in place so the page still looks intentional. */
    async function mount(options) {
        var track = options.track;
        if (!track) return { close: function () {} };
        var limit = options.limit || DEFAULT_LIMIT;

        showUnavailable(track, 'Loading markets…');

        var rows;
        try {
            var catalog = await window.SmartProfitMarkets.load(options.client);
            rows = catalog.slice(0, limit);
        } catch (_) {
            showUnavailable(track, 'Market list unavailable');
            return { close: function () {} };
        }
        if (rows.length === 0) {
            showUnavailable(track, 'Market list unavailable');
            return { close: function () {} };
        }

        renderTrack(track, rows);
        var stream = openStream(rows.map(function (row) { return row.symbol; }));
        return { close: stream.close };
    }

    window.SmartProfitTicker = Object.freeze({ mount: mount });
})();
