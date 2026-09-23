(function () {
    const messages = Object.freeze({ account_not_available: 'This account is not available.', real_disabled: 'Real accounts are not available yet.', module_disabled: 'Digit contracts are not available.', trading_restricted: 'Trading is restricted for this account.', restricted_limit_exceeded: 'This trade exceeds an active restriction or account limit.', access_restricted: 'Access to this account is restricted.', feed_stale: 'The price feed is stale. Wait for it to reconnect.', exposure_limit: 'This trade exceeds the current exposure limit.', limits_not_configured: 'Trading limits are not configured for this account.', idempotency_conflict: 'This purchase request conflicts with an earlier request.', insufficient_funds: 'Your practice balance is insufficient.', invalid_contract_parameters: 'Choose valid contract details.', profit_too_low: 'This stake does not meet the minimum payout requirement.', invalid_stake: 'Enter a valid stake.', stake_below_minimum: 'The stake is below the minimum.', stake_above_maximum: 'The stake exceeds the maximum.', invalid_tick_count: 'Choose between one and ten ticks.', rate_limit_exceeded: 'Too many purchase attempts. Please wait a moment.', rate_limited: 'Too many purchase attempts. Please wait a moment.', contract_type_disabled: 'This contract type is unavailable.', index_not_available: 'This index is unavailable.', max_open_contracts: 'You have reached the open-contract limit.' });
    const codeOf = (error) => String(error?.message || error?.code || '').match(/[a-z_]+/)?.[0];
    const uuid = () => window.crypto.randomUUID();
    // get_recent_ticks and get_ticks_since return at most PAGE_SIZE rows per call.
    const PAGE_SIZE = 500;
    const MAX_TICKS = 1000;
    const feedLabels = Object.freeze({ live: 'Live', polling: 'Live · polling', stale: 'Reconnecting' });
    function report(error) { const status = document.querySelector('[data-trade-status]'); const code = codeOf(error); if (messages[code]) status.textContent = messages[code]; else { const reference = uuid().slice(0, 8); status.textContent = `Something went wrong. Reference: ${reference}.`; console.error(reference, error); } }
    function contractRow(contract, latestTick) { const row = document.createElement('tr'); const remaining = contract.state === 'OPEN' ? Math.max(0, Number(contract.settle_tick_no) - latestTick) : '—'; row.innerHTML = `<td>${contract.index_code}</td><td>${contract.contract_type}</td><td>${contract.state}</td><td>${remaining}</td><td>${contract.payout ?? '—'}</td>`; return row; }

    /* One tick stream for one (mode, index). Ticks are kept ordered by tick_no with
       no gaps or duplicates: the next broadcast tick is appended, a jump is
       reconciled through get_ticks_since, and anything already held is ignored.
       Every read is serialized so a broadcast can never race a reconcile. While
       the private channel is not SUBSCRIBED, or is subscribed but has gone quiet
       for three intervals, the feed polls once per interval so the chart and the
       Buy button recover without a reload. close() discards all late results. */
    function createTickFeed({ client, mode, index, interval, onTicks, onState, onError }) {
        const ticks = [];
        let channel = null, pollTimer = null, staleTimer = null, queue = Promise.resolve();
        let closed = false, subscribed = false, fresh = false;
        const last = () => (ticks.length ? ticks[ticks.length - 1].tick_no : 0);
        const normalize = (row) => ({ index_code: row.index_code, tick_no: Number(row.tick_no), scheduled_at: row.scheduled_at, price: row.price, digit: Number(row.digit) });
        const state = () => (!fresh ? 'stale' : subscribed ? 'live' : 'polling');
        async function rpc(name, args) { const { data, error } = await client.rpc(name, args); if (error) throw error; return data || []; }
        function append(rows) {
            rows.map(normalize).sort((a, b) => a.tick_no - b.tick_no).forEach((tick) => { if (tick.tick_no > last()) ticks.push(tick); });
            if (ticks.length > MAX_TICKS) ticks.splice(0, ticks.length - MAX_TICKS);
        }
        async function pageFrom(after) {
            for (;;) {
                const page = await rpc('get_ticks_since', { p_index: index, p_after_tick_no: after, p_limit: PAGE_SIZE });
                if (closed) return;
                append(page);
                if (page.length < PAGE_SIZE) return;
                after = Number(page[page.length - 1].tick_no);
            }
        }
        async function loadLatest() {
            const latest = await rpc('get_recent_ticks', { p_index: index, p_limit: 1 });
            if (closed || !latest.length) return;
            ticks.length = 0;
            await pageFrom(Math.max(0, Number(latest[0].tick_no) - MAX_TICKS));
        }
        function armStaleGuard() {
            clearTimeout(staleTimer);
            staleTimer = setTimeout(() => { fresh = false; syncPolling(); onState(state()); }, interval * 3);
        }
        function serial(task) {
            queue = queue.then(async () => {
                if (closed) return;
                const before = last();
                await task();
                if (closed || last() === before) return;
                fresh = true;
                armStaleGuard();
                syncPolling();
                onTicks(ticks);
                onState(state());
            }).catch((error) => { if (!closed) onError(error); });
            return queue;
        }
        const catchUp = () => serial(() => (last() ? pageFrom(last()) : loadLatest()));
        function receive(payload) {
            const tick = normalize(payload);
            serial(async () => {
                const current = last();
                if (tick.tick_no <= current) return;
                if (current && tick.tick_no === current + 1) { append([tick]); return; }
                if (!current || tick.tick_no - current > MAX_TICKS) await loadLatest();
                else await pageFrom(current);
                if (!closed && tick.tick_no === last() + 1) append([tick]);
            });
        }
        function setPolling(on) {
            if (on && !pollTimer && !closed) pollTimer = setInterval(catchUp, interval);
            if (!on && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        }
        const syncPolling = () => setPolling(!subscribed || !fresh);
        async function open() {
            syncPolling();
            await serial(loadLatest);
            if (closed) return;
            if (!ticks.length) onState(state());
            // Private broadcasts only reach private channels whose socket carries the user's JWT.
            await client.realtime.setAuth();
            if (closed) return;
            channel = client.channel(`ticks:${mode.toLowerCase()}:${index}`, { config: { private: true } })
                .on('broadcast', { event: 'tick' }, ({ payload }) => receive(payload))
                .subscribe((status) => {
                    if (closed) return;
                    subscribed = status === 'SUBSCRIBED';
                    syncPolling();
                    onState(state());
                    if (subscribed) catchUp();
                });
        }
        function close() {
            closed = true;
            setPolling(false);
            clearTimeout(staleTimer);
            if (channel) client.removeChannel(channel);
            channel = null;
        }
        return { open, close, ticks, last };
    }

    async function start() {
        const { client, config } = await window.initAccountSwitcher();
        const form = document.querySelector('[data-trade-form]'); const index = form.index; const type = form.type; const barrier = form.barrier;
        const submit = form.querySelector('[type="submit"]');
        let feed = null; let contractChannel = null; let contracts = []; let refreshedAtTick = 0; let intent = ''; let idempotencyKey = ''; let quoteTimer;
        const account = () => window.smartProfitAccount.get();
        const latestTick = () => feed?.last() || 0;
        const fields = () => ({ p_account_id: account().accountId, p_index: index.value, p_type: type.value, p_barrier: barrier.hidden ? null : Number(barrier.value), p_stake: Number(form.stake.value), p_tick_count: Number(form.ticks.value) });
        const intentValue = () => [index.value, type.value, barrier.hidden ? '' : barrier.value, form.stake.value, form.ticks.value].join(':');
        const updateBarrier = () => { barrier.closest('label').hidden = ['EVEN', 'ODD'].includes(type.value); barrier.hidden = ['EVEN', 'ODD'].includes(type.value); barrier.required = !barrier.hidden; };
        const draw = (ticks) => { const current = ticks[ticks.length - 1]; if (!current) return; const option = index.selectedOptions[0]; const decimals = Number(option.dataset.decimals); const price = Number(current.price).toFixed(decimals); document.querySelector('[data-live-price]').innerHTML = `${price.slice(0, -1)}<strong>${price.at(-1)}</strong>`; document.querySelector('[data-digits]').replaceChildren(...ticks.slice(-20).map((tick) => { const node = document.createElement('span'); node.className = tick.digit % 2 ? 'odd' : 'even'; node.textContent = tick.digit; return node; })); [100, 1000].forEach((limit) => { const counts = Array(10).fill(0); ticks.slice(-limit).forEach((tick) => counts[tick.digit]++); const max = Math.max(...counts, 1); document.querySelector(`[data-frequency="${limit}"]`).replaceChildren(...counts.map((count, digit) => { const node = document.createElement('span'); node.style.height = `${Math.max(5, count / max * 100)}%`; node.setAttribute('aria-label', `Digit ${digit}: ${count}`); return node; })); }); window.drawIndexChart(document.querySelector('[data-index-chart]'), ticks); };
        const setFeedState = (state) => { document.querySelector('[data-feed-state]').textContent = feedLabels[state]; submit.disabled = state === 'stale'; };
        const renderContracts = () => { const tick = latestTick(); document.querySelector('[data-open-contracts]').replaceChildren(...contracts.filter((item) => item.state === 'OPEN').map((item) => contractRow(item, tick))); document.querySelector('[data-settled-contracts]').replaceChildren(...contracts.filter((item) => item.state !== 'OPEN').map((item) => contractRow(item, tick))); };
        const loadContracts = async () => { const accountId = account().accountId; const { data, error } = await client.rpc('list_my_contracts', { p_account_id: accountId, p_state: null, p_before: null, p_limit: 50 }); if (error) throw error; if (accountId !== account().accountId) return; contracts = data || []; refreshedAtTick = latestTick(); renderContracts(); };
        // Results normally arrive through the contract change subscription; an open contract whose settle tick has
        // already been published is re-read once per tick so a missed change event cannot leave it stale on screen.
        const onTicks = (ticks) => { draw(ticks); renderContracts(); const tick = latestTick(); if (tick > refreshedAtTick && contracts.some((item) => item.state === 'OPEN' && Number(item.settle_tick_no) <= tick)) { refreshedAtTick = tick; loadContracts().catch(report); } };
        const quote = async () => { if (!form.checkValidity() || !index.value || !type.value) return; const { data, error } = await client.rpc('engine_quote_contract', fields()); if (error) { report(error); return; } document.querySelector('[data-quote]').textContent = `Payout ${data.payout} · Profit ${data.profit} · Win probability ${(Number(data.win_probability) * 100).toFixed(0)}%`; };
        const teardown = () => { feed?.close(); feed = null; if (contractChannel) client.removeChannel(contractChannel); contractChannel = null; };
        const subscribe = async () => {
            teardown();
            contracts = []; refreshedAtTick = 0; setFeedState('stale');
            const active = account();
            feed = createTickFeed({ client, mode: active.mode, index: index.value, interval: Number(index.selectedOptions[0].dataset.interval), onTicks, onState: setFeedState, onError: report });
            const opening = feed;
            await opening.open();
            if (opening !== feed) return;
            await loadContracts();
            if (opening !== feed) return;
            contractChannel = client.channel(`contracts:${active.accountId}`).on('postgres_changes', { event: '*', schema: 'public', table: 'engine_contracts', filter: `trading_account_id=eq.${active.accountId}` }, () => loadContracts().catch(report)).subscribe();
        };
        (config.indices || []).forEach((item) => { const option = new Option(item.display_name || item.code, item.code); option.dataset.interval = item.interval_ms; option.dataset.decimals = item.decimals; index.add(option); }); (config.enabled_contract_types || []).forEach((item) => type.add(new Option(item, item))); updateBarrier();
        const changed = () => { updateBarrier(); const next = intentValue(); if (next !== intent) { intent = next; idempotencyKey = uuid(); } clearTimeout(quoteTimer); quoteTimer = setTimeout(quote, 200); }; form.addEventListener('input', changed); form.addEventListener('change', changed); index.addEventListener('change', () => subscribe().catch(report));
        form.addEventListener('submit', async (event) => { event.preventDefault(); try { if (!idempotencyKey) { intent = intentValue(); idempotencyKey = uuid(); } const args = fields(); const bought = await client.rpc('engine_buy_contract', { ...args, p_idempotency_key: idempotencyKey }); if (bought.error) throw bought.error; document.querySelector('[data-trade-status]').textContent = 'Contract purchased.'; await loadContracts(); } catch (error) { report(error); } });
        document.addEventListener('smartprofit:clear-trade-state', () => { form.reset(); teardown(); contracts = []; clearTimeout(quoteTimer); idempotencyKey = ''; }); document.addEventListener('smartprofit:account-changed', () => subscribe().catch(report));
        await subscribe(); await window.refreshRestrictionBanner();
    }
    window.addEventListener('DOMContentLoaded', () => start().catch(report)); window.smartProfitTrade = { errorMessages: messages };
})();
