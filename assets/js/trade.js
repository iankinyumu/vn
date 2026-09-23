(function () {
    const messages = Object.freeze({ account_not_available: 'This account is not available.', real_disabled: 'Real accounts are not available yet.', module_disabled: 'Digit contracts are not available.', trading_restricted: 'Trading is restricted for this account.', restricted_limit_exceeded: 'This trade exceeds an active restriction or account limit.', access_restricted: 'Access to this account is restricted.', feed_stale: 'The price feed is stale. Wait for it to reconnect.', exposure_limit: 'This trade exceeds the current exposure limit.', limits_not_configured: 'Trading limits are not configured for this account.', idempotency_conflict: 'This purchase request conflicts with an earlier request.', insufficient_funds: 'Your practice balance is insufficient.', invalid_contract_parameters: 'Choose valid contract details.', profit_too_low: 'This stake does not meet the minimum payout requirement.', invalid_stake: 'Enter a valid stake.', stake_below_minimum: 'The stake is below the minimum.', stake_above_maximum: 'The stake exceeds the maximum.', invalid_tick_count: 'Choose between one and ten ticks.', rate_limit_exceeded: 'Too many purchase attempts. Please wait a moment.', rate_limited: 'Too many purchase attempts. Please wait a moment.', contract_type_disabled: 'This contract type is unavailable.', index_not_available: 'This index is unavailable.', max_open_contracts: 'You have reached the open-contract limit.' });
    const codeOf = (error) => String(error?.message || error?.code || '').match(/[a-z_]+/)?.[0];
    const uuid = () => window.crypto.randomUUID();
    // get_recent_ticks and get_ticks_since return at most PAGE_SIZE rows per call.
    const PAGE_SIZE = 500;
    const MAX_TICKS = 1000;
    const feedLabels = Object.freeze({ loading: 'Loading', live: 'Live', polling: 'Live · polling', stale: 'Reconnecting', empty: 'No ticks yet', unavailable: 'Unavailable' });
    const TYPE_LABELS = Object.freeze({ EVEN: 'Even', ODD: 'Odd', MATCH: 'Matches', DIFFER: 'Differs', OVER: 'Over', UNDER: 'Under' });
    const FAMILIES = Object.freeze([['Even / Odd', ['EVEN', 'ODD']], ['Matches / Differs', ['MATCH', 'DIFFER']], ['Over / Under', ['OVER', 'UNDER']]]);
    // While the index list or contract types are missing, the page re-reads the configuration on this cadence.
    // A page (or a test) may shorten it through window.smartProfitTradeOptions.configRetryMs.
    const CONFIG_RETRY_MS = 30000;
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
        const state = () => (!fresh ? (ticks.length ? 'stale' : 'empty') : subscribed ? 'live' : 'polling');
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
            // An index with no published ticks is reported as such, never as live; polling keeps checking.
            if (!ticks.length) onState('empty');
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
        const form = document.querySelector('[data-trade-form]'); const index = form.index; const type = form.type; const barrier = form.barrier;
        const submit = form.querySelector('[type="submit"]');
        const status = document.querySelector('[data-trade-status]');
        const familyHost = document.querySelector('[data-contract-family]');
        const balance = document.querySelector('[data-trade-balance]');
        const setFeedLabel = (state) => { document.querySelector('[data-feed-state]').textContent = feedLabels[state]; };
        let setup;
        try { setup = await window.initAccountSwitcher(); } catch (error) {
            // Startup failed before any account or configuration existed: say so and leave nothing buyable.
            status.textContent = window.smartProfitStartup?.message(error) || 'Trading is unavailable right now. Reload the page to try again.';
            setFeedLabel('unavailable');
            submit.disabled = true;
            for (const select of [index, type]) { select.replaceChildren(new Option('Unavailable', '')); select.disabled = true; }
            familyHost?.replaceChildren(Object.assign(document.createElement('p'), { textContent: 'Contract types are unavailable until the page loads.' }));
            if (balance) balance.textContent = 'Unavailable';
            return;
        }
        const { client } = setup;
        let config = setup.config;
        let feed = null; let feedState = 'loading'; let contractChannel = null; let contracts = []; let refreshedAtTick = 0; let intent = ''; let idempotencyKey = ''; let quoteTimer; let retryTimer;
        const account = () => window.smartProfitAccount.get();
        const latestTick = () => feed?.last() || 0;
        const fields = () => ({ p_account_id: account().accountId, p_index: index.value, p_type: type.value, p_barrier: barrier.hidden ? null : Number(barrier.value), p_stake: Number(form.stake.value), p_tick_count: Number(form.ticks.value) });
        const intentValue = () => [index.value, type.value, barrier.hidden ? '' : barrier.value, form.stake.value, form.ticks.value].join(':');
        const updateBarrier = () => { const none = !type.value || ['EVEN', 'ODD'].includes(type.value); barrier.closest('label').hidden = none; barrier.hidden = none; barrier.required = !none; };
        // Buy needs a live (or polling) feed, a configured index and an enabled contract type.
        const updateBuy = () => { submit.disabled = !['live', 'polling'].includes(feedState) || !index.value || !type.value; };
        const syncFamilies = () => familyHost?.querySelectorAll('[data-contract-type]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.contractType === type.value)));
        const draw = (ticks) => { const current = ticks[ticks.length - 1]; if (!current) return; const option = index.selectedOptions[0]; const decimals = Number(option.dataset.decimals); const price = Number(current.price).toFixed(decimals); document.querySelector('[data-live-price]').innerHTML = `${price.slice(0, -1)}<strong>${price.at(-1)}</strong>`; document.querySelector('[data-digits]').replaceChildren(...ticks.slice(-20).map((tick) => { const node = document.createElement('span'); node.className = tick.digit % 2 ? 'odd' : 'even'; node.textContent = tick.digit; return node; })); [100, 1000].forEach((limit) => { const counts = Array(10).fill(0); ticks.slice(-limit).forEach((tick) => counts[tick.digit]++); const max = Math.max(...counts, 1); document.querySelector(`[data-frequency="${limit}"]`).replaceChildren(...counts.map((count, digit) => { const node = document.createElement('span'); node.style.height = `${Math.max(5, count / max * 100)}%`; node.setAttribute('aria-label', `Digit ${digit}: ${count}`); return node; })); }); window.drawIndexChart(document.querySelector('[data-index-chart]'), ticks); };
        const setFeedState = (state) => {
            feedState = state;
            setFeedLabel(state);
            if (state === 'empty') document.querySelector('[data-live-price]').textContent = 'No ticks published yet';
            updateBuy();
        };
        const loadBalance = async () => {
            if (!balance) return;
            const accountId = account().accountId;
            const { data, error } = await client.rpc('get_account_summary', { p_account_id: accountId });
            if (accountId !== account().accountId) return;
            if (error || !data) { if (error) console.error('[smartprofit] balance could not be loaded', { code: error.code ?? null, message: error.message }); balance.textContent = 'Balance unavailable'; return; }
            balance.textContent = `${data.currency} ${Number(data.available).toFixed(2)}`;
        };
        const renderContracts = () => { const tick = latestTick(); document.querySelector('[data-open-contracts]').replaceChildren(...contracts.filter((item) => item.state === 'OPEN').map((item) => contractRow(item, tick))); document.querySelector('[data-settled-contracts]').replaceChildren(...contracts.filter((item) => item.state !== 'OPEN').map((item) => contractRow(item, tick))); };
        // A contract change (purchase or settlement) also moves the balance, so both are re-read together.
        const loadContracts = async () => { const accountId = account().accountId; const [{ data, error }] = await Promise.all([client.rpc('list_my_contracts', { p_account_id: accountId, p_state: null, p_before: null, p_limit: 50 }), loadBalance()]); if (error) throw error; if (accountId !== account().accountId) return; contracts = data || []; refreshedAtTick = latestTick(); renderContracts(); };
        // Results normally arrive through the contract change subscription; an open contract whose settle tick has
        // already been published is re-read once per tick so a missed change event cannot leave it stale on screen.
        const onTicks = (ticks) => { draw(ticks); renderContracts(); const tick = latestTick(); if (tick > refreshedAtTick && contracts.some((item) => item.state === 'OPEN' && Number(item.settle_tick_no) <= tick)) { refreshedAtTick = tick; loadContracts().catch(report); } };
        const quote = async () => { if (!form.checkValidity() || !index.value || !type.value) return; const { data, error } = await client.rpc('engine_quote_contract', fields()); if (error) { report(error); return; } document.querySelector('[data-quote]').textContent = `${TYPE_LABELS[type.value] || type.value}: payout ${data.payout} · profit ${data.profit} · win probability ${(Number(data.win_probability) * 100).toFixed(0)}%`; };
        const teardown = () => { feed?.close(); feed = null; if (contractChannel) client.removeChannel(contractChannel); contractChannel = null; };
        const subscribe = async () => {
            teardown();
            contracts = []; refreshedAtTick = 0;
            if (balance) balance.textContent = '—';
            document.querySelector('[data-live-price]').textContent = '—';
            if (!index.value) { setFeedState('unavailable'); return; }
            setFeedState('loading');
            const active = account();
            feed = createTickFeed({ client, mode: active.mode, index: index.value, interval: Number(index.selectedOptions[0].dataset.interval), onTicks, onState: setFeedState, onError: report });
            const opening = feed;
            await opening.open();
            if (opening !== feed) return;
            await loadContracts();
            if (opening !== feed) return;
            contractChannel = client.channel(`contracts:${active.accountId}`).on('postgres_changes', { event: '*', schema: 'public', table: 'engine_contracts', filter: `trading_account_id=eq.${active.accountId}` }, () => loadContracts().catch(report)).subscribe();
        };
        // Contract-type choices come only from the live policy; types the policy does not enable are shown as not offered and cannot be selected.
        function renderFamilies(enabled) {
            if (!familyHost) return;
            if (!enabled.length) { familyHost.replaceChildren(Object.assign(document.createElement('p'), { textContent: 'No contract types are enabled right now.' })); return; }
            familyHost.replaceChildren(...FAMILIES.map(([title, types]) => {
                const group = document.createElement('div');
                group.className = 'family-group';
                group.append(Object.assign(document.createElement('span'), { textContent: title }));
                const choices = document.createElement('div');
                choices.className = 'family-choices';
                choices.append(...types.map((code) => {
                    const button = document.createElement('button');
                    button.type = 'button';
                    button.className = 'family-choice';
                    button.dataset.contractType = code;
                    button.textContent = TYPE_LABELS[code];
                    if (enabled.includes(code)) {
                        button.addEventListener('click', () => { type.value = code; type.dispatchEvent(new Event('change', { bubbles: true })); });
                    } else {
                        button.disabled = true;
                        button.title = 'Not offered under the current policy';
                        button.append(Object.assign(document.createElement('small'), { textContent: 'Not offered' }));
                    }
                    return button;
                }));
                group.append(choices);
                return group;
            }));
            syncFamilies();
        }
        // Applies a configuration; returns whether it has at least one index and one enabled contract type.
        function applyConfig(next) {
            const selected = index.value;
            const indices = next.indices || [];
            const enabled = (next.enabled_contract_types || []).filter((code) => TYPE_LABELS[code]);
            index.replaceChildren(...indices.map((item) => { const option = new Option(item.display_name || item.code, item.code); option.dataset.interval = item.interval_ms; option.dataset.decimals = item.decimals; return option; }));
            type.replaceChildren(...enabled.map((code) => new Option(TYPE_LABELS[code], code)));
            index.disabled = !indices.length;
            type.disabled = !enabled.length;
            // The dashboard links to trade.html?index=CODE; an unknown code keeps the first index.
            const requested = selected || new URLSearchParams(window.location.search).get('index');
            if (requested && indices.some((item) => item.code === requested)) index.value = requested;
            renderFamilies(enabled);
            updateBarrier();
            updateBuy();
            if (!indices.length) status.textContent = 'No indices are open for trading right now. This page checks again automatically.';
            else if (!enabled.length) status.textContent = 'No contract types are enabled right now. This page checks again automatically.';
            else if (/checks again automatically/.test(status.textContent)) status.textContent = '';
            return indices.length > 0 && enabled.length > 0;
        }
        function retryConfig() {
            clearTimeout(retryTimer);
            retryTimer = setTimeout(async () => {
                try {
                    config = (await window.loadEngineConfig({ refresh: true })).config;
                    if (applyConfig(config)) await subscribe(); else retryConfig();
                } catch (error) { window.smartProfitStartup?.log(error); retryConfig(); }
            }, window.smartProfitTradeOptions?.configRetryMs ?? CONFIG_RETRY_MS);
        }
        const changed = () => { updateBarrier(); syncFamilies(); updateBuy(); const next = intentValue(); if (next !== intent) { intent = next; idempotencyKey = uuid(); } clearTimeout(quoteTimer); quoteTimer = setTimeout(quote, 200); }; form.addEventListener('input', changed); form.addEventListener('change', changed); index.addEventListener('change', () => subscribe().catch(report));
        form.addEventListener('submit', async (event) => { event.preventDefault(); if (submit.disabled) return; try { if (!idempotencyKey) { intent = intentValue(); idempotencyKey = uuid(); } const args = fields(); const bought = await client.rpc('engine_buy_contract', { ...args, p_idempotency_key: idempotencyKey }); if (bought.error) throw bought.error; status.textContent = 'Contract purchased.'; await loadContracts(); } catch (error) { report(error); } });
        document.addEventListener('smartprofit:clear-trade-state', () => { form.reset(); teardown(); contracts = []; if (balance) balance.textContent = '—'; clearTimeout(quoteTimer); idempotencyKey = ''; syncFamilies(); }); document.addEventListener('smartprofit:account-changed', () => subscribe().catch(report));
        if (!applyConfig(config)) retryConfig();
        await subscribe(); await window.refreshRestrictionBanner();
    }
    window.addEventListener('DOMContentLoaded', () => start().catch(report)); window.smartProfitTrade = { errorMessages: messages };
})();
