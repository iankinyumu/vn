const coins = [{ name: 'BTC', price: 67845.32, change: 2.45 }, { name: 'ETH', price: 3567.21, change: 1.89 }, { name: 'BNB', price: 598.45, change: -0.78 }, { name: 'SOL', price: 142.78, change: 5.32 }, { name: 'ADA', price: 0.6234, change: -1.23 }, { name: 'XRP', price: 0.5234, change: 3.45 }, { name: 'DOGE', price: 0.1234, change: 8.90 }, { name: 'DOT', price: 7.89, change: -2.34 }, { name: 'AVAX', price: 34.56, change: 1.67 }, { name: 'MATIC', price: 0.89, change: -0.45 }, { name: 'LINK', price: 14.56, change: 4.56 }, { name: 'UNI', price: 7.23, change: 2.34 }, { name: 'ATOM', price: 9.78, change: -1.89 }, { name: 'LTC', price: 78.90, change: 0.67 }, { name: 'NEAR', price: 5.67, change: 12.34 }];
const track = document.getElementById('tickerTrack');
coins.forEach(c => { const cl = c.change >= 0 ? 'positive' : 'negative'; const s = c.change >= 0 ? '+' : ''; track.innerHTML += `<div class="ticker-item"><span class="ticker-pair">${c.name}/USDT</span><span class="ticker-price">$${c.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span><span class="ticker-change ${cl}">${s}${c.change}%</span></div>` });
track.innerHTML += track.innerHTML;

function switchTab(tabName) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.querySelector(`[onclick="switchTab('${tabName}')"]`).classList.add('active');
    document.getElementById('tab-' + tabName).classList.add('active');
}