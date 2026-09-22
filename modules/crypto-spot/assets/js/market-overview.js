/* assets/js/market-overview.js - live market table driven by the market registry.
 *
 * The listed pairs come from window.SmartProfitMarkets (backed by the
 * list_market_catalog RPC), never from an array in this file. 24h statistics
 * come straight from Binance's public REST snapshot and mini-ticker stream.
 */
(function () {
    'use strict';

    /* ---------- State ---------- */
    var coins = [];            // catalog rows, ordered by the registry's sort_order
    var coinSet = {};          // symbol -> true, for the stream filter
    var marketData = {};
    var searchQuery = '';
    var currentPage = 1;
    var pageSize = 10;
    var marketWs = null;
    var tableReady = false;

    /* ---------- Formatters ---------- */
    function fmt(num, dec) {
        if (num === undefined || num === null || isNaN(num)) return '--';
        return Number(num).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
    }
    function fmtPrice(price) {
        if (!price || isNaN(price)) return '--';
        var p = parseFloat(price);
        if (p >= 1000) return '$' + fmt(p, 2);
        if (p >= 1)    return '$' + fmt(p, 4);
        return '$' + fmt(p, 6);
    }
    function fmtVol(vol) {
        if (!vol || isNaN(vol)) return '--';
        if (vol >= 1e9) return '$' + (vol / 1e9).toFixed(2) + 'B';
        if (vol >= 1e6) return '$' + (vol / 1e6).toFixed(2) + 'M';
        if (vol >= 1e3) return '$' + (vol / 1e3).toFixed(1) + 'K';
        return '$' + fmt(vol, 0);
    }

    /* ---------- Status badge ---------- */
    function setMarketStatus(text, cls) {
        var badge  = document.getElementById('marketWsStatus');
        var textEl = document.getElementById('marketWsStatusText');
        if (!textEl) return;
        textEl.textContent = text;
        if (badge) {
            badge.classList.remove('connecting', 'disconnected');
            if (cls) badge.classList.add(cls);
        }
    }

    function visibleCoins() {
        var q = searchQuery.toLowerCase();
        return coins.filter(function (c) {
            return !q || c.base.toLowerCase().indexOf(q) > -1 || c.name.toLowerCase().indexOf(q) > -1;
        });
    }

    /* ---------- Full table render ---------- */
    function renderTable() {
        var tbody = document.getElementById('marketOverviewBody');
        if (!tbody) return;
        var visible = visibleCoins();
        var totalPages = Math.max(1, Math.ceil(visible.length / pageSize));
        if (currentPage > totalPages) currentPage = totalPages;
        var pageStart = (currentPage - 1) * pageSize;
        var pageCoins = visible.slice(pageStart, pageStart + pageSize);
        updatePagination(totalPages, visible.length);
        if (visible.length === 0) {
            tbody.innerHTML = '<tr><td colspan="8" class="text-center text-secondary py-3">No results for &ldquo;' + searchQuery + '&rdquo;</td></tr>';
            return;
        }
        tbody.innerHTML = pageCoins.map(function (c, idx) {
            var d = marketData[c.symbol] || {};
            var price  = d.price  !== undefined ? fmtPrice(d.price)  : '<span class="text-secondary">—</span>';
            var chgNum = parseFloat(d.change || 0);
            var chgCls = chgNum >= 0 ? 'text-success' : 'text-danger';
            var chgStr = d.change !== undefined ? (chgNum >= 0 ? '+' : '') + fmt(chgNum, 2) + '%' : '—';
            var high   = d.high   !== undefined ? fmtPrice(d.high)   : '—';
            var low    = d.low    !== undefined ? fmtPrice(d.low)    : '—';
            var vol    = d.volume !== undefined ? fmtVol(parseFloat(d.volume)) : '—';
            var marketBadge = c.orderable
                ? '<span class="badge bg-success bg-opacity-10 text-success border border-success border-opacity-25 ms-1" style="font-size:9px;">Tradable</span>'
                : '<span class="badge bg-secondary bg-opacity-10 text-secondary border border-secondary border-opacity-25 ms-1" style="font-size:9px;">View only</span>';
            return '<tr id="row-' + c.symbol + '">'
                 + '<td class="text-secondary">' + (pageStart + idx + 1) + '</td>'
                 + '<td><div class="coin-info d-flex align-items-center gap-2">'
                 + '<span class="pair-symbol-badge" style="font-size:10px;padding:2px 5px;border-radius:4px;">' + c.base + '</span>'
                 + '<div><span class="fw-bold">' + c.base + '/USDT</span>' + marketBadge
                 + '<small class="d-block text-secondary" style="font-size:10px;">' + c.name + '</small></div>'
                 + '</div></td>'
                 + '<td class="fw-bold" id="price-' + c.symbol + '">' + price + '</td>'
                 + '<td class="' + chgCls + ' fw-semibold" id="change-' + c.symbol + '">' + chgStr + '</td>'
                 + '<td class="text-secondary" id="high-' + c.symbol + '">' + high + '</td>'
                 + '<td class="text-secondary" id="low-' + c.symbol + '">' + low + '</td>'
                 + '<td class="text-secondary" id="vol-' + c.symbol + '">' + vol + '</td>'
                 + '<td><a href="trade.html?symbol=' + c.symbol + '" class="btn btn-premium-primary btn-sm">Trade</a></td>'
                 + '</tr>';
        }).join('');
    }

    function updatePagination(totalPages, totalItems) {
        var prev = document.getElementById('marketPrevPage');
        var next = document.getElementById('marketNextPage');
        var status = document.getElementById('marketPageStatus');
        if (prev) prev.disabled = currentPage <= 1 || totalItems === 0;
        if (next) next.disabled = currentPage >= totalPages || totalItems === 0;
        if (status) status.textContent = totalItems ? 'Page ' + currentPage + ' of ' + totalPages : 'No markets found';
    }

    /* ---------- Single-row update (no full re-render) ---------- */
    function updateRow(sym, newData) {
        var oldPrice = (marketData[sym] || {}).price;
        var priceEl  = document.getElementById('price-'  + sym);
        var changeEl = document.getElementById('change-' + sym);
        var highEl   = document.getElementById('high-'   + sym);
        var lowEl    = document.getElementById('low-'    + sym);
        var volEl    = document.getElementById('vol-'    + sym);
        if (!priceEl) return; // row not visible (filtered out)

        var np = fmtPrice(newData.price);
        if (priceEl.textContent !== np) {
            priceEl.textContent = np;
            priceEl.classList.remove('price-flash-up', 'price-flash-down');
            void priceEl.offsetWidth; // reflow
            priceEl.classList.add(parseFloat(newData.price) >= parseFloat(oldPrice || 0) ? 'price-flash-up' : 'price-flash-down');
        }
        if (changeEl) {
            var cn = parseFloat(newData.change || 0);
            changeEl.className = (cn >= 0 ? 'text-success' : 'text-danger') + ' fw-semibold';
            changeEl.textContent = (cn >= 0 ? '+' : '') + fmt(cn, 2) + '%';
        }
        if (highEl) highEl.textContent = fmtPrice(newData.high);
        if (lowEl)  lowEl.textContent  = fmtPrice(newData.low);
        if (volEl)  volEl.textContent  = fmtVol(parseFloat(newData.volume || 0));
    }

    /* ---------- REST preload ---------- */
    async function loadRestData() {
        setMarketStatus('LOADING...', 'connecting');
        var urls = [
            'https://api.binance.com/api/v3/ticker/24hr',
            'https://data-api.binance.vision/api/v3/ticker/24hr'
        ];
        for (var i = 0; i < urls.length; i++) {
            try {
                var res = await fetch(urls[i]);
                if (!res.ok) continue;
                var all = await res.json();
                all.forEach(function (t) {
                    if (!coinSet[t.symbol]) return;
                    marketData[t.symbol] = {
                        price:  parseFloat(t.lastPrice),
                        change: parseFloat(t.priceChangePercent),
                        high:   parseFloat(t.highPrice),
                        low:    parseFloat(t.lowPrice),
                        volume: parseFloat(t.quoteVolume)
                    };
                });
                break;
            } catch (e) {
                console.warn('[market-overview] REST error:', e.message);
            }
        }
        renderTable();
        tableReady = true;
        connectMarketWs();
    }

    /* ---------- WebSocket stream ---------- */
    function connectMarketWs() {
        if (marketWs) { try { marketWs.close(); } catch (e) {} }
        try {
            marketWs = new WebSocket('wss://stream.binance.com:9443/ws/!miniTicker@arr');
            marketWs.onopen  = function () { setMarketStatus('LIVE'); };
            marketWs.onerror = function () { setMarketStatus('ERROR', 'disconnected'); };
            marketWs.onclose = function () {
                setMarketStatus('RECONNECTING...', 'connecting');
                setTimeout(connectMarketWs, 4000);
            };
            marketWs.onmessage = function (ev) {
                try {
                    var tickers = JSON.parse(ev.data);
                    if (!Array.isArray(tickers)) return;
                    tickers.forEach(function (t) {
                        if (!coinSet[t.s]) return;
                        var nd = {
                            price:  parseFloat(t.c),
                            change: parseFloat(t.P),
                            high:   parseFloat(t.h),
                            low:    parseFloat(t.l),
                            volume: parseFloat(t.q)
                        };
                        if (tableReady) updateRow(t.s, nd);
                        marketData[t.s] = nd;
                    });
                } catch (e) { /* silent */ }
            };
        } catch (e) {
            setMarketStatus('WS ERROR', 'disconnected');
        }
    }

    /* ---------- Bootstrap on DOMContentLoaded ---------- */
    document.addEventListener('DOMContentLoaded', async function () {
        var tbody = document.getElementById('marketOverviewBody');
        if (!tbody) return; // not the dashboard page

        var searchEl = document.getElementById('marketSearchInput');
        if (searchEl) {
            searchEl.addEventListener('input', function () {
                searchQuery = this.value.trim();
                currentPage = 1;
                renderTable();
            });
        }
        var prev = document.getElementById('marketPrevPage');
        var next = document.getElementById('marketNextPage');
        if (prev) prev.addEventListener('click', function () {
            if (currentPage > 1) { currentPage--; renderTable(); }
        });
        if (next) next.addEventListener('click', function () {
            if (currentPage < Math.ceil(visibleCoins().length / pageSize)) { currentPage++; renderTable(); }
        });

        setMarketStatus('LOADING...', 'connecting');
        try {
            var client = await window.getSupabaseClient();
            var rows = await window.SmartProfitMarkets.load(client);
            coins = rows.map(function (row) {
                coinSet[row.symbol] = true;
                return { symbol: row.symbol, base: row.base_asset, name: row.display_name, orderable: row.orderable };
            });
        } catch (error) {
            console.error('[market-overview] catalog load failed:', error);
            setMarketStatus('MARKET LIST UNAVAILABLE', 'disconnected');
            tbody.innerHTML = '<tr><td colspan="8" class="text-center text-secondary py-3">The market list could not be loaded. Reload the page to try again.</td></tr>';
            return;
        }
        loadRestData();
    });
})();
