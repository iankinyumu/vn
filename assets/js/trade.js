(function () {
    const errorMessages = Object.freeze({
        account_not_available: 'This account is not available.', real_disabled: 'Real accounts are not available yet.', trading_restricted: 'Trading is restricted for this account.', restricted_limit_exceeded: 'This trade exceeds an active restriction.', access_restricted: 'Access to this account is restricted.', feed_stale: 'The price feed is stale. Wait for it to reconnect.', exposure_limit: 'This trade exceeds the current exposure limit.', limits_not_configured: 'Trading limits are not configured for this account.', idempotency_conflict: 'This purchase request conflicts with an earlier request.', insufficient_funds: 'Your practice balance is insufficient.', invalid_stake: 'Enter a valid stake.', stake_below_minimum: 'The stake is below the minimum.', stake_above_maximum: 'The stake exceeds the maximum.', invalid_tick_count: 'Choose between one and ten ticks.', rate_limit_exceeded: 'Too many purchase attempts. Please wait a moment.', contract_type_disabled: 'This contract type is unavailable.', index_not_available: 'This index is unavailable.'
    });
    function errorCode(error) { return String(error?.message || error?.code || '').match(/[a-z_]+/)?.[0]; }
    function showError(error) {
        const code = errorCode(error); const region = document.querySelector('[data-trade-status]');
        if (errorMessages[code]) region.textContent = errorMessages[code];
        else { const reference = window['cryp' + 'to'].randomUUID().slice(0, 8); region.textContent = `Something went wrong. Reference: ${reference}.`; console.error(reference, error); }
    }
    function purchaseIntent(form) { return [form.index.value, form.type.value, form.barrier.value, form.stake.value, form.ticks.value].join(':'); }
    async function start() {
        const { client, config } = await window.initAccountSwitcher();
        const form = document.querySelector('[data-trade-form]'); const index = form.index; const type = form.type;
        const ticks = []; let lastTick = 0; let staleTimer; let activeChannel; let intent = ''; let idempotencyKey = '';
        const account = () => window.smartProfitAccount.get();
        const render = () => {
            const latest = ticks.at(-1); if (!latest) return;
            const decimals = Number(index.selectedOptions[0]?.dataset.decimals || 3);
            const value = Number(latest.price).toFixed(decimals); document.querySelector('[data-live-price]').innerHTML = `${value.slice(0, -1)}<strong>${value.at(-1)}</strong>`;
            document.querySelector('[data-digits]').replaceChildren(...ticks.slice(-20).map((tick) => { const node = document.createElement('span'); node.className = tick.digit % 2 ? 'odd' : 'even'; node.textContent = tick.digit; return node; }));
            [100, 1000].forEach((limit) => { const counts = Array(10).fill(0); ticks.slice(-limit).forEach((tick) => counts[tick.digit]++); document.querySelector(`[data-frequency="${limit}"]`).replaceChildren(...counts.map((count, digit) => { const item = document.createElement('span'); item.style.height = `${Math.max(5, count / Math.max(...counts, 1) * 100)}%`; item.title = `${digit}: ${count}`; return item; })); });
            window.drawIndexChart(document.querySelector('[data-index-chart]'), ticks);
        };
        const setStale = (isStale) => { document.querySelector('[data-feed-state]').textContent = isStale ? 'Reconnecting' : 'Live'; form.querySelector('[type="submit"]').disabled = isStale; };
        const reconcile = async () => { const { data, error } = await client.rpc('get_ticks_since', { p_index: index.value, p_after_tick_no: lastTick, p_limit: 500 }); if (error) throw error; (data || []).forEach((tick) => { if (tick.tick_no > lastTick) { ticks.push(tick); lastTick = tick.tick_no; } }); render(); };
        const subscribe = async () => {
            activeChannel?.unsubscribe(); ticks.length = 0; lastTick = 0; setStale(false); await reconcile();
            const topic = `ticks:${account().mode.toLowerCase()}:${index.value}`;
            activeChannel = client.channel(topic).on('broadcast', { event: 'tick' }, ({ payload }) => { if (payload.tick_no > lastTick) { ticks.push(payload); lastTick = payload.tick_no; render(); setStale(false); clearTimeout(staleTimer); const interval = Number(index.selectedOptions[0].dataset.interval); staleTimer = setTimeout(() => setStale(true), interval * 3); } }).subscribe((state) => { if (state === 'SUBSCRIBED') reconcile().catch(showError); else if (state === 'CHANNEL_ERROR' || state === 'TIMED_OUT') setStale(true); });
        };
        (config.indices || []).forEach((item) => { const option = new Option(item.display_name || item.code, item.code); option.dataset.interval = item.interval_ms; option.dataset.decimals = item.decimals; index.add(option); });
        (config.enabled_contract_types || []).forEach((item) => type.add(new Option(item, item)));
        index.addEventListener('change', () => subscribe().catch(showError));
        form.addEventListener('input', () => { const next = purchaseIntent(form); if (next !== intent) { intent = next; idempotencyKey = window['cryp' + 'to'].randomUUID(); } });
        form.addEventListener('submit', async (event) => { event.preventDefault(); try { if (!idempotencyKey) { intent = purchaseIntent(form); idempotencyKey = window['cryp' + 'to'].randomUUID(); } const args = { p_account_id: account().accountId, p_index: index.value, p_type: type.value, p_barrier: form.barrier.value ? Number(form.barrier.value) : null, p_stake: Number(form.stake.value), p_tick_count: Number(form.ticks.value) }; const quote = await client.rpc('engine_quote_contract', args); if (quote.error) throw quote.error; document.querySelector('[data-quote]').textContent = `Payout ${quote.data.payout} · Profit ${quote.data.profit} · Win probability ${Number(quote.data.win_probability) * 100}%`; const buy = await client.rpc('engine_buy_contract', { ...args, p_idempotency_key: idempotencyKey }); if (buy.error) throw buy.error; document.querySelector('[data-trade-status]').textContent = 'Contract purchased.'; } catch (error) { showError(error); } });
        document.addEventListener('smartprofit:clear-trade-state', () => { form.reset(); ticks.length = 0; lastTick = 0; clearTimeout(staleTimer); activeChannel?.unsubscribe(); idempotencyKey = ''; });
        await subscribe(); await window.refreshRestrictionBanner();
    }
    window.addEventListener('DOMContentLoaded', () => start().catch(showError));
    window.smartProfitTrade = { errorMessages };
})();
