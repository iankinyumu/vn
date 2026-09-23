/* The pair universe lives in the database registry (public.market_symbols,
 * exposed through the list_market_catalog RPC). This module is the only place
 * the browser keeps a copy, so trade.html, dashboard.html and index.html can
 * never disagree about which pairs exist or which are executable.
 *
 * `tradable` is the server's own answer to "can this pair be ordered right now".
 * It already accounts for a paused symbol, so a page can disable the order form
 * instead of letting the submission fail with a server error.
 */
(function () {
    'use strict';

    var CACHE_KEY = 'smartprofit:market-catalog:v1';
    var CACHE_TTL_MS = 5 * 60 * 1000;

    var catalog = null;
    var inflight = null;

    function normalise(rows) {
        return Object.freeze(rows.map(function (row) {
            return Object.freeze({
                symbol: row.symbol,
                base_asset: row.base_asset,
                display_name: row.display_name,
                tradable: Boolean(row.tradable),
                paused: Boolean(row.paused),
                // A pair is orderable only when it is both tradable and unpaused.
                orderable: Boolean(row.tradable) && !row.paused
            });
        }));
    }

    function readCache() {
        try {
            var raw = sessionStorage.getItem(CACHE_KEY);
            if (!raw) return null;
            var parsed = JSON.parse(raw);
            if (!parsed || !Array.isArray(parsed.rows) || Date.now() - parsed.at > CACHE_TTL_MS) return null;
            return normalise(parsed.rows);
        } catch (_) { return null; }
    }

    function writeCache(rows) {
        try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), rows: rows })); }
        catch (_) { /* Storage may be disabled; the in-memory copy still serves the page. */ }
    }

    async function load(client) {
        if (catalog) return catalog;
        if (inflight) return inflight;
        inflight = (async function () {
            try {
                var result = await client.rpc('list_market_catalog');
                if (result.error) throw result.error;
                if (!Array.isArray(result.data) || result.data.length === 0) throw new Error('empty_market_catalog');
                catalog = normalise(result.data);
                writeCache(result.data);
                return catalog;
            } catch (error) {
                // A cached copy is still authoritative-ish for display; it is never
                // used to bypass the server, which re-checks every order.
                var fallback = readCache();
                if (fallback) { catalog = fallback; return catalog; }
                throw error;
            } finally {
                inflight = null;
            }
        })();
        return inflight;
    }

    function list() { return catalog || []; }

    function find(symbol) {
        if (!symbol) return null;
        var wanted = String(symbol).toUpperCase();
        var rows = list();
        for (var i = 0; i < rows.length; i++) if (rows[i].symbol === wanted) return rows[i];
        return null;
    }

    function orderable() {
        return list().filter(function (row) { return row.orderable; });
    }

    function clear() {
        catalog = null;
        try { sessionStorage.removeItem(CACHE_KEY); } catch (_) { /* ignore */ }
    }

    window.SmartProfitMarkets = Object.freeze({
        load: load,
        list: list,
        find: find,
        orderable: orderable,
        clear: clear
    });
})();
