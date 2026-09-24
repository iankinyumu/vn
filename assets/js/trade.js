(function () {
    const messages = Object.freeze({ account_not_available: 'This account is not available.', real_disabled: 'Real accounts are not available yet.', module_disabled: 'Digit contracts are not available.', trading_restricted: 'Trading is restricted for this account.', restricted_limit_exceeded: 'This trade exceeds an active restriction or account limit.', access_restricted: 'Access to this account is restricted.', feed_stale: 'The price feed is stale. Wait for it to reconnect.', exposure_limit: 'This trade exceeds the current exposure limit.', limits_not_configured: 'Trading limits are not configured for this account.', idempotency_conflict: 'This purchase request conflicts with an earlier request.', insufficient_funds: 'Your practice balance is insufficient.', invalid_contract_parameters: 'Choose valid contract details.', profit_too_low: 'This stake does not meet the minimum payout requirement.', invalid_stake: 'Enter a valid stake.', stake_below_minimum: 'The stake is below the minimum.', stake_above_maximum: 'The stake exceeds the maximum.', invalid_tick_count: 'Choose between one and ten ticks.', rate_limit_exceeded: 'Too many purchase attempts. Please wait a moment.', rate_limited: 'Too many purchase attempts. Please wait a moment.', contract_type_disabled: 'This contract type is unavailable.', index_not_available: 'This index is unavailable.', max_open_contracts: 'You have reached the open-contract limit.' });
    const codeOf = (error) => String(error?.message || error?.code || '').match(/[a-z_]+/)?.[0];
    const uuid = () => window.crypto.randomUUID();
    // get_recent_ticks and get_ticks_since return at most PAGE_SIZE rows per call.
    const PAGE_SIZE = 500;
    const MAX_TICKS = 1000;
    const feedLabels = Object.freeze({ loading: 'Loading', live: 'Live', polling: 'Live · polling', stale: 'Reconnecting', empty: 'No ticks yet', unavailable: 'Unavailable' });
    const TYPE_LABELS = Object.freeze({ EVEN: 'Even', ODD: 'Odd', MATCH: 'Matches', DIFFER: 'Differs', OVER: 'Over', UNDER: 'Under' });
    // The chart shows this many recent ticks; the full MAX_TICKS buffer still feeds the frequencies and gap recovery.
    const CHART_WINDOW = 300;
    // While the index list or contract types are missing, the page re-reads the configuration on this cadence.
    // A page (or a test) may shorten it through window.smartProfitTradeOptions.configRetryMs.
    const CONFIG_RETRY_MS = 30000;
    const dollars = (value) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value));
    function report(error) { const status = document.querySelector('[data-trade-status]'); const code = codeOf(error); if (messages[code]) status.textContent = messages[code]; else { const reference = uuid().slice(0, 8); status.textContent = `Something went wrong. Reference: ${reference}.`; console.error(reference, error); } }
    function contractNet(contract) { return contract.state === 'WON' ? Number(contract.payout) - Number(contract.stake) : contract.state === 'LOST' ? -Number(contract.stake) : 0; }
    function contractRow(contract, latestTick, activeIndex) {
        const row = document.createElement('tr');
        row.className = `contract-row contract-row-${contract.state.toLowerCase()}`;
        const cell = (value, className = '') => { const td = document.createElement('td'); td.textContent = value; if (className) td.className = className; row.append(td); return td; };
        const name = cell(`${contract.index_code} · ${TYPE_LABELS[contract.contract_type] || contract.contract_type}${contract.barrier == null ? '' : ` ${contract.barrier}`}`);
        if (contract.created_at) { const detail = document.createElement('small'); detail.textContent = new Date(contract.created_at).toLocaleString(); name.append(detail); }
        if (contract.state === 'OPEN') {
            cell(dollars(contract.stake));
            cell(contract.index_code === activeIndex ? `${Math.max(0, Number(contract.settle_tick_no) - latestTick)} ticks left` : `Settles at tick #${contract.settle_tick_no}`);
            cell(dollars(contract.payout));
        } else {
            cell(contract.state === 'WON' ? 'Won' : contract.state === 'LOST' ? 'Lost' : 'Voided', `result result-${contract.state.toLowerCase()}`);
            cell(`${contractNet(contract) > 0 ? '+' : contractNet(contract) < 0 ? '−' : ''}${dollars(Math.abs(contractNet(contract)))}`, `result result-${contract.state.toLowerCase()}`);
            cell(contract.exit_digit == null ? '—' : String(contract.exit_digit));
        }
        return row;
    }
    function emptyContractRow(message) { const row = document.createElement('tr'); const cell = document.createElement('td'); cell.colSpan = 4; cell.className = 'history-empty'; cell.textContent = message; row.append(cell); return row; }

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
        const canvas = document.querySelector('[data-index-chart]');
        const balance = document.querySelector('[data-trade-balance]');
        const toastHost = document.querySelector('[data-trade-toasts]');
        const direction = document.querySelector('[data-price-direction]');
        const activeTrade = document.querySelector('[data-active-trade]');
        const setFeedLabel = (state) => { document.querySelector('[data-feed-state]').textContent = feedLabels[state]; };
        let setup;
        try { setup = await window.initAccountSwitcher(); } catch (error) {
            // Startup failed before any account or configuration existed: say so and leave nothing buyable.
            status.textContent = window.smartProfitStartup?.message(error) || 'Trading is unavailable right now. Reload the page to try again.';
            setFeedLabel('unavailable');
            submit.disabled = true;
            for (const select of [index, type]) { select.replaceChildren(new Option('Unavailable', '')); select.disabled = true; }
            if (balance) balance.textContent = 'Unavailable';
            return;
        }
        const { client } = setup;
        let config = setup.config;
        let feed = null; let feedState = 'loading'; let contractChannel = null; let contracts = []; let refreshedAtTick = 0; let intent = ''; let idempotencyKey = ''; let quoteTimer; let retryTimer;
        let contractsLoaded = false, contractLoadId = 0;
        const purchasedIds = new Set(), notifiedIds = new Set();
        const account = () => window.smartProfitAccount.get();
        const latestTick = () => feed?.last() || 0;
        const fields = () => ({ p_account_id: account().accountId, p_index: index.value, p_type: type.value, p_barrier: barrier.hidden ? null : Number(barrier.value), p_stake: Number(form.stake.value), p_tick_count: Number(form.ticks.value) });
        const intentValue = () => [index.value, type.value, barrier.hidden ? '' : barrier.value, form.stake.value, form.ticks.value].join(':');
        const updateBarrier = () => { const none = !type.value || ['EVEN', 'ODD'].includes(type.value); barrier.closest('label').hidden = none; barrier.hidden = none; barrier.required = !none; };
        // Buy needs a live (or polling) feed, a configured index and an enabled contract type.
        const updateBuy = () => { submit.disabled = !['live', 'polling'].includes(feedState) || !index.value || !type.value; };
        // The digit row is fixed at 0-9 and only the latest tick's digit is highlighted. Its description is not a live
        // region, so assistive technology reads the current digit on demand instead of announcing every tick.
        let shownDigit = null;
        const showDigit = (digit) => {
            if (digit === shownDigit) return;
            shownDigit = digit;
            document.querySelectorAll('[data-digits] [data-digit]').forEach((node) => { const current = Number(node.dataset.digit) === digit; node.classList.toggle('current', current); if (current) node.setAttribute('aria-current', 'true'); else node.removeAttribute('aria-current'); });
            document.querySelector('[data-current-digit]').textContent = digit === null ? 'No digit yet' : `Latest digit: ${digit}`;
        };
        // The crosshair follows the pointer over the chart; pointer is in CSS pixels from the canvas's top left.
        let pointer = null;
        const drawChart = (ticks) => window.drawIndexChart(canvas, ticks, { window: CHART_WINDOW, markLatest: true, decimals: Number(index.selectedOptions[0]?.dataset.decimals), pointer, directionColors: true });
        const draw = (ticks) => { const current = ticks[ticks.length - 1]; if (!current) return; const option = index.selectedOptions[0]; const decimals = Number(option.dataset.decimals); const price = Number(current.price).toFixed(decimals); document.querySelector('[data-live-price]').innerHTML = `$${price.slice(0, -1)}<strong>${price.at(-1)}</strong>`; const previous = ticks[ticks.length - 2]; const change = previous ? Number(current.price) - Number(previous.price) : 0; direction.dataset.direction = change > 0 ? 'up' : change < 0 ? 'down' : 'flat'; direction.textContent = previous ? `${change > 0 ? '▲ Rise' : change < 0 ? '▼ Fall' : '— Flat'} $${Math.abs(change).toFixed(decimals)}` : 'Waiting for next tick'; showDigit(current.digit); [100, 1000].forEach((limit) => { const counts = Array(10).fill(0); ticks.slice(-limit).forEach((tick) => counts[tick.digit]++); const max = Math.max(...counts, 1); document.querySelector(`[data-frequency="${limit}"]`).replaceChildren(...counts.map((count, digit) => { const node = document.createElement('span'); node.style.height = `${Math.max(5, count / max * 100)}%`; node.setAttribute('aria-label', `Digit ${digit}: ${count}`); return node; })); }); drawChart(ticks); };
        // Ticks can arrive faster than the screen refreshes, so they are rendered at most once per frame, always from the
        // current feed's buffer: the latest tick is what gets drawn. A pending frame is cancelled when the feed closes.
        const nextFrame = window.requestAnimationFrame ? (callback) => window.requestAnimationFrame(callback) : (callback) => setTimeout(callback, 16);
        const cancelFrame = window.cancelAnimationFrame ? (handle) => window.cancelAnimationFrame(handle) : (handle) => clearTimeout(handle);
        // A pointer move or a resize only needs the chart redrawn; a tick also refreshes the digits, frequencies and contracts.
        let frame = 0, marketChanged = false;
        const render = () => { frame = 0; const market = marketChanged; marketChanged = false; if (!feed) return; if (market) { draw(feed.ticks); renderContracts(); } else drawChart(feed.ticks); };
        const scheduleChart = () => { if (!frame) frame = nextFrame(render); };
        const scheduleRender = () => { marketChanged = true; scheduleChart(); };
        const cancelRender = () => { if (frame) cancelFrame(frame); frame = 0; marketChanged = false; };
        const resetMarket = () => { showDigit(null); direction.dataset.direction = 'flat'; direction.textContent = 'Waiting for ticks'; document.querySelectorAll('[data-frequency]').forEach((bars) => bars.replaceChildren()); window.drawIndexChart(canvas, []); };
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
            balance.textContent = new Intl.NumberFormat('en-US', { style: 'currency', currency: data.currency || 'USD' }).format(Number(data.available));
        };
        const showResult = (contract) => {
            const toast = document.createElement('div');
            toast.className = `trade-toast trade-toast-${contract.state.toLowerCase()}`;
            toast.setAttribute('role', 'group');
            const copy = document.createElement('div');
            const title = document.createElement('strong');
            title.textContent = contract.state === 'WON' ? 'You won' : contract.state === 'LOST' ? 'You lost' : 'Trade voided';
            const detail = document.createElement('span');
            const result = contractNet(contract);
            detail.textContent = `${contract.index_code} · ${TYPE_LABELS[contract.contract_type] || contract.contract_type} · ${result > 0 ? '+' : result < 0 ? '−' : ''}${dollars(Math.abs(result))}${contract.exit_digit == null ? '' : ` · final digit ${contract.exit_digit}`}`;
            copy.append(title, detail);
            const close = document.createElement('button');
            close.type = 'button'; close.className = 'trade-toast-close'; close.textContent = '×'; close.setAttribute('aria-label', 'Dismiss trade notification');
            close.addEventListener('click', () => toast.remove());
            toast.append(copy, close);
            toastHost.prepend(toast);
            while (toastHost.children.length > 3) toastHost.lastElementChild.remove();
            setTimeout(() => toast.remove(), 8000);
        };
        const renderContracts = () => {
            const tick = latestTick();
            const open = contracts.filter((item) => item.state === 'OPEN');
            const settled = contracts.filter((item) => item.state !== 'OPEN');
            const current = open.filter((item) => item.index_code === index.value).sort((a, b) => Number(a.settle_tick_no) - Number(b.settle_tick_no));
            activeTrade.hidden = !current.length;
            if (current.length) {
                const next = current[0], remaining = Math.max(0, Number(next.settle_tick_no) - tick);
                activeTrade.textContent = current.length === 1 ? `Active: ${TYPE_LABELS[next.contract_type] || next.contract_type} · ${remaining} ticks left` : `${current.length} active trades · next in ${remaining} ticks`;
            }
            document.querySelector('[data-open-contracts]').replaceChildren(...(open.length ? open.map((item) => contractRow(item, tick, index.value)) : [emptyContractRow('No open contracts. New trades appear here until they settle.')]));
            document.querySelector('[data-settled-contracts]').replaceChildren(...(settled.length ? settled.map((item) => contractRow(item, tick, index.value)) : [emptyContractRow('No settled trades yet. Wins and losses appear here.')]));
        };
        // A contract change (purchase or settlement) also moves the balance, so both are re-read together.
        const loadContracts = async () => {
            const accountId = account().accountId, requestId = ++contractLoadId;
            const [{ data, error }] = await Promise.all([client.rpc('list_my_contracts', { p_account_id: accountId, p_state: null, p_before: null, p_limit: 50 }), loadBalance()]);
            if (error) throw error;
            if (accountId !== account().accountId || requestId !== contractLoadId) return;
            const previous = new Map(contracts.map((item) => [item.id, item.state]));
            contracts = data || [];
            refreshedAtTick = latestTick();
            renderContracts();
            for (const item of contracts) {
                if (!['WON', 'LOST', 'VOID'].includes(item.state) || notifiedIds.has(item.id)) continue;
                if ((contractsLoaded && previous.get(item.id) === 'OPEN') || purchasedIds.has(item.id)) { notifiedIds.add(item.id); showResult(item); }
                purchasedIds.delete(item.id);
            }
            contractsLoaded = true;
        };
        // Results normally arrive through the contract change subscription; an open contract whose settle tick has
        // already been published is re-read once per tick so a missed change event cannot leave it stale on screen.
        const onTicks = () => { scheduleRender(); const tick = latestTick(); if (tick > refreshedAtTick && contracts.some((item) => item.state === 'OPEN' && item.index_code === index.value && Number(item.settle_tick_no) <= tick)) { refreshedAtTick = tick; loadContracts().catch(report); } };
        const quote = async () => { if (!form.checkValidity() || !index.value || !type.value) return; const { data, error } = await client.rpc('engine_quote_contract', fields()); if (error) { report(error); return; } document.querySelector('[data-quote]').textContent = `${TYPE_LABELS[type.value] || type.value}: payout ${dollars(data.payout)} · profit ${dollars(data.profit)} · win probability ${(Number(data.win_probability) * 100).toFixed(0)}%`; };
        const teardown = () => { cancelRender(); ++contractLoadId; feed?.close(); feed = null; if (contractChannel) client.removeChannel(contractChannel); contractChannel = null; };
        const subscribe = async () => {
            teardown();
            contracts = []; contractsLoaded = false; refreshedAtTick = 0;
            renderContracts();
            if (balance) balance.textContent = '—';
            document.querySelector('[data-live-price]').textContent = '—';
            resetMarket();
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
        // Applies a configuration; returns whether it has at least one index and one enabled contract type.
        function applyConfig(next) {
            const selected = index.value;
            const indices = next.indices || [];
            const enabled = (next.enabled_contract_types || []).filter((code) => TYPE_LABELS[code]);
            index.replaceChildren(...indices.map((item) => { const option = new Option(item.display_name || item.code, item.code); option.dataset.interval = item.interval_ms; option.dataset.decimals = item.decimals; return option; }));
            // Contract types come only from the live policy; with none enabled the selector says so and holds no value.
            type.replaceChildren(...(enabled.length ? enabled.map((code) => new Option(TYPE_LABELS[code], code)) : [new Option('None available', '')]));
            index.disabled = !indices.length;
            type.disabled = !enabled.length;
            // The dashboard links to trade.html?index=CODE; an unknown code keeps the first index.
            const requested = selected || new URLSearchParams(window.location.search).get('index');
            if (requested && indices.some((item) => item.code === requested)) index.value = requested;
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
        const changed = () => { updateBarrier(); updateBuy(); const next = intentValue(); if (next !== intent) { intent = next; idempotencyKey = uuid(); } clearTimeout(quoteTimer); quoteTimer = setTimeout(quote, 200); }; form.addEventListener('input', changed); form.addEventListener('change', changed); index.addEventListener('change', () => subscribe().catch(report));
        form.addEventListener('submit', async (event) => { event.preventDefault(); if (submit.disabled) return; try { if (!idempotencyKey) { intent = intentValue(); idempotencyKey = uuid(); } const args = fields(); const bought = await client.rpc('engine_buy_contract', { ...args, p_idempotency_key: idempotencyKey }); if (args.p_account_id !== account().accountId) return; if (bought.error) throw bought.error; if (bought.data?.id) purchasedIds.add(bought.data.id); status.textContent = 'Contract purchased. Tracking the result below.'; await loadContracts(); } catch (error) { report(error); } });
        document.addEventListener('smartprofit:clear-trade-state', () => { form.reset(); teardown(); contracts = []; contractsLoaded = false; purchasedIds.clear(); notifiedIds.clear(); toastHost.replaceChildren(); renderContracts(); if (balance) balance.textContent = '—'; clearTimeout(quoteTimer); idempotencyKey = ''; }); document.addEventListener('smartprofit:account-changed', () => subscribe().catch(report));
        // A resized chart is redrawn at its new size from the current buffer.
        if (window.ResizeObserver) new window.ResizeObserver(scheduleChart).observe(canvas); else window.addEventListener('resize', scheduleChart);
        canvas.addEventListener('pointermove', (event) => { const box = canvas.getBoundingClientRect(); pointer = { x: event.clientX - box.left, y: event.clientY - box.top }; scheduleChart(); });
        for (const name of ['pointerleave', 'pointercancel']) canvas.addEventListener(name, () => { pointer = null; scheduleChart(); });
        if (!applyConfig(config)) retryConfig();
        await subscribe(); await window.refreshRestrictionBanner();
    }
    window.addEventListener('DOMContentLoaded', () => start().catch(report)); window.smartProfitTrade = { errorMessages: messages };
})();
