
/* assets/js/index.js - 2026 Live Crypto Dashboard */
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

const track = document.getElementById('tickerTrack');
if (track) {
    track.innerHTML = '';
    coins.forEach(c => {
        const cl = c.change >= 0 ? 'positive' : 'negative';
        const s = c.change >= 0 ? '+' : '';
        track.innerHTML += `<div class="ticker-item"><span class="ticker-pair">${c.name}/USDT</span><span class="ticker-price">$${c.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span><span class="ticker-change ${cl}">${s}${c.change}%</span></div>`;
    });
    track.innerHTML += track.innerHTML;
}

const ctx = document.getElementById('mainChart');
if (ctx && typeof Chart !== 'undefined') {
    let chartInstance = null;
    const marketState = document.getElementById('marketState');

    async function initDashboardChart() {
        let prices = [];
        let labels = [];

        try {
            const res = await fetch('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=30');
            if (res.ok) {
                const klines = await res.json();
                prices = klines.map(k => parseFloat(k[4]));
                labels = klines.map((_, i) => (i === klines.length - 1 ? 'Today' : `${klines.length - 1 - i}d ago`));
            }
        } catch (e) {
            console.warn('Could not fetch Binance daily klines, using simulated seed:', e.message);
        }

        if (prices.length === 0) {
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
