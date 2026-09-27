(function () {
    const messages = Object.freeze({ account_not_available: 'This account is not available.', real_disabled: 'Real accounts are not available yet.', module_disabled: 'Digit contracts are not available.', trading_restricted: 'Trading is restricted for this account.', restricted_limit_exceeded: 'This trade exceeds an active restriction or account limit.', access_restricted: 'Access to this account is restricted.', feed_stale: 'The price feed is stale. Wait for it to reconnect.', exposure_limit: 'This trade exceeds the current exposure limit.', limits_not_configured: 'Trading limits are not configured for this account.', idempotency_conflict: 'This purchase request conflicts with an earlier request.', insufficient_funds: 'Your balance is too low for this stake.', invalid_contract_parameters: 'Choose valid contract details.', profit_too_low: 'This stake is too small for this contract.', invalid_stake: 'Enter a valid stake.', stake_below_minimum: 'The stake is below the minimum.', stake_above_maximum: 'The stake exceeds the maximum.', invalid_tick_count: 'Choose between one and ten ticks.', rate_limit_exceeded: 'Too many purchase attempts. Please wait a moment.', rate_limited: 'Too many purchase attempts. Please wait a moment.', contract_type_disabled: 'This contract type is unavailable.', index_not_available: 'This index is unavailable.', max_open_contracts: 'You have reached the open-contract limit.', engine_unwitnessed: 'Trading on this index is paused until today\'s outcome commitment has been independently timestamped.', engine_checkpoint_stale: 'Trading on this index is paused until the latest price history checkpoint is independently timestamped.', engine_worker_unhealthy: 'Trading on this index is paused while the price engine reconnects.', engine_generation_cutover: 'This contract would end after the index moves to its new price series. Choose fewer ticks or wait for the switch.', engine_v3_environment_unset: 'This index is not open for trading yet.' });
    const codeOf = (error) => String(error?.message || error?.code || '').match(/[a-z_]+/)?.[0];
    const uuid = () => window.crypto.randomUUID();
    // get_recent_ticks and get_ticks_since return at most PAGE_SIZE rows per call.
    const PAGE_SIZE = 500;
    const MAX_TICKS = 1000;
    const feedLabels = Object.freeze({ loading: 'Loading', live: 'Live', polling: 'Live · polling', stale: 'Reconnecting', empty: 'No ticks yet', unavailable: 'Unavailable' });
    const TYPE_LABELS = Object.freeze({ EVEN: 'Even', ODD: 'Odd', MATCH: 'Matches', DIFFER: 'Differs', OVER: 'Over', UNDER: 'Under' });
    // Each contract family is one tab with two opposite sides; the barrier families add a 0-9 digit picker.
    const FAMILIES = Object.freeze([
        { key: 'evenodd', label: 'Even / Odd', sides: ['EVEN', 'ODD'], barrier: false },
        { key: 'matchdiffer', label: 'Matches / Differs', sides: ['MATCH', 'DIFFER'], barrier: true },
        { key: 'overunder', label: 'Over / Under', sides: ['OVER', 'UNDER'], barrier: true },
    ]);
    const SIDE_ICONS = Object.freeze({ EVEN: 'fa-hashtag', ODD: 'fa-hashtag', MATCH: 'fa-equals', DIFFER: 'fa-not-equal', OVER: 'fa-arrow-up', UNDER: 'fa-arrow-down' });
    // The barriers the engine accepts for each type (engine_winning_digits); any other barrier cannot win.
    const BARRIER_OK = Object.freeze({ OVER: (digit) => digit <= 8, UNDER: (digit) => digit >= 1, MATCH: () => true, DIFFER: () => true });
    const TICK_CHOICES = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // The digit strip shows how often each final digit appeared in this many recent ticks.
    const FREQUENCY_WINDOW = 100;
    // The chart shows this many recent ticks; the full MAX_TICKS buffer still feeds gap recovery.
    const CHART_WINDOW = 300;
    // While the index list or contract types are missing, the page re-reads the configuration on this cadence.
    // A page (or a test) may shorten it through window.smartProfitTradeOptions.configRetryMs.
    const CONFIG_RETRY_MS = 30000;
    const dollars = (value) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value));
    const signed = (value) => `${value > 0 ? '+' : value < 0 ? '−' : ''}${dollars(Math.abs(value))}`;
    function report(error) { const status = document.querySelector('[data-trade-status]'); const code = codeOf(error); if (messages[code]) status.textContent = messages[code]; else { const reference = uuid().slice(0, 8); status.textContent = `Something went wrong. Reference: ${reference}.`; console.error(reference, error); } }
    function contractNet(contract) { return contract.state === 'WON' ? Number(contract.payout) - Number(contract.stake) : contract.state === 'LOST' ? -Number(contract.stake) : 0; }
    const contractName = (contract) => `${TYPE_LABELS[contract.contract_type] || contract.contract_type}${contract.barrier == null ? '' : ` ${contract.barrier}`}`;
    // Generation of a contract's exit tick: version 3 when its index has moved to v3 and the exit is after the last v2 tick.
    let v3Status = new Map();
    const generationOf = (contract) => { const row = v3Status.get(contract.index_code); return row?.engine_generation === 3 && Number(contract.settle_tick_no) > Number(row.v2_final_tick_no ?? -1) ? 3 : 2; };
    function contractItem(contract, latestTick, activeIndex) {
        const item = document.createElement('li');
        const state = contract.state.toLowerCase();
        item.className = `activity-item activity-${state}`;
        const main = document.createElement('div');
        const name = document.createElement('strong');
        name.textContent = `${contract.index_code} · ${contractName(contract)}`;
        const meta = document.createElement('small');
        meta.textContent = `${dollars(contract.stake)} · v${generationOf(contract)} · #${contract.entry_tick_no} → #${contract.settle_tick_no}${contract.created_at ? ` · ${new Date(contract.created_at).toLocaleTimeString()}` : ''}`;
        main.append(name, meta);
        const side = document.createElement('div');
        side.className = 'activity-result';
        const value = document.createElement('strong');
        const detail = document.createElement('small');
        if (contract.state === 'OPEN') {
            value.textContent = dollars(contract.payout);
            detail.textContent = contract.index_code === activeIndex ? `${Math.max(0, Number(contract.settle_tick_no) - latestTick)} ticks left` : `Settles at #${contract.settle_tick_no}`;
        } else {
            value.textContent = contract.state === 'VOID' ? 'Voided' : signed(contractNet(contract));
            detail.textContent = `${contract.state === 'WON' ? 'Won' : contract.state === 'LOST' ? 'Lost' : 'Refunded'}${contract.exit_digit == null ? '' : ` · digit ${contract.exit_digit}`}`;
        }
        side.append(value, detail);
        item.append(main, side);
        return item;
    }
    function emptyItem(message) { const item = document.createElement('li'); item.className = 'activity-empty'; item.textContent = message; return item; }

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
        const form = document.querySelector('[data-trade-form]');
        const index = form.querySelector('[data-index-select]');
        const stake = form.querySelector('input[name="stake"]');
        const takeProfit = form.querySelector('[data-take-profit]');
        const stopLoss = form.querySelector('[data-stop-loss]');
        const status = document.querySelector('[data-trade-status]');
        const canvas = document.querySelector('[data-index-chart]');
        const toastHost = document.querySelector('[data-trade-toasts]');
        const direction = document.querySelector('[data-price-direction]');
        const livePrice = document.querySelector('[data-live-price]');
        const activeTrade = document.querySelector('[data-active-trade]');
        const familiesHost = document.querySelector('[data-families]');
        const barrierRow = document.querySelector('[data-barrier-row]');
        const barrierPicker = document.querySelector('[data-barrier-picker]');
        const tickChips = document.querySelector('[data-tick-chips]');
        const sides = [...document.querySelectorAll('[data-side]')];
        const digitsHost = document.querySelector('[data-digits]');
        const digitPointer = document.querySelector('[data-digit-pointer]');
        const feedNode = document.querySelector('[data-feed-state]');
        const guardNode = document.querySelector('[data-session-guard]');
        const setFeedLabel = (state) => { feedNode.textContent = feedLabels[state]; feedNode.dataset.state = state; };

        // Static controls: the 0-9 digit strip, the barrier picker and the tick chips.
        const digitNodes = Array.from({ length: 10 }, (_, digit) => {
            const node = document.createElement('span');
            node.className = 'digit';
            node.dataset.digit = String(digit);
            const ring = document.createElement('span');
            ring.className = 'digit-ring';
            ring.textContent = String(digit);
            const pct = document.createElement('span');
            pct.className = 'digit-pct';
            pct.textContent = '';
            node.append(ring, pct);
            return node;
        });
        digitsHost.append(...digitNodes);
        const radio = (name, value, text, className) => {
            const label = document.createElement('label');
            label.className = className;
            const input = document.createElement('input');
            input.type = 'radio'; input.name = name; input.value = String(value);
            const face = document.createElement('span');
            face.textContent = text;
            label.append(input, face);
            return label;
        };
        barrierPicker.append(...Array.from({ length: 10 }, (_, digit) => radio('barrier', digit, String(digit), 'barrier-choice')));
        tickChips.append(...TICK_CHOICES.map((count) => radio('ticks', count, String(count), 'tick-chip')));
        const checked = (name) => form.querySelector(`input[name="${name}"]:checked`)?.value ?? '';
        const check = (name, value) => { const input = form.querySelector(`input[name="${name}"][value="${value}"]`); if (input) input.checked = true; };
        check('ticks', 1);
        check('barrier', 5);

        const disableAll = () => { sides.forEach((button) => { button.disabled = true; }); index.disabled = true; };
        let setup;
        try { setup = await window.initAccountSwitcher(); } catch (error) {
            // Startup failed before any account or configuration existed: say so and leave nothing buyable.
            status.textContent = window.smartProfitStartup?.message(error) || 'Trading is unavailable right now. Reload the page to try again.';
            setFeedLabel('unavailable');
            index.replaceChildren(new Option('Unavailable', ''));
            disableAll();
            return;
        }
        const { client } = setup;
        let config = setup.config;
        let feed = null; let feedState = 'loading'; let contractChannel = null; let contracts = []; let refreshedAtTick = 0; let intent = ''; let idempotencyKey = ''; let quoteTimer; let retryTimer;
        let contractsLoaded = false, contractLoadId = 0, quoteId = 0, buying = false;
        let enabledTypes = new Set();
        let family = null;
        const purchasedIds = new Set(), notifiedIds = new Set(), sessionIds = new Set();
        const account = () => window.smartProfitAccount.get();
        const latestTick = () => feed?.last() || 0;
        const barrierValue = () => (family?.barrier ? Number(checked('barrier')) : null);
        const sideType = (button) => button.dataset.type || '';
        const limits = () => config.accounts?.find((item) => item.id === account().accountId)?.limits || {};
        const stakeValid = () => stake.value !== '' && stake.checkValidity() && Number(stake.value) > 0;
        const fields = (type) => ({ p_account_id: account().accountId, p_index: index.value, p_type: type, p_barrier: barrierValue(), p_stake: Number(stake.value), p_tick_count: Number(checked('ticks')) });
        const intentValue = (type) => [index.value, type, barrierValue() ?? '', stake.value, checked('ticks')].join(':');

        // Stake bounds and the −/+ step come from the active account's policy limits.
        const applyStakeLimits = () => {
            const { min_stake: min, max_stake: max } = limits();
            stake.min = Number.isFinite(Number(min)) && min != null ? String(min) : '0.01';
            if (max != null && Number.isFinite(Number(max))) stake.max = String(max); else stake.removeAttribute('max');
        };
        const stepStake = (direction) => {
            const step = Number(limits().min_stake) || 1;
            const min = Number(stake.min) || step, max = stake.max ? Number(stake.max) : Infinity;
            const current = Number(stake.value) || 0;
            const next = Math.min(max, Math.max(min, Math.round((current + direction * step) * 100) / 100));
            stake.value = next.toFixed(2);
            changed();
        };

        // Session take profit and stop loss only ever stop this customer from buying; they never place a trade.
        const sessionStats = () => {
            let net = 0, won = 0, lost = 0;
            for (const item of contracts) {
                if (!sessionIds.has(item.id) || item.state === 'OPEN') continue;
                net += contractNet(item);
                if (item.state === 'WON') won++; else if (item.state === 'LOST') lost++;
            }
            return { net: Math.round(net * 100) / 100, won, lost };
        };
        const guardReason = () => {
            const { net } = sessionStats();
            const profit = Number(takeProfit.value), loss = Number(stopLoss.value);
            if (profit > 0 && net >= profit) return `Take profit reached at ${signed(net)}.`;
            if (loss > 0 && net <= -loss) return `Stop loss reached at ${signed(net)}.`;
            return null;
        };
        const renderSession = () => {
            const { net, won, lost } = sessionStats();
            const node = document.querySelector('[data-session-net]');
            node.textContent = signed(net);
            node.dataset.tone = net > 0 ? 'up' : net < 0 ? 'down' : 'flat';
            document.querySelector('[data-session-count]').textContent = `${won}W · ${lost}L`;
            const reason = guardReason();
            guardNode.hidden = !reason;
            document.querySelector('[data-session-guard-text]').textContent = reason || '';
        };

        const gateNote = Object.assign(document.createElement('p'), { className: 'trade-gate' });
        gateNote.dataset.v3Gate = ''; gateNote.setAttribute('role', 'status'); gateNote.hidden = true;
        // An announced price model change for the selected index, shown until it takes effect.
        const modelNote = Object.assign(document.createElement('p'), { className: 'trade-gate trade-gate-info' });
        modelNote.dataset.priceModelNote = ''; modelNote.hidden = true;
        guardNode.before(gateNote, modelNote);
        const updateModelNote = () => {
            const item = (config.indices || []).find((entry) => entry.code === index.value);
            const startsAt = item?.v2_starts_at ? new Date(item.v2_starts_at) : null;
            modelNote.hidden = !(startsAt && startsAt > new Date());
            modelNote.textContent = modelNote.hidden ? '' : `From ${startsAt.toUTCString().replace('GMT', 'UTC')}, ${item.display_name || item.code} moves to price model version 2.`;
        };
        const gateReason = () => v3Status.get(index.value)?.engine_generation === 3 ? v3Status.get(index.value).purchase_block : null;
        // A side is buyable with a live (or polling) feed, an index, an enabled type, a valid barrier and stake,
        // an open gate, no purchase in flight and no session limit reached.
        const updateBuy = () => {
            const reason = gateReason();
            gateNote.hidden = !reason;
            gateNote.textContent = reason ? (messages[reason] || 'Trading on this index is paused.') : '';
            const open = !reason && ['live', 'polling'].includes(feedState) && Boolean(index.value) && !buying && !guardReason() && stakeValid();
            for (const button of sides) {
                const type = sideType(button);
                const barrierOk = !family?.barrier || BARRIER_OK[type]?.(barrierValue());
                button.disabled = !open || !enabledTypes.has(type) || !barrierOk;
            }
            updateModelNote();
        };
        // The server re-checks the gate on every purchase; this only explains a closed gate before the customer tries.
        async function refreshGate() {
            const { data, error } = await client.rpc('get_engine_v3_status', {});
            if (!error && Array.isArray(data)) v3Status = new Map(data.map((row) => [row.index_code, row]));
            updateBuy();
        }
        refreshGate().catch(() => {});
        setInterval(() => refreshGate().catch(() => {}), 10000);

        // Families and sides follow the live policy: a family appears when either of its types is enabled.
        const renderFamilies = () => {
            const available = FAMILIES.filter((item) => item.sides.some((type) => enabledTypes.has(type)));
            if (!available.some((item) => item.key === family?.key)) family = available[0] || null;
            familiesHost.querySelectorAll('.family-tab').forEach((node) => node.remove());
            familiesHost.append(...available.map((item) => { const tab = radio('family', item.key, item.label, 'family-tab'); tab.querySelector('input').checked = item.key === family?.key; return tab; }));
            // A single family needs no tabs: its two side buttons already name it.
            familiesHost.hidden = available.length < 2;
            applyFamily();
        };
        const applyFamily = () => {
            barrierRow.hidden = !family?.barrier;
            sides.forEach((button, position) => {
                const type = family?.sides[position] || '';
                button.dataset.type = type;
                button.querySelector('[data-side-label]').textContent = TYPE_LABELS[type] || '—';
                button.querySelector('i').className = `fas ${SIDE_ICONS[type] || 'fa-circle'}`;
                button.querySelector('[data-side-payout]').textContent = '—';
                button.removeAttribute('title');
            });
            paintBarrier();
            updateBuy();
        };
        // Over/Under colours the digits above and below the barrier; Matches/Differs marks the chosen digit.
        const paintBarrier = () => {
            const barrier = barrierValue();
            digitNodes.forEach((node, digit) => {
                let zone = '';
                if (family?.key === 'overunder') zone = digit > barrier ? 'above' : digit < barrier ? 'below' : 'barrier';
                else if (family?.key === 'matchdiffer') zone = digit === barrier ? 'barrier' : '';
                if (zone) node.dataset.zone = zone; else delete node.dataset.zone;
            });
            barrierPicker.querySelectorAll('.barrier-choice').forEach((choice, digit) => {
                choice.dataset.zone = digitNodes[digit].dataset.zone || '';
            });
        };

        // The digit row is fixed at 0-9: the latest digit is marked and a pointer slides to it. Its description is not
        // a live region, so assistive technology reads the current digit on demand instead of every tick.
        let shownDigit = null;
        const movePointer = () => {
            if (shownDigit === null) { digitPointer.hidden = true; return; }
            const node = digitNodes[shownDigit];
            digitPointer.hidden = false;
            digitPointer.style.transform = `translateX(${node.offsetLeft + node.offsetWidth / 2}px)`;
        };
        const showDigit = (digit, change = 0) => {
            digitPointer.dataset.direction = change > 0 ? 'up' : change < 0 ? 'down' : 'flat';
            if (digit === shownDigit) return;
            shownDigit = digit;
            digitNodes.forEach((node, position) => { const current = position === digit; node.classList.toggle('current', current); if (current) node.setAttribute('aria-current', 'true'); else node.removeAttribute('aria-current'); });
            document.querySelector('[data-current-digit]').textContent = digit === null ? 'No digit yet' : `Latest digit: ${digit}`;
            movePointer();
        };
        const showFrequencies = (ticks) => {
            const recent = ticks.slice(-FREQUENCY_WINDOW);
            const counts = Array(10).fill(0);
            recent.forEach((tick) => counts[tick.digit]++);
            const max = Math.max(...counts), min = Math.min(...counts);
            digitNodes.forEach((node, digit) => {
                const pct = recent.length ? Math.round(counts[digit] / recent.length * 100) : 0;
                node.style.setProperty('--pct', String(pct));
                node.querySelector('.digit-pct').textContent = recent.length ? `${pct}%` : '';
                node.classList.toggle('hot', recent.length >= 10 && max > min && counts[digit] === max);
                node.classList.toggle('cold', recent.length >= 10 && max > min && counts[digit] === min);
            });
        };

        // The crosshair follows the pointer over the chart; pointer is in CSS pixels from the canvas's top left.
        let pointer = null;
        const decimals = () => Number(index.selectedOptions[0]?.dataset.decimals);
        const drawChart = (ticks) => window.drawIndexChart(canvas, ticks, { window: CHART_WINDOW, markLatest: true, decimals: decimals(), pointer, directionColors: true });
        const draw = (ticks) => {
            const current = ticks[ticks.length - 1];
            if (!current) return;
            const places = decimals();
            const price = Number(current.price).toFixed(places);
            livePrice.replaceChildren(document.createTextNode(price.slice(0, -1)), Object.assign(document.createElement('span'), { className: 'price-last', textContent: price.at(-1) }));
            const previous = ticks[ticks.length - 2];
            const change = previous ? Number(current.price) - Number(previous.price) : 0;
            direction.dataset.direction = change > 0 ? 'up' : change < 0 ? 'down' : 'flat';
            direction.textContent = previous ? `${change > 0 ? '▲' : change < 0 ? '▼' : '—'} ${Math.abs(change).toFixed(places)}` : '';
            showFrequencies(ticks);
            showDigit(current.digit, change);
            drawChart(ticks);
        };
        // Ticks can arrive faster than the screen refreshes, so they are rendered at most once per frame, always from the
        // current feed's buffer: the latest tick is what gets drawn. A pending frame is cancelled when the feed closes.
        const nextFrame = window.requestAnimationFrame ? (callback) => window.requestAnimationFrame(callback) : (callback) => setTimeout(callback, 16);
        const cancelFrame = window.cancelAnimationFrame ? (handle) => window.cancelAnimationFrame(handle) : (handle) => clearTimeout(handle);
        // A pointer move or a resize only needs the chart redrawn; a tick also refreshes the digits and contracts.
        let frame = 0, marketChanged = false;
        const render = () => { frame = 0; const market = marketChanged; marketChanged = false; if (!feed) return; if (market) { draw(feed.ticks); renderContracts(); } else { drawChart(feed.ticks); movePointer(); } };
        const scheduleChart = () => { if (!frame) frame = nextFrame(render); };
        const scheduleRender = () => { marketChanged = true; scheduleChart(); };
        const cancelRender = () => { if (frame) cancelFrame(frame); frame = 0; marketChanged = false; };
        const resetMarket = () => { showDigit(null); showFrequencies([]); livePrice.textContent = '—'; direction.dataset.direction = 'flat'; direction.textContent = ''; window.drawIndexChart(canvas, []); };
        let chartLoader = null;
        const showChartLoader = (on) => {
            if (on && !chartLoader) chartLoader = window.smartProfitLoader?.mount(canvas.parentElement, { label: 'Loading market' }) || null;
            if (!on && chartLoader) { chartLoader.remove(); chartLoader = null; }
        };
        const setFeedState = (state) => {
            feedState = state;
            setFeedLabel(state);
            showChartLoader(state === 'loading');
            if (state === 'empty') livePrice.textContent = 'No ticks yet';
            updateBuy();
        };
        const showResult = (contract) => {
            const toast = document.createElement('div');
            toast.className = `trade-toast trade-toast-${contract.state.toLowerCase()}`;
            toast.setAttribute('role', 'group');
            const copy = document.createElement('div');
            const title = document.createElement('strong');
            const result = contractNet(contract);
            title.textContent = contract.state === 'WON' ? `Won ${signed(result)}` : contract.state === 'LOST' ? `Lost ${signed(result)}` : 'Trade voided';
            const detail = document.createElement('span');
            detail.textContent = `${contract.index_code} · ${contractName(contract)}${contract.exit_digit == null ? '' : ` · digit ${contract.exit_digit}`}`;
            copy.append(title, detail);
            const close = document.createElement('button');
            close.type = 'button'; close.className = 'trade-toast-close'; close.textContent = '×'; close.setAttribute('aria-label', 'Dismiss trade result');
            close.addEventListener('click', () => toast.remove());
            toast.append(copy, close);
            toastHost.prepend(toast);
            while (toastHost.children.length > 3) toastHost.lastElementChild.remove();
            setTimeout(() => toast.remove(), 6000);
        };
        const renderContracts = () => {
            const tick = latestTick();
            const open = contracts.filter((item) => item.state === 'OPEN');
            const settled = contracts.filter((item) => item.state !== 'OPEN');
            const current = open.filter((item) => item.index_code === index.value).sort((a, b) => Number(a.settle_tick_no) - Number(b.settle_tick_no));
            activeTrade.hidden = !current.length;
            if (current.length) {
                const next = current[0], remaining = Math.max(0, Number(next.settle_tick_no) - tick);
                activeTrade.textContent = current.length === 1 ? `${contractName(next)} · ${remaining} ticks left` : `${current.length} open · next in ${remaining} ticks`;
            }
            document.querySelector('[data-open-count]').textContent = String(open.length);
            document.querySelector('[data-open-contracts]').replaceChildren(...(open.length ? open.map((item) => contractItem(item, tick, index.value)) : [emptyItem('No open trades.')]));
            document.querySelector('[data-settled-contracts]').replaceChildren(...(settled.length ? settled.map((item) => contractItem(item, tick, index.value)) : [emptyItem('No settled trades yet.')]));
            renderSession();
        };
        // A contract change (purchase or settlement) also moves the balance, which the mode switch re-reads.
        const loadContracts = async () => {
            const accountId = account().accountId, requestId = ++contractLoadId;
            const { data, error } = await client.rpc('list_my_contracts', { p_account_id: accountId, p_state: null, p_before: null, p_limit: 50 });
            if (error) throw error;
            if (accountId !== account().accountId || requestId !== contractLoadId) return;
            const previous = new Map(contracts.map((item) => [item.id, item.state]));
            contracts = data || [];
            refreshedAtTick = latestTick();
            renderContracts();
            updateBuy();
            document.dispatchEvent(new Event('smartprofit:balance-changed'));
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
        // Both sides are quoted together so each button shows its own payout.
        const quote = async () => {
            const request = ++quoteId;
            await Promise.all(sides.map(async (button) => {
                const type = sideType(button);
                const payout = button.querySelector('[data-side-payout]');
                button.removeAttribute('title');
                if (!index.value || !enabledTypes.has(type) || !stakeValid() || (family?.barrier && !BARRIER_OK[type]?.(barrierValue()))) { payout.textContent = '—'; return; }
                const { data, error } = await client.rpc('engine_quote_contract', fields(type));
                if (request !== quoteId) return;
                if (error) { payout.textContent = '—'; button.title = messages[codeOf(error)] || 'No quote'; return; }
                payout.textContent = dollars(data.payout);
            }));
        };
        const teardown = () => { cancelRender(); ++contractLoadId; feed?.close(); feed = null; if (contractChannel) client.removeChannel(contractChannel); contractChannel = null; };
        const subscribe = async () => {
            teardown();
            contracts = []; contractsLoaded = false; refreshedAtTick = 0;
            renderContracts();
            resetMarket();
            applyStakeLimits();
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
            enabledTypes = new Set((next.enabled_contract_types || []).filter((code) => TYPE_LABELS[code]));
            index.replaceChildren(...indices.map((item) => { const option = new Option(item.display_name || item.code, item.code); option.dataset.interval = item.interval_ms; option.dataset.decimals = item.decimals; return option; }));
            if (!indices.length) index.append(new Option('No indices open', ''));
            index.disabled = !indices.length;
            // The dashboard links to trade.html?index=CODE; an unknown code keeps the first index.
            const requested = selected || new URLSearchParams(window.location.search).get('index');
            if (requested && indices.some((item) => item.code === requested)) index.value = requested;
            renderFamilies();
            if (!indices.length) status.textContent = 'No indices are open for trading right now. This page checks again automatically.';
            else if (!enabledTypes.size) status.textContent = 'No contract types are enabled right now. This page checks again automatically.';
            else if (/checks again automatically/.test(status.textContent)) status.textContent = '';
            return indices.length > 0 && enabledTypes.size > 0;
        }
        function retryConfig() {
            clearTimeout(retryTimer);
            retryTimer = setTimeout(async () => {
                try {
                    config = (await window.loadEngineConfig({ refresh: true })).config;
                    if (applyConfig(config)) { await subscribe(); changed(); } else retryConfig();
                } catch (error) { window.smartProfitStartup?.log(error); retryConfig(); }
            }, window.smartProfitTradeOptions?.configRetryMs ?? CONFIG_RETRY_MS);
        }
        function changed() { paintBarrier(); updateBuy(); clearTimeout(quoteTimer); quoteTimer = setTimeout(() => quote().catch(report), 200); }
        async function buy(button) {
            const type = sideType(button);
            if (button.disabled || !type) return;
            const next = intentValue(type);
            // One key per intended contract: a retry after a lost response reuses it; a completed purchase retires it.
            if (next !== intent || !idempotencyKey) { intent = next; idempotencyKey = uuid(); }
            const args = fields(type);
            buying = true;
            button.dataset.busy = 'true';
            updateBuy();
            status.textContent = '';
            try {
                const bought = await client.rpc('engine_buy_contract', { ...args, p_idempotency_key: idempotencyKey });
                if (args.p_account_id !== account().accountId) return;
                if (bought.error) { if (['engine_unwitnessed', 'engine_checkpoint_stale', 'engine_worker_unhealthy'].includes(codeOf(bought.error))) refreshGate().catch(() => {}); throw bought.error; }
                idempotencyKey = '';
                if (bought.data?.id) { purchasedIds.add(bought.data.id); sessionIds.add(bought.data.id); }
                status.textContent = `${TYPE_LABELS[type]}${args.p_barrier == null ? '' : ` ${args.p_barrier}`} bought · exit tick #${bought.data.settle_tick_no}`;
                await loadContracts();
            } catch (error) { report(error); } finally { buying = false; delete button.dataset.busy; updateBuy(); }
        }

        familiesHost.addEventListener('change', (event) => {
            if (event.target.name !== 'family') return;
            family = FAMILIES.find((item) => item.key === event.target.value) || family;
            applyFamily();
            changed();
        });
        form.addEventListener('input', (event) => { if (event.target.name !== 'family') changed(); });
        form.addEventListener('change', (event) => { if (!['index', 'family'].includes(event.target.name)) changed(); });
        index.addEventListener('change', () => subscribe().then(changed).catch(report));
        form.addEventListener('submit', (event) => event.preventDefault());
        form.querySelectorAll('[data-stake-step]').forEach((button) => button.addEventListener('click', () => stepStake(Number(button.dataset.stakeStep))));
        stake.addEventListener('blur', () => { if (stakeValid()) stake.value = Number(stake.value).toFixed(2); });
        [takeProfit, stopLoss].forEach((input) => input.addEventListener('input', () => { renderSession(); updateBuy(); }));
        sides.forEach((button) => button.addEventListener('click', () => buy(button)));
        document.querySelector('[data-session-resume]').addEventListener('click', () => { sessionIds.clear(); renderSession(); updateBuy(); });
        document.querySelectorAll('[data-activity-tab]').forEach((tab) => tab.addEventListener('click', () => {
            document.querySelectorAll('[data-activity-tab]').forEach((other) => { const on = other === tab; other.setAttribute('aria-selected', String(on)); other.tabIndex = on ? 0 : -1; });
            document.querySelector('[data-open-contracts]').hidden = tab.dataset.activityTab !== 'open';
            document.querySelector('[data-settled-contracts]').hidden = tab.dataset.activityTab !== 'settled';
        }));
        document.addEventListener('smartprofit:clear-trade-state', () => { teardown(); contracts = []; contractsLoaded = false; purchasedIds.clear(); notifiedIds.clear(); sessionIds.clear(); toastHost.replaceChildren(); renderContracts(); status.textContent = ''; clearTimeout(quoteTimer); intent = ''; idempotencyKey = ''; });
        document.addEventListener('smartprofit:account-changed', () => subscribe().then(changed).catch(report));
        // A resized chart is redrawn at its new size from the current buffer, and the digit pointer follows its digit.
        if (window.ResizeObserver) new window.ResizeObserver(scheduleChart).observe(canvas); else window.addEventListener('resize', scheduleChart);
        canvas.addEventListener('pointermove', (event) => { const box = canvas.getBoundingClientRect(); pointer = { x: event.clientX - box.left, y: event.clientY - box.top }; scheduleChart(); });
        for (const name of ['pointerleave', 'pointercancel']) canvas.addEventListener(name, () => { pointer = null; scheduleChart(); });
        if (!applyConfig(config)) retryConfig();
        await subscribe();
        changed();
        await window.refreshRestrictionBanner();
    }
    window.addEventListener('DOMContentLoaded', () => start().catch(report)); window.smartProfitTrade = { errorMessages: messages };
})();
