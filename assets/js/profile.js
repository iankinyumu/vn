/* assets/js/profile.js - account page.
 *
 * The ticker's pair list comes from the market registry (window.SmartProfitMarkets
 * -> list_market_catalog) through market-ticker.js. The hardcoded fifteen-coin
 * array of invented prices that used to be here is gone.
 */
document.addEventListener('DOMContentLoaded', async function () {
    const track = document.getElementById('tickerTrack');
    if (!track || !window.SmartProfitTicker) return;
    let client = null;
    try { client = await window.getSupabaseClient(); } catch (_) { /* catalogue is public; leave client null */ }
    await window.SmartProfitTicker.mount({ track, client });
});

function switchTab(tabName) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.querySelector(`[onclick="switchTab('${tabName}')"]`).classList.add('active');
    document.getElementById('tab-' + tabName).classList.add('active');
}
