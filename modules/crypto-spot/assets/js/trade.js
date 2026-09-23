/* assets/js/trade.js - 2026 Binance Live WebSocket & Candlestick/OHLC Engine
 *
 * The page owns three things: the live chart, the pair universe (read from the
 * market registry via window.SmartProfitMarkets) and the order form. Order-form
 * mechanics - precision, presets, retry identity, the status region - live in
 * order-form.js, and every failure sentence lives in order-errors.js, so the
 * rules that decide what a customer is told can be tested without a chart.
 *
 * No price is ever invented here: an unpriced pair renders a placeholder.
 */

let liveMarket = {
    // The pair is filled in from the registry on load; there is deliberately no
    // literal default pair in this file.
    symbol: '',
    baseCoin: '',
    interval: '1m',
    chartType: 'candle', // 'candle' | 'ohlc' | 'line'
    currentPrice: 0,
    priceChange24h: 0,
    high24h: 0,
    low24h: 0,
    volume24h: '',
    priceDecimals: 2,
    quantityDecimals: 4,
    selectedSide: 'buy',
    candles: [],
    latestCandle: null,
    ws: null,
    wsReconnectTimeout: null,
    chart: null,
    candleSeries: null,
    barSeries: null,
    areaSeries: null,
    volumeSeries: null
};

// --- Ticker Banner (live, restricted to the registry's listed pairs) ---
// Rendering and streaming live in market-ticker.js so every page shows the same
// pairs; this file keeps no copy of the pair universe.
const TICKER_LIMIT = 15;
let tickerController = null;

async function initTickerTrack(client) {
    const tickerTrack = document.getElementById('tickerTrack');
    if (!tickerTrack) return;
    tickerController?.close();
    tickerController = await window.SmartProfitTicker.mount({ track: tickerTrack, client, limit: TICKER_LIMIT });
}

// --- OHLC Display Bar ---
function updateOhlcDisplay(candle) {
    if (!candle) return;
    const oEl = document.getElementById('ohlcOpen');
    const hEl = document.getElementById('ohlcHigh');
    const lEl = document.getElementById('ohlcLow');
    const cEl = document.getElementById('ohlcClose');
    const chgEl = document.getElementById('ohlcChange');
    const volEl = document.getElementById('ohlcVolume');

    const open = Number(candle.open);
    const high = Number(candle.high);
    const low = Number(candle.low);
    const close = Number(candle.close);
    const vol = candle.volume !== undefined ? Number(candle.volume) : 0;
    if (!Number.isFinite(close)) return;

    const money = (value) => '$' + value.toLocaleString('en-US', {
        minimumFractionDigits: liveMarket.priceDecimals,
        maximumFractionDigits: liveMarket.priceDecimals
    });

    if (oEl) oEl.textContent = money(open);
    if (hEl) hEl.textContent = money(high);
    if (lEl) lEl.textContent = money(low);
    if (cEl) cEl.textContent = money(close);

    if (chgEl) {
        const diff = close - open;
        const pct = open > 0 ? (diff / open) * 100 : 0;
        const isUp = diff >= 0;
        chgEl.className = isUp ? 'text-success fw-bold' : 'text-danger fw-bold';
        chgEl.textContent = `${isUp ? '+' : ''}${pct.toFixed(2)}% (${isUp ? '+' : ''}$${diff.toFixed(liveMarket.priceDecimals)})`;
    }
    if (volEl && vol > 0) {
        volEl.textContent = vol.toLocaleString('en-US', { maximumFractionDigits: 4 }) + (liveMarket.baseCoin ? ' ' + liveMarket.baseCoin : '');
    }
}

// --- WebSocket Status Badge ---
function setWsStatus(status) {
    const badge = document.getElementById('wsStatusBadge');
    const text = document.getElementById('wsStatusText');
    if (!badge || !text) return;
    badge.classList.remove('connecting', 'disconnected');
    if (status === 'live') {
        text.textContent = 'LIVE';
    } else if (status === 'connecting') {
        badge.classList.add('connecting');
        text.textContent = 'CONNECTING...';
    } else {
        badge.classList.add('disconnected');
        text.textContent = 'RECONNECTING...';
    }
}

// --- Order Book & Recent Trades Synced to Binance Price ---
async function generateOrderBook() {
    if (!liveMarket.symbol) return;
    let asks = [], bids = [];
    try {
        const response = await fetch(`https://data-api.binance.vision/api/v3/depth?symbol=${encodeURIComponent(liveMarket.symbol)}&limit=10`);
        if (!response.ok) throw new Error('depth unavailable');
        const depth = await response.json();
        asks = (depth.asks || []).slice(0, 7).map(([price, amount]) => ({ price: Number(price), amount: Number(amount) }));
        bids = (depth.bids || []).slice(0, 7).map(([price, amount]) => ({ price: Number(price), amount: Number(amount) }));
    } catch (error) { console.warn('Live order book unavailable.', error); return; }
    const asksEl = document.getElementById('orderBookAsks');
    const bidsEl = document.getElementById('orderBookBids');
    const spreadEl = document.querySelector('.spread-price');

    const priceText = (value) => value.toFixed(liveMarket.priceDecimals);
    const quantityText = (value) => value.toFixed(Math.min(8, liveMarket.quantityDecimals));

    if (asksEl) {
        asksEl.innerHTML = asks.reverse().map(a => `<div class="ob-mini-row ask"><span class="text-danger">$${priceText(a.price)}</span><span>${quantityText(a.amount)}</span><span>$${(a.price * a.amount).toFixed(2)}</span></div>`).join('');
    }
    if (bidsEl) {
        bidsEl.innerHTML = bids.map(b => `<div class="ob-mini-row bid"><span class="text-success">$${priceText(b.price)}</span><span>${quantityText(b.amount)}</span><span>$${(b.price * b.amount).toFixed(2)}</span></div>`).join('');
    }
    if (spreadEl) {
        const midpoint = asks[0] && bids[0] ? (asks[0].price + bids[0].price) / 2 : liveMarket.currentPrice;
        spreadEl.textContent = midpoint > 0
            ? '$' + midpoint.toLocaleString('en-US', { minimumFractionDigits: liveMarket.priceDecimals, maximumFractionDigits: liveMarket.priceDecimals })
            : '--';
    }
}

async function generateRecentTrades() {
    if (!liveMarket.symbol) return;
    let trades = [];
    try {
        const response = await fetch(`https://data-api.binance.vision/api/v3/trades?symbol=${encodeURIComponent(liveMarket.symbol)}&limit=9`);
        if (!response.ok) throw new Error('trades unavailable');
        trades = (await response.json()).reverse().map((trade) => ({ type: trade.isBuyerMaker ? 'sell' : 'buy', price: Number(trade.price).toFixed(liveMarket.priceDecimals), amount: Number(trade.qty).toFixed(Math.min(8, liveMarket.quantityDecimals)), time: new Date(trade.time).toTimeString().split(' ')[0] }));
    } catch (error) { console.warn('Live trades unavailable.', error); return; }
    const el = document.getElementById('recentTrades');
    if (el) {
        el.innerHTML = trades.map(t => `<div class="recent-trade-item ${t.type}"><span>$${t.price}</span><span>${t.amount}</span><span>${t.time}</span></div>`).join('');
    }
}

// --- Live Binance Chart Engine ---
function initBinanceChart() {
    const container = document.getElementById('lightweightChartContainer');
    const canvas = document.getElementById('tradeChart');
    if (!container) return;

    if (typeof LightweightCharts === 'undefined') {
        console.warn('LightweightCharts not loaded, using HTML5 Canvas fallback.');
        initFallbackCanvasChart();
        return;
    }

    container.innerHTML = '';
    const chart = LightweightCharts.createChart(container, {
        width: container.clientWidth || 750,
        height: 420,
        layout: {
            background: { color: 'transparent' },
            textColor: '#94a3b8',
            fontSize: 11
        },
        grid: {
            vertLines: { color: 'rgba(255, 255, 255, 0.03)' },
            horzLines: { color: 'rgba(255, 255, 255, 0.03)' }
        },
        crosshair: {
            mode: LightweightCharts.CrosshairMode.Normal,
            vertLine: {
                color: 'rgba(99, 102, 241, 0.4)',
                width: 1,
                style: LightweightCharts.LineStyle.Dashed
            },
            horzLine: {
                color: 'rgba(99, 102, 241, 0.4)',
                width: 1,
                style: LightweightCharts.LineStyle.Dashed
            }
        },
        rightPriceScale: {
            borderColor: 'rgba(255, 255, 255, 0.08)',
            scaleMargins: {
                top: 0.1,
                bottom: 0.22
            }
        },
        timeScale: {
            borderColor: 'rgba(255, 255, 255, 0.08)',
            timeVisible: true,
            secondsVisible: false
        }
    });

    liveMarket.chart = chart;

    // 1. Candlestick Series
    liveMarket.candleSeries = chart.addCandlestickSeries({
        upColor: '#10b981',
        downColor: '#ef4444',
        borderVisible: false,
        wickUpColor: '#10b981',
        wickDownColor: '#ef4444'
    });

    // 2. Bar Series (OHLC bars with left open tick & right close tick)
    liveMarket.barSeries = chart.addBarSeries({
        upColor: '#10b981',
        downColor: '#ef4444',
        openVisible: true,
        thinBars: false
    });
    liveMarket.barSeries.applyOptions({ visible: false });

    // 3. Area / Line Series
    liveMarket.areaSeries = chart.addAreaSeries({
        topColor: 'rgba(99, 102, 241, 0.35)',
        bottomColor: 'rgba(99, 102, 241, 0.0)',
        lineColor: '#818cf8',
        lineWidth: 2
    });
    liveMarket.areaSeries.applyOptions({ visible: false });

    // 4. Volume Series
    liveMarket.volumeSeries = chart.addHistogramSeries({
        color: 'rgba(99, 102, 241, 0.25)',
        priceFormat: { type: 'volume' },
        priceScaleId: ''
    });
    liveMarket.volumeSeries.priceScale().applyOptions({
        scaleMargins: {
            top: 0.82,
            bottom: 0
        }
    });

    // Crosshair tooltip tracking
    chart.subscribeCrosshairMove(param => {
        if (!param || !param.time || !param.seriesData) {
            updateOhlcDisplay(liveMarket.latestCandle);
            return;
        }
        let data = null;
        if (liveMarket.chartType === 'candle') {
            data = param.seriesData.get(liveMarket.candleSeries);
        } else if (liveMarket.chartType === 'ohlc') {
            data = param.seriesData.get(liveMarket.barSeries);
        } else {
            const areaVal = param.seriesData.get(liveMarket.areaSeries);
            if (areaVal) {
                data = { open: areaVal.value, high: areaVal.value, low: areaVal.value, close: areaVal.value, volume: 0 };
            }
        }
        if (data) {
            updateOhlcDisplay(data);
        } else {
            updateOhlcDisplay(liveMarket.latestCandle);
        }
    });

    // Responsive resize
    window.addEventListener('resize', () => {
        if (liveMarket.chart && container) {
            liveMarket.chart.applyOptions({ width: container.clientWidth });
        }
    });

    loadDataAndConnect(liveMarket.symbol, liveMarket.interval);
}
// --- Fetch Historical Binance Klines & Connect WebSocket ---
async function loadDataAndConnect(symbol, interval) {
    if (!symbol) return;
    setWsStatus('connecting');

    const restUrls = [
        `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=120`,
        `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=120`
    ];

    let candles = [];
    for (const url of restUrls) {
        try {
            const res = await fetch(url);
            if (res.ok) {
                const raw = await res.json();
                candles = raw.map(k => ({
                    time: Math.floor(k[0] / 1000),
                    open: parseFloat(k[1]),
                    high: parseFloat(k[2]),
                    low: parseFloat(k[3]),
                    close: parseFloat(k[4]),
                    volume: parseFloat(k[5])
                }));
                break;
            }
        } catch (err) {
            console.warn('Binance REST error, trying fallback mirror:', err.message);
        }
    }

    if (candles.length === 0) {
        console.warn('Historical market data is unavailable; no synthetic candles will be displayed.');
        setWsStatus('disconnected');
        return;
    }

    liveMarket.candles = candles;
    const last = candles[candles.length - 1];
    liveMarket.latestCandle = last;
    liveMarket.currentPrice = last.close;
    applyPairPrecision(last.close);
    updateOhlcDisplay(last);
    renderHeaderPrice(liveMarket.currentPrice, null);
    updateMarketPrice();
    updateTotal();

    if (liveMarket.chart) {
        liveMarket.candleSeries.setData(candles);
        liveMarket.barSeries.setData(candles);
        liveMarket.areaSeries.setData(candles.map(c => ({ time: c.time, value: c.close })));
        liveMarket.volumeSeries.setData(candles.map(c => ({
            time: c.time,
            value: c.volume,
            color: c.close >= c.open ? 'rgba(16, 185, 129, 0.4)' : 'rgba(239, 68, 68, 0.4)'
        })));
        liveMarket.chart.timeScale().fitContent();
    } else {
        renderFallbackCanvas();
    }

    connectBinanceWebSocket(symbol, interval);
}

// --- Live WebSocket Stream ---
function connectBinanceWebSocket(symbol, interval) {
    if (liveMarket.ws) {
        try { liveMarket.ws.close(); } catch (e) {}
        liveMarket.ws = null;
    }
    if (liveMarket.wsReconnectTimeout) {
        clearTimeout(liveMarket.wsReconnectTimeout);
    }

    const s = symbol.toLowerCase();
    const streamUrl = `wss://stream.binance.com:9443/stream?streams=${s}@kline_${interval}/${s}@ticker`;

    try {
        const ws = new WebSocket(streamUrl);
        liveMarket.ws = ws;

        ws.onopen = function () {
            setWsStatus('live');
        };

        ws.onmessage = function (event) {
            try {
                const msg = JSON.parse(event.data);
                if (!msg || !msg.data) return;
                const d = msg.data;

                if (msg.stream && msg.stream.includes('@kline')) {
                    const k = d.k;
                    if (!k) return;
                    const candle = {
                        time: Math.floor(k.t / 1000),
                        open: parseFloat(k.o),
                        high: parseFloat(k.h),
                        low: parseFloat(k.l),
                        close: parseFloat(k.c),
                        volume: parseFloat(k.v)
                    };
                    liveMarket.latestCandle = candle;
                    liveMarket.currentPrice = candle.close;
                    updateMarketPrice();
                    updateTotal();

                    if (liveMarket.chart) {
                        liveMarket.candleSeries.update(candle);
                        liveMarket.barSeries.update(candle);
                        liveMarket.areaSeries.update({ time: candle.time, value: candle.close });
                        liveMarket.volumeSeries.update({
                            time: candle.time,
                            value: candle.volume,
                            color: candle.close >= candle.open ? 'rgba(16, 185, 129, 0.4)' : 'rgba(239, 68, 68, 0.4)'
                        });
                    } else {
                        updateFallbackWithCandle(candle);
                    }

                    updateOhlcDisplay(candle);
                } else if (msg.stream && msg.stream.includes('@ticker')) {
                    const lastPrice = parseFloat(d.c);
                    const changePct = parseFloat(d.P);
                    liveMarket.currentPrice = lastPrice;
                    liveMarket.priceChange24h = changePct;

                    applyPairPrecision(lastPrice);
                    renderHeaderPrice(lastPrice, changePct);
                    updateMarketPrice();
                    updateTotal();
                }
            } catch (err) {
                console.error('WS parse error:', err);
            }
        };

        ws.onerror = function () {
            setWsStatus('disconnected');
        };

        ws.onclose = function () {
            setWsStatus('disconnected');
            liveMarket.wsReconnectTimeout = setTimeout(() => {
                connectBinanceWebSocket(liveMarket.symbol, liveMarket.interval);
            }, 3000);
        };
    } catch (err) {
        console.error('Failed to create WebSocket:', err);
        setWsStatus('disconnected');
    }
}

// --- Header price readout (pair-neutral: the symbol is whatever is selected) ---
function renderHeaderPrice(price, changePct) {
    const priceEl = document.getElementById('headerPrice');
    const chgEl = document.getElementById('headerChange');
    if (priceEl) {
        priceEl.textContent = Number.isFinite(price) && price > 0
            ? '$' + price.toLocaleString('en-US', { minimumFractionDigits: liveMarket.priceDecimals, maximumFractionDigits: liveMarket.priceDecimals })
            : '--';
    }
    if (chgEl) {
        const hasChange = Number.isFinite(changePct);
        const isUp = hasChange && changePct >= 0;
        chgEl.className = 'live-change' + (hasChange ? (isUp ? ' text-success' : ' text-danger') : '');
        chgEl.textContent = hasChange ? `${isUp ? '+' : ''}${changePct.toFixed(2)}%` : '--';
    }
}

// --- Chart Type Toggle (Candlestick, OHLC Bar, Line) ---
function setChartType(type) {
    liveMarket.chartType = type;

    const btnLine = document.getElementById('chartTypeLine');
    const btnCandle = document.getElementById('chartTypeCandle');
    const btnOhlc = document.getElementById('chartTypeOhlc');

    [btnLine, btnCandle, btnOhlc].forEach(b => b && b.classList.remove('active'));

    if (type === 'candle' && btnCandle) btnCandle.classList.add('active');
    if (type === 'ohlc' && btnOhlc) btnOhlc.classList.add('active');
    if (type === 'line' && btnLine) btnLine.classList.add('active');

    if (liveMarket.chart) {
        liveMarket.candleSeries.applyOptions({ visible: type === 'candle' });
        liveMarket.barSeries.applyOptions({ visible: type === 'ohlc' });
        liveMarket.areaSeries.applyOptions({ visible: type === 'line' });
    } else {
        renderFallbackCanvas();
    }
}

// --- Timeframe Switching ---
function setTimeframe(interval) {
    liveMarket.interval = interval;
    document.querySelectorAll('#timeframeButtons button').forEach(b => {
        if (b.dataset.interval === interval) {
            b.classList.add('active');
        } else {
            b.classList.remove('active');
        }
    });
    loadDataAndConnect(liveMarket.symbol, interval);
}

// --- HTML5 Canvas Fallback Renderer (if CDN is blocked) ---
function initFallbackCanvasChart() {
    const canvas = document.getElementById('tradeChart');
    if (!canvas) return;
    canvas.style.display = 'block';
    const container = document.getElementById('lightweightChartContainer');
    if (container) container.style.display = 'none';
    loadDataAndConnect(liveMarket.symbol, liveMarket.interval);
}

function renderFallbackCanvas() {
    const canvas = document.getElementById('tradeChart');
    if (!canvas || canvas.style.display === 'none') return;
    const ctx = canvas.getContext('2d');
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = 420;

    const data = liveMarket.candles;
    if (!data || data.length === 0) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const padding = { top: 20, right: 65, bottom: 30, left: 10 };
    const chartW = canvas.width - padding.left - padding.right;
    const chartH = canvas.height - padding.top - padding.bottom;

    let minP = Infinity, maxP = -Infinity;
    data.forEach(d => {
        if (d.low < minP) minP = d.low;
        if (d.high > maxP) maxP = d.high;
    });
    const range = (maxP - minP) || 1;

    // Grid lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
        const y = padding.top + (chartH / 4) * i;
        ctx.beginPath();
        ctx.moveTo(padding.left, y);
        ctx.lineTo(canvas.width - padding.right, y);
        ctx.stroke();

        const pVal = maxP - (range / 4) * i;
        ctx.fillStyle = '#94a3b8';
        ctx.font = '10px monospace';
        ctx.fillText('$' + pVal.toFixed(liveMarket.priceDecimals), canvas.width - padding.right + 6, y + 3);
    }

    const candleW = Math.max(2, (chartW / data.length) * 0.7);
    const stepX = chartW / data.length;

    if (liveMarket.chartType === 'line') {
        ctx.beginPath();
        data.forEach((d, i) => {
            const x = padding.left + i * stepX + stepX / 2;
            const y = padding.top + chartH - ((d.close - minP) / range) * chartH;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        });
        ctx.strokeStyle = '#818cf8';
        ctx.lineWidth = 2;
        ctx.stroke();
    } else {
        data.forEach((d, i) => {
            const x = padding.left + i * stepX + stepX / 2;
            const yOpen = padding.top + chartH - ((d.open - minP) / range) * chartH;
            const yClose = padding.top + chartH - ((d.close - minP) / range) * chartH;
            const yHigh = padding.top + chartH - ((d.high - minP) / range) * chartH;
            const yLow = padding.top + chartH - ((d.low - minP) / range) * chartH;

            const isUp = d.close >= d.open;
            ctx.strokeStyle = isUp ? '#10b981' : '#ef4444';
            ctx.fillStyle = isUp ? '#10b981' : '#ef4444';

            if (liveMarket.chartType === 'candle') {
                // Wick
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(x, yHigh);
                ctx.lineTo(x, yLow);
                ctx.stroke();
                // Body
                const bodyY = Math.min(yOpen, yClose);
                const bodyH = Math.max(2, Math.abs(yClose - yOpen));
                ctx.fillRect(x - candleW / 2, bodyY, candleW, bodyH);
            } else if (liveMarket.chartType === 'ohlc') {
                // Vertical High-Low line
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.moveTo(x, yHigh);
                ctx.lineTo(x, yLow);
                ctx.stroke();
                // Open tick (left)
                ctx.beginPath();
                ctx.moveTo(x - candleW / 2, yOpen);
                ctx.lineTo(x, yOpen);
                ctx.stroke();
                // Close tick (right)
                ctx.beginPath();
                ctx.moveTo(x, yClose);
                ctx.lineTo(x + candleW / 2, yClose);
                ctx.stroke();
            }
        });
    }
}

function updateFallbackWithCandle(candle) {
    if (!liveMarket.candles || liveMarket.candles.length === 0) return;
    const last = liveMarket.candles[liveMarket.candles.length - 1];
    if (last.time === candle.time) {
        liveMarket.candles[liveMarket.candles.length - 1] = candle;
    } else {
        liveMarket.candles.push(candle);
        if (liveMarket.candles.length > 120) liveMarket.candles.shift();
    }
    renderFallbackCanvas();
}
/* ============================================================
 * ORDER FORM
 * Simplified to DEMO MARKET orders only. "Market price" and
 * "Estimated total" are read-only, and "Amount" is the only
 * editable field.
 * ============================================================ */

function priceInput(id) {
    return document.getElementById(id);
}

/** The price an order is sized against: always the live market price. */
function effectivePrice() {
    return liveMarket.currentPrice;
}

function availableOf(asset) {
    if (!asset) return 0;
    const balances = (window.smartProfitAccountData && window.smartProfitAccountData.balances) || [];
    const match = balances.find((balance) => balance.asset === asset);
    return Number((match && match.available) || 0);
}

/**
 * Derives the pair's price/quantity precision from the live price magnitude and
 * writes it onto the inputs, so a sub-cent pair is not rounded to $0.00 and the
 * amount step matches the engine's accepted precision.
 */
function applyPairPrecision(price) {
    const decimals = Number.isFinite(price) && price > 0 ? price : liveMarket.currentPrice;
    if (Number.isFinite(decimals) && decimals > 0) {
        liveMarket.priceDecimals = window.SmartProfitOrderForm.decimalsForPrice(decimals);
        liveMarket.quantityDecimals = window.SmartProfitOrderForm.decimalsForQuantity(decimals);
    }

    const priceInput = document.getElementById('orderPrice');
    if (priceInput) {
        priceInput.step = String(window.SmartProfitOrderForm.stepFor(liveMarket.priceDecimals));
        if (Number.isFinite(decimals) && decimals > 0) {
            priceInput.value = window.SmartProfitOrderForm.formatPrice(decimals, liveMarket.priceDecimals);
        }
    }

    const amountInput = document.getElementById('orderAmount');
    if (amountInput) amountInput.step = String(window.SmartProfitOrderForm.stepFor(liveMarket.quantityDecimals));
}

function updateMarketPrice() {
    const priceInput = document.getElementById('orderPrice');
    if (!priceInput) return;
    if (Number.isFinite(liveMarket.currentPrice) && liveMarket.currentPrice > 0) {
        priceInput.value = window.SmartProfitOrderForm.formatPrice(liveMarket.currentPrice, liveMarket.priceDecimals);
    } else {
        priceInput.value = '';
    }
}

/** Writes the estimated total for a market order (= live price x Amount). */
function updateTotal() {
    const price = liveMarket.currentPrice;
    const amount = parseFloat(document.getElementById('orderAmount')?.value) || 0;
    const labelEl = document.getElementById('orderTotalLabel');
    const totalEl = document.getElementById('orderTotal');
    if (labelEl) labelEl.textContent = 'Estimated total (USDT)';
    if (totalEl) totalEl.value = price > 0 && amount > 0 ? (price * amount).toFixed(2) : '';
}

/** Selects the side a percent preset calculates against. */
function setOrderSide(side) {
    const wanted = side === 'sell' ? 'sell' : 'buy';
    liveMarket.selectedSide = wanted;
    document.querySelectorAll('#sideToggle .side-btn').forEach((button) => {
        const active = button.dataset.orderSide === wanted;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
    });
    window.SmartProfitOrderForm.clearStatus();
}

/**
 * Sizes the amount input from a percentage of the selected side's balance.
 * BUY spends USDT and SELL spends the base asset; using one balance for both is
 * why a new, USDT-only demo account always got zero.
 */
function setAmountPercent(percent) {
    const row = catalogRow(liveMarket.symbol);
    const side = liveMarket.selectedSide;
    const price = effectivePrice();
    // Precision is taken from the price the preset is actually sized against, so
    // the result matches even before the live ticker has set a pair precision.
    const decimals = price > 0
        ? window.SmartProfitOrderForm.decimalsForQuantity(price)
        : liveMarket.quantityDecimals;
    const amount = window.SmartProfitOrderForm.amountFromPercent({
        side: side,
        percent: percent,
        availableUsdt: availableOf('USDT'),
        availableBase: availableOf(row && row.base_asset),
        price: price,
        decimals: decimals
    });

    const amountInput = document.getElementById('orderAmount');
    if (amountInput) amountInput.value = amount > 0 ? amount.toFixed(decimals) : '';
    window.SmartProfitOrderForm.clearStatus();
    updateTotal();
}

function resetOrderFields() {
    const amountInput = document.getElementById('orderAmount');
    if (amountInput) amountInput.value = '';
    updateMarketPrice();
    updateTotal();
    window.SmartProfitOrderForm.clearStatus();
}

/** Applies a registry row to every pair-dependent label and input. */
function applyPairToForm(row) {
    if (!row) return;
    ['orderBookBaseLabel', 'tradeFormAmountLabel'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.textContent = row.base_asset;
    });
    const buyEl = document.getElementById('btnBuyText');
    const sellEl = document.getElementById('btnSellText');
    if (buyEl) buyEl.textContent = 'Buy ' + row.base_asset;
    if (sellEl) sellEl.textContent = 'Sell ' + row.base_asset;

    const pairText = document.getElementById('currentPairText');
    const pairBadge = document.getElementById('currentPairBadge');
    if (pairText) pairText.textContent = row.base_asset + '/USDT';
    if (pairBadge) pairBadge.textContent = row.base_asset;

    renderPairBalance(row);
    applyPairPrecision(liveMarket.currentPrice);
    updateTotal();
}

/**
 * Shows the balance of the pair actually selected. The page used to render a
 * fixed BTC card and a fixed ETH card whatever pair was on screen; the
 * data-wallet-asset attribute is what account-data.js keeps in sync.
 */
function renderPairBalance(row) {
    const base = row ? row.base_asset : '';
    const available = availableOf(base);
    const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

    document.querySelectorAll('[data-wallet-asset-label]').forEach((node) => { node.textContent = base || '—'; });
    document.querySelectorAll('[data-wallet-asset]').forEach((node) => {
        node.dataset.walletAsset = base;
        node.textContent = base ? available.toLocaleString('en-US', { maximumFractionDigits: 8 }) : '—';
    });
    document.querySelectorAll('[data-wallet-asset-usd]').forEach((node) => {
        node.dataset.walletAssetUsd = base;
        const mark = base === 'USDT' ? 1 : liveMarket.currentPrice;
        node.textContent = base && mark > 0 ? '≈ ' + money.format(available * mark) : '—';
    });
}
// ============================================================
// The pair universe is read from the market registry (window.SmartProfitMarkets
// -> list_market_catalog). There is deliberately no coin array in this file:
// the hardcoded list that used to live here drifted out of sync with the
// database the moment a symbol was added, paused, or retired.
// ============================================================
let marketCatalog = [];

// "The registry could not be read" and "this pair is not in the registry" both
// leave a null catalog row, but they are different faults: one is retryable and
// says nothing about the pair, the other is final for that symbol. Telling them
// apart is the whole point of this flag.
let catalogError = false;

const CATALOG_UNAVAILABLE_NOTICE = 'Market list is temporarily unavailable. Refresh to try again.';
const PAIR_NOT_LISTED_NOTICE = 'This pair is not listed by the exchange.';

function catalogRow(symbol) {
    const wanted = String(symbol || '').toUpperCase();
    return marketCatalog.find(row => row.symbol === wanted) || null;
}

function tradabilityNotice(row) {
    // A failed catalog read must never be reported as "not listed": the pair may
    // be perfectly fine and the exchange list merely unreachable.
    if (catalogError) return CATALOG_UNAVAILABLE_NOTICE;
    if (!row) return PAIR_NOT_LISTED_NOTICE;
    if (row.paused) return `${row.base_asset}/USDT trading is paused by the operations team.`;
    if (!row.tradable) return `${row.base_asset}/USDT is listed for reference only and cannot be ordered yet.`;
    return '';
}

// The registry decides what the form may submit. The server re-checks every order,
// so this only spares the customer a round trip that would fail anyway.
function applyTradability(row) {
    const blocked = !row || !row.orderable;
    const form = document.getElementById('tradeForm');
    if (form) form.querySelectorAll('input, button').forEach(el => { el.disabled = blocked; });
    const buyBtn = document.querySelector('.btn-buy-large');
    const sellBtn = document.querySelector('.btn-sell-large');
    if (buyBtn) buyBtn.disabled = blocked || submitInFlight;
    if (sellBtn) sellBtn.disabled = blocked || submitInFlight;
    const notice = document.getElementById('marketNotice');
    if (notice) {
        notice.hidden = !blocked;
        notice.textContent = tradabilityNotice(row);
    }
}

// ============================================================
// SWITCH ASSET — reconnects WebSocket and updates all labels
// ============================================================
function switchAsset(symbol) {
    const row = catalogRow(symbol);
    if (!row) return;
    liveMarket.symbol = row.symbol;
    liveMarket.baseCoin = row.base_asset;
    liveMarket.currentPrice = 0;

    resetOrderFields();
    applyPairToForm(row);
    applyTradability(row);

    // No tick has arrived for the new pair yet, so every price readout resets to
    // a placeholder rather than showing the previous pair's numbers.
    renderHeaderPrice(NaN, null);
    ['ohlcOpen', 'ohlcHigh', 'ohlcLow', 'ohlcClose', 'ohlcChange', 'ohlcVolume'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = '--';
    });

    try {
        const url = new URL(window.location.href);
        url.searchParams.set('symbol', symbol);
        history.replaceState(null, '', url.toString());
    } catch (e) {}

    loadDataAndConnect(symbol, liveMarket.interval);
}

// ============================================================
// PAIR SELECTOR DROPDOWN — build list & wire search
// ============================================================
function initPairSelector() {
    const container = document.getElementById('pairListContainer');
    if (!container) return;

    if (marketCatalog.length === 0) {
        container.innerHTML = '<div class="px-2 py-1 text-secondary" style="font-size:12px;">Market list unavailable</div>';
        return;
    }

    container.innerHTML = marketCatalog.map(row => `
        <button class="pair-list-item d-flex align-items-center gap-2 w-100 text-start border-0 bg-transparent px-2 py-1 rounded"
                data-symbol="${row.symbol}" data-base="${row.base_asset}"
                onclick="switchAsset('${row.symbol}');bootstrap.Dropdown.getOrCreateInstance(document.getElementById('pairSelectorBtn')).hide()">
            <span class="pair-symbol-badge" style="font-size:10px;padding:2px 6px;">${row.base_asset}</span>
            <span class="text-white fw-semibold">${row.base_asset}<small class="text-secondary">/USDT</small></span>
            <span class="text-secondary ms-auto" style="font-size:11px;">${row.display_name}${row.orderable ? '' : ' · view only'}</span>
        </button>`).join('');
}

// ============================================================
// ORDER SUBMISSION
// ============================================================
const intentStore = window.SmartProfitOrderForm.createIntentStore();
let submitInFlight = false;

const AMOUNT_REQUIRED = 'Enter an order amount.';
const AUTH_LOADING = 'Authentication is still loading. Please try again.';
const PRACTICE_ACCOUNT_REQUIRED = 'An active practice account is required. Real-money trading is not available.';

function setSubmitLock(locked) {
    submitInFlight = locked;
    [document.querySelector('.btn-buy-large'), document.querySelector('.btn-sell-large')].forEach(btn => {
        if (btn) btn.disabled = locked;
    });
}

function formatUsd(value) {
    const decimals = liveMarket.priceDecimals;
    return '$' + Number(value).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function formatQuantity(value) {
    return Number(value).toLocaleString('en-US', { maximumFractionDigits: 8 });
}

/**
 * The fill row for an order, so the confirmation can quote the real execution
 * price and fee. RLS on public.fills already restricts this to the caller's own
 * orders; a failure here only costs the extra detail, never the order.
 */
async function latestFill(client, orderId) {
    try {
        const { data, error } = await client
            .from('fills')
            .select('execution_price, quantity, fee, fee_asset')
            .eq('order_id', orderId)
            .order('executed_at', { ascending: false })
            .limit(1);
        if (error || !Array.isArray(data) || data.length === 0) return null;
        return data[0];
    } catch (error) {
        console.warn('Fill detail unavailable; reporting the order state only.', error);
        return null;
    }
}

/** What the customer reads after a successful submission. Never an order id. */
async function describeSuccess(client, order, row) {
    const base = row.base_asset;

    if (order.state === 'FILLED') {
        const fill = await latestFill(client, order.id);
        if (fill) {
            const verb = order.side === 'BUY' ? 'Bought' : 'Sold';
            return `${verb} ${formatQuantity(fill.quantity)} ${base} at ${formatUsd(fill.execution_price)} (fee ${Number(fill.fee).toFixed(2)} ${fill.fee_asset})`;
        }
        return 'Order filled.';
    }

    return 'Order accepted.';
}

/**
 * Places a demo market order for `side`.
 *
 * The order type is always MARKET, limit and stop prices are null, and the
 * idempotency key is reused for an unchanged payload so a retry cannot create
 * a second order.
 */
async function placeOrder(side) {
    const wantedSide = side === 'sell' ? 'sell' : 'buy';

    const account = window.smartProfitAccountData?.account;
    if (!account || account.execution_mode !== 'DEMO' || account.status !== 'ACTIVE') {
        window.SmartProfitOrderForm.setStatus('error', PRACTICE_ACCOUNT_REQUIRED);
        return;
    }
    if (submitInFlight) return;

    setOrderSide(wantedSide);

    const row = catalogRow(liveMarket.symbol);
    if (!row || !row.orderable) {
        window.SmartProfitOrderForm.setStatus('error', tradabilityNotice(row));
        return;
    }

    const amount = Number(document.getElementById('orderAmount')?.value);
    if (!Number.isFinite(amount) || amount <= 0) {
        window.SmartProfitOrderForm.setStatus('error', AMOUNT_REQUIRED);
        return;
    }

    if (!window.getSupabaseClient) {
        window.SmartProfitOrderForm.setStatus('error', AUTH_LOADING);
        return;
    }

    setSubmitLock(true);
    window.SmartProfitOrderForm.clearStatus();

    try {
        const client = await getSupabaseClient();

        // Quotes are persisted by a server function; the order RPC never trusts a
        // browser price. This is also the hop that CORS used to break.
        const { error: quoteError } = await client.functions.invoke('refresh-market-quote', { body: { symbol: liveMarket.symbol } });
        if (quoteError) {
            const described = await window.SmartProfitOrderErrors.describeQuoteFailure(quoteError);
            if (described) {
                console.error(`Quote refresh failed (${described.code}).`, quoteError);
                window.SmartProfitOrderForm.setStatus('error', described.message);
            } else {
                const reference = window.SmartProfitOrderErrors.createReferenceId();
                console.error(`Unmapped quote refresh failure. Reference: ${reference}`, quoteError);
                window.SmartProfitOrderForm.setStatus('error', window.SmartProfitOrderErrors.genericFailure(reference));
            }
            return;
        }

        const quantity = window.SmartProfitOrderForm.floorTo(amount, liveMarket.quantityDecimals);
        const fingerprint = window.SmartProfitOrderForm.intentFingerprint({
            symbol: liveMarket.symbol,
            side: wantedSide,
            type: 'MARKET',
            quantity: quantity,
            limitPrice: null,
            stopPrice: null
        });
        const clientOrderId = intentStore.keyFor(fingerprint);

        const { data, error } = await client.rpc('submit_demo_order', {
            p_client_order_id: clientOrderId,
            p_symbol: liveMarket.symbol,
            p_side: wantedSide.toUpperCase(),
            p_type: 'MARKET',
            p_quantity: quantity,
            p_limit_price: null,
            p_stop_price: null,
            p_idempotency_key: clientOrderId
        });
        if (error) throw error;

        window.SmartProfitOrderForm.setStatus('success', await describeSuccess(client, data, row));
        window.refreshAccountData?.();
    } catch (error) {
        const described = window.SmartProfitOrderErrors.describeOrderFailure(error);
        if (described) {
            console.error(`Demo order rejected (${described.code}).`, error);
            window.SmartProfitOrderForm.setStatus('error', described.message);
        } else {
            const reference = window.SmartProfitOrderErrors.createReferenceId();
            console.error(`Unmapped demo order failure. Reference: ${reference}`, error);
            window.SmartProfitOrderForm.setStatus('error', window.SmartProfitOrderErrors.genericFailure(reference));
        }
    } finally {
        setSubmitLock(false);
        applyTradability(catalogRow(liveMarket.symbol));
    }
}

// --- Wire Event Listeners & Initialize ---
document.addEventListener('DOMContentLoaded', async function () {
    // The registry is the only authority on which pairs exist. ?symbol= selects
    // among the listed pairs; an unlisted value is ignored, never assumed.
    const urlSymbol = new URLSearchParams(window.location.search).get('symbol');

    let client = null;
    try {
        client = await getSupabaseClient();
        marketCatalog = await window.SmartProfitMarkets.load(client);
    } catch (error) {
        // The catalog is what failed, not the requested symbol, so the form stays
        // closed and the notice says the market list is unavailable.
        catalogError = true;
        console.error('Market registry unavailable.', error);
    }

    // The default pair comes from the registry: the requested one if it is
    // listed, otherwise the first pair that can actually be ordered.
    const requested = catalogRow(urlSymbol)
        || marketCatalog.find(row => row.orderable)
        || marketCatalog[0]
        || null;
    if (requested) {
        liveMarket.symbol = requested.symbol;
        liveMarket.baseCoin = requested.base_asset;
    }

    await initTickerTrack(client);
    initPairSelector();
    applyPairToForm(requested);
    applyTradability(requested);

    generateOrderBook();
    generateRecentTrades();
    initBinanceChart();

    // Chart Type Buttons
    document.getElementById('chartTypeLine')?.addEventListener('click', () => setChartType('line'));
    document.getElementById('chartTypeCandle')?.addEventListener('click', () => setChartType('candle'));
    document.getElementById('chartTypeOhlc')?.addEventListener('click', () => setChartType('ohlc'));

    // Timeframe Buttons
    document.querySelectorAll('#timeframeButtons button').forEach(btn => {
        btn.addEventListener('click', function () {
            const interval = this.dataset.interval || this.textContent.trim().toLowerCase();
            setTimeframe(interval);
        });
    });

    // Side selector
    document.querySelectorAll('#sideToggle .side-btn').forEach(btn => {
        btn.addEventListener('click', () => setOrderSide(btn.dataset.orderSide));
    });

    // Percent presets
    document.querySelectorAll('.preset-btn').forEach(btn => {
        btn.addEventListener('click', () => setAmountPercent(Number(btn.dataset.preset)));
    });

    // Submit actions
    document.querySelectorAll('.btn-buy-large, .btn-sell-large').forEach(btn => {
        btn.addEventListener('click', () => placeOrder(btn.dataset.orderSide === 'sell' ? 'sell' : 'buy'));
    });

    // Any edit clears the previous outcome and recalculates estimated total
    document.getElementById('orderAmount')?.addEventListener('input', () => {
        window.SmartProfitOrderForm.clearStatus();
        updateTotal();
    });

    // Dynamic Interval Refresh
    setInterval(generateOrderBook, 4000);
    setInterval(generateRecentTrades, 2500);
});
