/* assets/js/trade.js - 2026 Binance Live WebSocket & Candlestick/OHLC Engine */

const coins = [
    { name: 'BTC', price: 77150.00, change: 2.85 },
    { name: 'ETH', price: 2845.50, change: 1.95 },
    { name: 'BNB', price: 624.80, change: -0.45 },
    { name: 'SOL', price: 168.40, change: 4.82 },
    { name: 'ADA', price: 0.5840, change: -0.95 },
    { name: 'XRP', price: 0.6250, change: 3.15 },
    { name: 'DOGE', price: 0.1450, change: 6.20 },
    { name: 'DOT', price: 8.40, change: -1.80 },
    { name: 'AVAX', price: 38.90, change: 2.40 },
    { name: 'NEAR', price: 6.85, change: 8.50 },
    { name: 'LINK', price: 17.20, change: 3.90 },
    { name: 'UNI', price: 9.15, change: 1.85 },
    { name: 'ATOM', price: 10.40, change: -1.20 },
    { name: 'LTC', price: 84.60, change: 0.85 },
    { name: 'SUI', price: 2.45, change: 11.20 }
];

let liveMarket = {
    symbol: 'BTCUSDT',
    interval: '1m',
    chartType: 'candle', // 'candle' | 'ohlc' | 'line'
    currentPrice: 77150.00,
    priceChange24h: 2.85,
    high24h: 78500.00,
    low24h: 75200.00,
    volume24h: '32,450 BTC',
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

// --- Ticker Banner ---
function initTickerTrack() {
    const tickerTrack = document.getElementById('tickerTrack');
    if (!tickerTrack) return;
    tickerTrack.innerHTML = '';
    coins.forEach(c => {
        const cl = c.change >= 0 ? 'positive' : 'negative';
        const s = c.change >= 0 ? '+' : '';
        const idAttr = c.name === 'BTC' ? 'id="tickerBtcPrice"' : '';
        const idChgAttr = c.name === 'BTC' ? 'id="tickerBtcChange"' : '';
        tickerTrack.innerHTML += `<div class="ticker-item"><span class="ticker-pair">${c.name}/USDT</span><span class="ticker-price" ${idAttr}>$${c.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span><span class="ticker-change ${cl}" ${idChgAttr}>${s}${c.change}%</span></div>`;
    });
    tickerTrack.innerHTML += tickerTrack.innerHTML;
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

    const open = typeof candle.open === 'number' ? candle.open : parseFloat(candle.open);
    const high = typeof candle.high === 'number' ? candle.high : parseFloat(candle.high);
    const low = typeof candle.low === 'number' ? candle.low : parseFloat(candle.low);
    const close = typeof candle.close === 'number' ? candle.close : parseFloat(candle.close);
    const vol = candle.volume !== undefined ? parseFloat(candle.volume) : 0;

    if (oEl) oEl.textContent = '$' + open.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (hEl) hEl.textContent = '$' + high.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (lEl) lEl.textContent = '$' + low.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (cEl) cEl.textContent = '$' + close.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    if (chgEl) {
        const diff = close - open;
        const pct = open > 0 ? (diff / open) * 100 : 0;
        const isUp = diff >= 0;
        chgEl.className = isUp ? 'text-success fw-bold' : 'text-danger fw-bold';
        chgEl.textContent = `${isUp ? '+' : ''}${pct.toFixed(2)}% (${isUp ? '+' : ''}$${diff.toFixed(2)})`;
    }
    if (volEl && vol > 0) {
        volEl.textContent = vol.toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' BTC';
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

    if (asksEl) {
        asksEl.innerHTML = asks.reverse().map(a => `<div class="ob-mini-row ask"><span class="text-danger">$${a.price.toFixed(2)}</span><span>${a.amount.toFixed(4)}</span><span>$${(a.price * a.amount).toFixed(2)}</span></div>`).join('');
    }
    if (bidsEl) {
        bidsEl.innerHTML = bids.map(b => `<div class="ob-mini-row bid"><span class="text-success">$${b.price.toFixed(2)}</span><span>${b.amount.toFixed(4)}</span><span>$${(b.price * b.amount).toFixed(2)}</span></div>`).join('');
    }
    if (spreadEl) {
        const midpoint = asks[0] && bids[0] ? (asks[0].price + bids[0].price) / 2 : liveMarket.currentPrice;
        spreadEl.textContent = `$${midpoint.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }
}

async function generateRecentTrades() {
    let trades = [];
    try {
        const response = await fetch(`https://data-api.binance.vision/api/v3/trades?symbol=${encodeURIComponent(liveMarket.symbol)}&limit=9`);
        if (!response.ok) throw new Error('trades unavailable');
        trades = (await response.json()).reverse().map((trade) => ({ type: trade.isBuyerMaker ? 'sell' : 'buy', price: Number(trade.price).toFixed(2), amount: Number(trade.qty).toFixed(4), time: new Date(trade.time).toTimeString().split(' ')[0] }));
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
    setWsStatus('connecting');

    const restUrls = [
        `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=120`,
        `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=120`
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
    updateOhlcDisplay(last);

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

                    const priceEl = document.getElementById('headerBtcPrice');
                    const chgEl = document.getElementById('headerBtcChange');
                    if (priceEl) {
                        priceEl.textContent = '$' + lastPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                    }
                    if (chgEl) {
                        const isUp = changePct >= 0;
                        chgEl.className = `live-change ${isUp ? 'text-success' : 'text-danger'}`;
                        chgEl.textContent = `${isUp ? '+' : ''}${changePct.toFixed(2)}%`;
                    }

                    // Ticker track BTC update
                    const tickerBtcPrice = document.getElementById('tickerBtcPrice');
                    const tickerBtcChange = document.getElementById('tickerBtcChange');
                    if (tickerBtcPrice) {
                        tickerBtcPrice.textContent = '$' + lastPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                    }
                    if (tickerBtcChange) {
                        const isUp = changePct >= 0;
                        tickerBtcChange.className = `ticker-change ${isUp ? 'positive' : 'negative'}`;
                        tickerBtcChange.textContent = `${isUp ? '+' : ''}${changePct.toFixed(2)}%`;
                    }

                    // Auto populate order form if empty or market order
                    const orderPriceInput = document.getElementById('orderPrice');
                    const activeTypeBtn = document.querySelector('.order-type-btn.active');
                    if (orderPriceInput && activeTypeBtn && activeTypeBtn.textContent.toLowerCase().includes('market')) {
                        orderPriceInput.value = lastPrice.toFixed(2);
                        updateTotal();
                    }
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
        ctx.fillText('$' + pVal.toFixed(1), canvas.width - padding.right + 6, y + 3);
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

// --- Order Form Logic ---
function setOrderType(type) {
    document.querySelectorAll('.order-type-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.order-type-btn').forEach(b => {
        if (b.textContent.trim().toLowerCase().includes(type)) b.classList.add('active');
    });
    const limitFields = document.getElementById('limitFields');
    if (limitFields) {
        limitFields.style.display = type === 'market' ? 'none' : 'block';
    }
    if (type === 'market') {
        const orderPriceInput = document.getElementById('orderPrice');
        if (orderPriceInput) orderPriceInput.value = liveMarket.currentPrice.toFixed(2);
        updateTotal();
    }
}

function setAmountPercent(pct) {
    const total = Number((window.smartProfitAccountData?.balances || []).find((balance) => balance.asset === (liveMarket.baseCoin || 'BTC'))?.available || 0);
    const amountInput = document.getElementById('orderAmount');
    if (amountInput) {
        amountInput.value = (total * pct / 100).toFixed(4);
        updateTotal();
    }
}

function updateTotal() {
    const price = parseFloat(document.getElementById('orderPrice')?.value) || liveMarket.currentPrice || 77150.00;
    const amount = parseFloat(document.getElementById('orderAmount')?.value) || 0;
    const totalEl = document.getElementById('orderTotal');
    if (totalEl) totalEl.value = (price * amount).toFixed(2);
}

async function placeOrder(type) {
    const account = window.smartProfitAccountData?.account;
    if (!account || account.execution_mode !== 'DEMO' || account.status !== 'ACTIVE') {
        alert('An active practice account is required. Real-money trading is not available.');
        return;
    }
    const amount = Number(document.getElementById('orderAmount')?.value);
    const price = Number(document.getElementById('orderPrice')?.value);
    const active = document.querySelector('.order-type-btn.active')?.textContent.trim().toLowerCase();
    const orderType = active === 'market' ? 'MARKET' : active?.includes('stop') ? 'STOP_LIMIT' : 'LIMIT';
    const button = document.querySelector(type === 'buy' ? '.btn-buy-large' : '.btn-sell-large');
    if (!Number.isFinite(amount) || amount <= 0 || (orderType !== 'MARKET' && (!Number.isFinite(price) || price <= 0))) { alert('Enter a valid order amount and price.'); return; }
    if (!window.getSupabaseClient) { alert('Authentication is still loading. Please try again.'); return; }
    button && (button.disabled = true);
    try {
        const client = await getSupabaseClient();
        // Quotes are persisted by a server function; the order RPC never trusts browser price.
        const { error: quoteError } = await client.functions.invoke('refresh-market-quote', { body: { symbol: liveMarket.symbol } });
        if (quoteError) throw quoteError;
        const clientOrderId = crypto.randomUUID();
        const { data, error } = await client.rpc('submit_demo_order', { p_client_order_id: clientOrderId, p_symbol: liveMarket.symbol, p_side: type.toUpperCase(), p_type: orderType, p_quantity: amount, p_limit_price: orderType === 'MARKET' ? null : price, p_stop_price: orderType === 'STOP_LIMIT' ? price : null, p_idempotency_key: clientOrderId });
        if (error) throw error;
        alert(`Demo ${data.state === 'FILLED' ? 'order filled' : 'order accepted'}: ${data.id}`);
        window.refreshAccountData?.();
    } catch (error) { console.error('Demo order submission failed.', error); alert(error?.message || 'Unable to submit the demo order.'); }
    finally { if (button) button.disabled = false; }
}

// ============================================================
// TOP 75 CURATED COINS (Binance USDT spot, by market cap/volume)
// ============================================================
const TOP_75_COINS = [
    { symbol: 'BTCUSDT',  base: 'BTC',    name: 'Bitcoin' },
    { symbol: 'ETHUSDT',  base: 'ETH',    name: 'Ethereum' },
    { symbol: 'SOLUSDT',  base: 'SOL',    name: 'Solana' },
    { symbol: 'BNBUSDT',  base: 'BNB',    name: 'BNB' },
    { symbol: 'XRPUSDT',  base: 'XRP',    name: 'XRP' },
    { symbol: 'DOGEUSDT', base: 'DOGE',   name: 'Dogecoin' },
    { symbol: 'ADAUSDT',  base: 'ADA',    name: 'Cardano' },
    { symbol: 'AVAXUSDT', base: 'AVAX',   name: 'Avalanche' },
    { symbol: 'SUIUSDT',  base: 'SUI',    name: 'Sui' },
    { symbol: 'LINKUSDT', base: 'LINK',   name: 'Chainlink' },
    { symbol: 'SHIBUSDT', base: 'SHIB',   name: 'Shiba Inu' },
    { symbol: 'NEARUSDT', base: 'NEAR',   name: 'NEAR Protocol' },
    { symbol: 'PEPEUSDT', base: 'PEPE',   name: 'Pepe' },
    { symbol: 'LTCUSDT',  base: 'LTC',    name: 'Litecoin' },
    { symbol: 'DOTUSDT',  base: 'DOT',    name: 'Polkadot' },
    { symbol: 'BCHUSDT',  base: 'BCH',    name: 'Bitcoin Cash' },
    { symbol: 'UNIUSDT',  base: 'UNI',    name: 'Uniswap' },
    { symbol: 'APTUSDT',  base: 'APT',    name: 'Aptos' },
    { symbol: 'ICPUSDT',  base: 'ICP',    name: 'Internet Computer' },
    { symbol: 'FETUSDT',  base: 'FET',    name: 'Fetch.ai' },
    { symbol: 'AAVEUSDT', base: 'AAVE',   name: 'Aave' },
    { symbol: 'RENDERUSDT',base:'RENDER', name: 'Render' },
    { symbol: 'FILUSDT',  base: 'FIL',    name: 'Filecoin' },
    { symbol: 'ARBUSDT',  base: 'ARB',    name: 'Arbitrum' },
    { symbol: 'OPUSDT',   base: 'OP',     name: 'Optimism' },
    { symbol: 'TIAUSDT',  base: 'TIA',    name: 'Celestia' },
    { symbol: 'INJUSDT',  base: 'INJ',    name: 'Injective' },
    { symbol: 'TRXUSDT',  base: 'TRX',    name: 'TRON' },
    { symbol: 'FTMUSDT',  base: 'FTM',    name: 'Fantom' },
    { symbol: 'WIFUSDT',  base: 'WIF',    name: 'dogwifhat' },
    { symbol: 'STXUSDT',  base: 'STX',    name: 'Stacks' },
    { symbol: 'XLMUSDT',  base: 'XLM',    name: 'Stellar' },
    { symbol: 'ATOMUSDT', base: 'ATOM',   name: 'Cosmos' },
    { symbol: 'ETCUSDT',  base: 'ETC',    name: 'Ethereum Classic' },
    { symbol: 'XMRUSDT',  base: 'XMR',    name: 'Monero' },
    { symbol: 'GRTUSDT',  base: 'GRT',    name: 'The Graph' },
    { symbol: 'THETAUSDT',base: 'THETA',  name: 'Theta Network' },
    { symbol: 'MKRUSDT',  base: 'MKR',    name: 'Maker' },
    { symbol: 'VETUSDT',  base: 'VET',    name: 'VeChain' },
    { symbol: 'LDOUSDT',  base: 'LDO',    name: 'Lido DAO' },
    { symbol: 'RUNEUSDT', base: 'RUNE',   name: 'THORChain' },
    { symbol: 'ALGOUSDT', base: 'ALGO',   name: 'Algorand' },
    { symbol: 'SEIUSDT',  base: 'SEI',    name: 'Sei' },
    { symbol: 'FLOKIUSDT',base: 'FLOKI',  name: 'FLOKI' },
    { symbol: 'BONKUSDT', base: 'BONK',   name: 'Bonk' },
    { symbol: 'JUPUSDT',  base: 'JUP',    name: 'Jupiter' },
    { symbol: 'BEAMUSDT', base: 'BEAM',   name: 'Beam' },
    { symbol: 'OMUSDT',   base: 'OM',     name: 'MANTRA' },
    { symbol: 'PYTHUSDT', base: 'PYTH',   name: 'Pyth Network' },
    { symbol: 'GALAUSDT', base: 'GALA',   name: 'Gala' },
    { symbol: 'BLURUSDT', base: 'BLUR',   name: 'Blur' },
    { symbol: 'CRVUSDT',  base: 'CRV',    name: 'Curve DAO' },
    { symbol: 'DYDXUSDT', base: 'DYDX',   name: 'dYdX' },
    { symbol: 'SANDUSDT', base: 'SAND',   name: 'The Sandbox' },
    { symbol: 'MANAUSDT', base: 'MANA',   name: 'Decentraland' },
    { symbol: 'AXSUSDT',  base: 'AXS',    name: 'Axie Infinity' },
    { symbol: 'IMXUSDT',  base: 'IMX',    name: 'Immutable' },
    { symbol: 'ENAUSDT',  base: 'ENA',    name: 'Ethena' },
    { symbol: 'PENDLEUSDT',base:'PENDLE', name: 'Pendle' },
    { symbol: 'WLDUSDT',  base: 'WLD',    name: 'Worldcoin' },
    { symbol: 'STRKUSDT', base: 'STRK',   name: 'Starknet' },
    { symbol: 'JASMYUSDT',base: 'JASMY',  name: 'JasmyCoin' },
    { symbol: 'NOTUSDT',  base: 'NOT',    name: 'Notcoin' },
    { symbol: 'BOMEUSDT', base: 'BOME',   name: 'BOOK OF MEME' },
    { symbol: 'TAOUSDT',  base: 'TAO',    name: 'Bittensor' },
    { symbol: 'TONUSDT',  base: 'TON',    name: 'Toncoin' },
    { symbol: 'ONDOUSDT', base: 'ONDO',   name: 'Ondo' },
    { symbol: 'POLUSDT',  base: 'POL',    name: 'POL (MATIC)' },
    { symbol: 'QNTUSDT',  base: 'QNT',    name: 'Quant' },
    { symbol: 'CHZUSDT',  base: 'CHZ',    name: 'Chiliz' },
    { symbol: 'APEUSDT',  base: 'APE',    name: 'ApeCoin' },
    { symbol: 'EOSUSDT',  base: 'EOS',    name: 'EOS' },
    { symbol: 'NEOUSDT',  base: 'NEO',    name: 'NEO' },
    { symbol: 'FLOWUSDT', base: 'FLOW',   name: 'Flow' },
    { symbol: 'GMXUSDT',  base: 'GMX',    name: 'GMX' }
];

// ============================================================
// SWITCH ASSET — reconnects WebSocket and updates all labels
// ============================================================
function switchAsset(symbol, baseCoin) {
    liveMarket.symbol = symbol;
    liveMarket.baseCoin = baseCoin;

    // Update pair selector display
    const pairText = document.getElementById('currentPairText');
    const pairBadge = document.getElementById('currentPairBadge');
    if (pairText) pairText.textContent = `${baseCoin}/USDT`;
    if (pairBadge) pairBadge.textContent = baseCoin;

    // Update order form labels
    ['orderBookBaseLabel', 'tradeFormAmountLabel'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = baseCoin;
    });
    const buyEl = document.getElementById('btnBuyText');
    const sellEl = document.getElementById('btnSellText');
    if (buyEl) buyEl.textContent = `Buy ${baseCoin}`;
    if (sellEl) sellEl.textContent = `Sell ${baseCoin}`;

    // Reset header price
    const priceEl = document.getElementById('headerBtcPrice');
    const chgEl = document.getElementById('headerBtcChange');
    if (priceEl) priceEl.textContent = '--';
    if (chgEl) { chgEl.textContent = '--'; chgEl.className = 'live-change'; }

    // Reset OHLC
    ['ohlcOpen','ohlcHigh','ohlcLow','ohlcClose','ohlcChange','ohlcVolume'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = '--';
    });

    // Update URL without reload
    try {
        const url = new URL(window.location.href);
        url.searchParams.set('symbol', symbol);
        history.replaceState(null, '', url.toString());
    } catch(e) {}

    // Reload chart data & reconnect WebSocket
    loadDataAndConnect(symbol, liveMarket.interval);
}

// ============================================================
// PAIR SELECTOR DROPDOWN — build list & wire search
// ============================================================
function initPairSelector() {
    const container = document.getElementById('pairListContainer');
    if (!container) return;

    function renderList() {
        container.innerHTML = TOP_75_COINS.map(c => `
            <button class="pair-list-item d-flex align-items-center gap-2 w-100 text-start border-0 bg-transparent px-2 py-1 rounded"
                    data-symbol="${c.symbol}" data-base="${c.base}"
                    onclick="switchAsset('${c.symbol}','${c.base}');bootstrap.Dropdown.getOrCreateInstance(document.getElementById('pairSelectorBtn')).hide()">
                <span class="pair-symbol-badge" style="font-size:10px;padding:2px 6px;">${c.base}</span>
                <span class="text-white fw-semibold">${c.base}<small class="text-secondary">/USDT</small></span>
                <span class="text-secondary ms-auto" style="font-size:11px;">${c.name}</span>
            </button>`).join('');
    }

    renderList();
}

// --- Wire Event Listeners & Initialize ---
document.addEventListener('DOMContentLoaded', function () {
    // Read ?symbol= URL param
    const urlParams = new URLSearchParams(window.location.search);
    const urlSymbol = urlParams.get('symbol');
    if (urlSymbol) {
        const found = TOP_75_COINS.find(c => c.symbol.toUpperCase() === urlSymbol.toUpperCase());
        if (found) {
            liveMarket.symbol = found.symbol;
            liveMarket.baseCoin = found.base;
        }
    } else {
        liveMarket.baseCoin = 'BTC';
    }

    initTickerTrack();
    initPairSelector();
    generateOrderBook();
    generateRecentTrades();
    initBinanceChart();

    // Sync initial labels to current asset
    const baseCoin = liveMarket.baseCoin || 'BTC';
    const pairText = document.getElementById('currentPairText');
    const pairBadge = document.getElementById('currentPairBadge');
    if (pairText) pairText.textContent = `${baseCoin}/USDT`;
    if (pairBadge) pairBadge.textContent = baseCoin;
    ['orderBookBaseLabel','tradeFormAmountLabel'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = baseCoin;
    });
    const buyEl = document.getElementById('btnBuyText');
    const sellEl = document.getElementById('btnSellText');
    if (buyEl) buyEl.textContent = `Buy ${baseCoin}`;
    if (sellEl) sellEl.textContent = `Sell ${baseCoin}`;

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

    // Inputs
    document.getElementById('orderPrice')?.addEventListener('input', updateTotal);
    document.getElementById('orderAmount')?.addEventListener('input', updateTotal);

    // Dynamic Interval Refresh
    setInterval(generateOrderBook, 4000);
    setInterval(generateRecentTrades, 2500);
});
