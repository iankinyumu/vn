/* assets/js/main.js - 2026 Live Crypto Dashboard */
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


