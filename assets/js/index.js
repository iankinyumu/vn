
/* assets/js/index.js - 2026 Live Crypto Dashboard
 *
 * The ticker's pair list comes from the market registry (window.SmartProfitMarkets
 * -> list_market_catalog) through market-ticker.js. The fifteen-row array of
 * invented prices that used to sit here is gone: this page can no longer quote a
 * BTC price the exchange never traded at.
 */
document.addEventListener('DOMContentLoaded', async function () {
    const track = document.getElementById('tickerTrack');
    if (!track || !window.SmartProfitTicker) return;
    let client = null;
    try { client = await window.getSupabaseClient(); } catch (_) { /* catalogue is public; leave client null */ }
    await window.SmartProfitTicker.mount({ track, client });
});

const ctx = document.getElementById('mainChart');
if (ctx && typeof Chart !== 'undefined') {
    let chartInstance = null;
    const marketState = document.getElementById('marketState');

    /* This widget is deliberately BTC-only: it is a single-asset summary card, not
     * a pair explorer. It is labelled as such in the markup so nobody reads it as
     * tracking the pair they selected on the trade page.
     *
     * The public mirror is tried first because api.binance.com is region-blocked
     * from some networks; the primary host stays as a fallback. */
    const DAILY_KLINES_URLS = [
        'https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=30',
        'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=30'
    ];

    async function initDashboardChart() {
        let prices = [];
        let labels = [];

        for (const url of DAILY_KLINES_URLS) {
            try {
                const res = await fetch(url);
                if (!res.ok) continue;
                const klines = await res.json();
                prices = klines.map(k => parseFloat(k[4]));
                labels = klines.map((_, i) => (i === klines.length - 1 ? 'Today' : `${klines.length - 1 - i}d ago`));
                break;
            } catch (e) {
                console.warn('Daily kline host unavailable, trying the next one:', url, e.message);
            }
        }

        if (prices.length === 0) {
            // Nothing is invented to fill the gap: the card says it is unavailable.
            console.warn('Daily BTC klines are unavailable from every host; the chart will stay empty.');
            if (marketState) marketState.textContent = 'Unavailable';
            return;
        }

        if (marketState) marketState.textContent = 'Live';

        const gradient = ctx.getContext('2d').createLinearGradient(0, 0, 0, 350);
        gradient.addColorStop(0, 'rgba(99, 102, 241, 0.35)');
        gradient.addColorStop(1, 'rgba(99, 102, 241, 0)');

        chartInstance = new Chart(ctx, {
            type: 'line',
            data: {
                labels,
                datasets: [{
                    label: 'BTC/USDT',
                    data: prices,
                    borderColor: '#818cf8',
                    backgroundColor: gradient,
                    borderWidth: 2,
                    tension: 0.35,
                    fill: true,
                    pointRadius: 0,
                    pointHoverRadius: 6,
                    pointHoverBackgroundColor: '#818cf8',
                    pointHoverBorderColor: '#fff',
                    pointHoverBorderWidth: 2
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { intersect: false, mode: 'index' },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: 'rgba(15, 20, 45, 0.95)',
                        titleColor: '#94a3b8',
                        bodyColor: '#f1f5f9',
                        borderColor: 'rgba(255, 255, 255, 0.1)',
                        borderWidth: 1,
                        padding: 12,
                        displayColors: false,
                        callbacks: {
                            label: function (c) { return '$' + c.parsed.y.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
                        }
                    }
                },
                scales: {
                    x: {
                        grid: { color: 'rgba(255, 255, 255, 0.03)' },
                        ticks: { color: '#94a3b8', font: { size: 10 }, maxTicksLimit: 8 }
                    },
                    y: {
                        grid: { color: 'rgba(255, 255, 255, 0.03)' },
                        ticks: {
                            color: '#94a3b8',
                            font: { size: 10 },
                            callback: function (v) { return '$' + v.toLocaleString(); }
                        }
                    }
                }
            }
        });

        // Live Binance Ticker WS update to last point in chart
        try {
            const ws = new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@ticker');
            ws.onmessage = function (event) {
                const d = JSON.parse(event.data);
                if (d && d.c && chartInstance) {
                    const latestPrice = parseFloat(d.c);
                    const ds = chartInstance.data.datasets[0];
                    if (ds && ds.data.length > 0) {
                        ds.data[ds.data.length - 1] = latestPrice;
                        chartInstance.update('none');
                    }
                }
            };
        } catch (err) {
            console.warn('Dashboard WS error:', err);
        }
    }

    initDashboardChart();
}
