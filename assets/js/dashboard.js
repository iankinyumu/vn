(function () {
    const resetMessages = Object.freeze({ account_not_available: 'This account cannot reset Practice funds.', open_contracts_exist: 'Practice funds can be reset after all open contracts settle.', reset_not_available: 'Your Practice balance is not eligible for reset.', reset_rate_limited: 'Practice funds can be reset once every 24 hours.' });
    // Index prices and the chart refresh on this cadence while the tab is visible; the trade page carries the live feed.
    const MARKET_REFRESH_MS = 10000;
    const CHART_TICKS = 120;
    const UNAVAILABLE = 'Unavailable';
    const errorCode = (error) => String(error?.message || error?.code || '').match(/[a-z_]+/)?.[0];
    const find = (selector) => document.querySelector(selector);
    const text = (selector, value) => { const node = find(selector); if (node) node.textContent = value; };
    function cellRow(values) { const row = document.createElement('tr'); values.forEach((value) => { const cell = document.createElement('td'); if (value instanceof Node) cell.append(value); else cell.textContent = value; row.append(cell); }); return row; }
    function noteRow(columns, message) { const row = document.createElement('tr'); const cell = document.createElement('td'); cell.colSpan = columns; cell.className = 'text-secondary'; cell.textContent = message; row.append(cell); return row; }
    const contractType = (contract) => `${contract.contract_type}${contract.barrier === null || contract.barrier === undefined ? '' : ` ${contract.barrier}`}`;
    function contractRow(contract) { return cellRow([contract.index_code, contract.contract_type, contract.state, contract.stake, contract.payout]); }
    function priceWithDigit(price, decimals) {
        const fixed = Number(price).toFixed(decimals);
        const node = document.createElement('span');
        const digit = document.createElement('strong');
        digit.textContent = fixed.at(-1);
        node.append(document.createTextNode(fixed.slice(0, -1)), digit);
        return node;
    }
    const status = (message) => text('[data-dashboard-status]', message);

    /* Market data (index facts, chart, latest ticks, indices table) needs only the
       engine configuration, so it starts before, and independently of, the
       account calls. A failed account call never hides working market data. */
    function startMarket(client, config) {
        const indices = config.indices || [];
        let chartIndex = indices[0]?.code || null;
        let timer = null;
        async function rpc(name, args) { const { data, error } = await client.rpc(name, args); if (error) throw error; return data; }

        function renderIndexFacts() {
            const open = indices.filter((item) => item.status === 'ACTIVE').length;
            text('[data-index-count]', indices.length ? `${open} / ${indices.length}` : 'None');
            const intervals = [...new Set(indices.map((item) => Number(item.interval_ms)))];
            text('[data-tick-interval]', intervals.length === 1 ? `${intervals[0] / 1000} s` : intervals.length ? `${Math.min(...intervals) / 1000}-${Math.max(...intervals) / 1000} s` : '—');
            text('[data-contract-types]', (config.enabled_contract_types || []).join(' · ') || 'None enabled');
            find('[data-chart-indices]')?.replaceChildren(...indices.map((item) => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = `btn btn-timeframe${item.code === chartIndex ? ' active' : ''}`;
                button.textContent = item.code;
                button.setAttribute('aria-pressed', String(item.code === chartIndex));
                button.addEventListener('click', () => { chartIndex = item.code; renderIndexFacts(); refreshChart().catch(chartFailed); });
                return button;
            }));
        }

        async function refreshChart() {
            const index = indices.find((item) => item.code === chartIndex);
            if (!index) { text('[data-chart-status]', 'No indices are configured yet.'); return; }
            const recent = (await rpc('get_recent_ticks', { p_index: index.code, p_limit: CHART_TICKS }) || []).slice().reverse();
            if (index.code !== chartIndex) return;
            text('[data-chart-title]', `${index.display_name || index.code} price`);
            const canvas = find('[data-index-chart]');
            if (canvas && window.drawIndexChart) window.drawIndexChart(canvas, recent);
            text('[data-chart-status]', recent.length ? '' : `No ticks published yet for ${index.display_name || index.code}.`);
            const latest = find('[data-latest-ticks]');
            if (!latest) return;
            if (!recent.length) { latest.replaceChildren(Object.assign(document.createElement('div'), { className: 'ob-mini-row', textContent: 'No ticks published yet.' })); return; }
            latest.replaceChildren(...recent.slice(-10).reverse().map((tick) => {
                const row = document.createElement('div');
                row.className = `ob-mini-row digit-row ${Number(tick.digit) % 2 ? 'digit-odd' : 'digit-even'}`;
                const number = document.createElement('span');
                number.textContent = `#${tick.tick_no}`;
                row.append(number, priceWithDigit(tick.price, Number(index.decimals)));
                return row;
            }));
        }
        function chartFailed(error) {
            console.error('[smartprofit] index chart failed', error);
            text('[data-chart-status]', 'Index prices could not be loaded.');
            find('[data-latest-ticks]')?.replaceChildren(Object.assign(document.createElement('div'), { className: 'ob-mini-row', textContent: 'Index prices could not be loaded.' }));
        }

        async function refreshIndexTable() {
            const latest = await Promise.all(indices.map((item) => rpc('get_recent_ticks', { p_index: item.code, p_limit: 1 }).then((rows) => rows?.[0] || null)));
            find('[data-index-rows]')?.replaceChildren(...(indices.length ? indices.map((item, position) => {
                const tick = latest[position];
                const trade = document.createElement('a');
                trade.className = 'btn btn-timeframe btn-sm';
                trade.href = `trade.html?index=${encodeURIComponent(item.code)}`;
                trade.textContent = 'Trade';
                const state = document.createElement('span');
                state.className = item.status === 'ACTIVE' ? 'text-success' : 'text-warning';
                state.textContent = item.status === 'ACTIVE' ? 'Open' : 'Paused';
                return cellRow([position + 1, item.display_name || item.code, tick ? priceWithDigit(tick.price, Number(item.decimals)) : 'No ticks yet', tick ? tick.digit : '—', tick ? `#${tick.tick_no}` : '—', state, trade]);
            }) : [noteRow(7, 'No indices are configured yet.')]));
            text('[data-index-updated]', `UPDATED ${new Date().toLocaleTimeString()}`);
            text('[data-market-state]', latest.some(Boolean) ? 'Live indices' : 'No ticks published yet');
        }
        function tableFailed(error) {
            console.error('[smartprofit] index table failed', error);
            text('[data-index-updated]', 'UNAVAILABLE');
            text('[data-market-state]', 'Index data unavailable');
            find('[data-index-rows]')?.replaceChildren(noteRow(7, 'Index data could not be loaded. It will retry automatically.'));
        }

        const refresh = () => Promise.all([refreshChart().catch(chartFailed), refreshIndexTable().catch(tableFailed)]);
        renderIndexFacts();
        timer = setInterval(() => { if (!document.hidden) refresh(); }, MARKET_REFRESH_MS);
        return { refresh, stop: () => clearInterval(timer) };
    }

    /* Account data is bound to the active account. Each call succeeds or fails on
       its own: a failure shows "Unavailable" and names what failed, while a genuine
       zero from the server is shown as zero. Responses for a previous account are
       discarded. */
    function clearAccountView() {
        for (const selector of ['[data-practice-balance]', '[data-net-result]', '[data-wins]', '[data-losses]', '[data-win-rate]', '[data-voids]', '[data-settled-count]']) text(selector, '—');
        find('[data-contract-rows]')?.replaceChildren(noteRow(5, 'Loading contracts…'));
        find('[data-open-contracts]')?.replaceChildren(noteRow(5, 'Loading open contracts…'));
        const reset = find('[data-reset]');
        if (reset) reset.hidden = true;
    }

    async function renderAccount(client, config) {
        const account = window.smartProfitAccount.get();
        const call = (name, args) => client.rpc(name, args).then((result) => { if (result.error) throw result.error; return result.data; });
        const [summary, stats, latest, open] = await Promise.allSettled([
            call('get_account_summary', { p_account_id: account.accountId }),
            call('get_account_stats', { p_account_id: account.accountId }),
            call('list_my_contracts', { p_account_id: account.accountId, p_state: null, p_before: null, p_limit: 20 }),
            call('list_my_contracts', { p_account_id: account.accountId, p_state: 'OPEN', p_before: null, p_limit: 100 }),
        ]);
        if (account.accountId !== window.smartProfitAccount.get().accountId) return;
        const failed = [];

        if (summary.status === 'fulfilled') text('[data-practice-balance]', `${summary.value.currency} ${Number(summary.value.available).toFixed(2)}`);
        else { text('[data-practice-balance]', UNAVAILABLE); failed.push(['balance', summary.reason]); }

        if (stats.status === 'fulfilled') {
            const value = stats.value;
            const decided = Number(value.wins) + Number(value.losses);
            text('[data-wins]', value.wins);
            text('[data-losses]', value.losses);
            text('[data-voids]', `${value.voids} voided · ${value.open} open`);
            text('[data-net-result]', `${value.currency} ${Number(value.net_result).toFixed(2)}`);
            text('[data-win-rate]', decided ? `${(Number(value.wins) / decided * 100).toFixed(1)}%` : 'No results yet');
            text('[data-settled-count]', decided + Number(value.voids));
        } else {
            for (const selector of ['[data-wins]', '[data-losses]', '[data-net-result]', '[data-win-rate]', '[data-settled-count]']) text(selector, UNAVAILABLE);
            text('[data-voids]', '');
            failed.push(['results', stats.reason]);
        }

        if (latest.status === 'fulfilled') {
            const rows = latest.value || [];
            find('[data-contract-rows]').replaceChildren(...(rows.length ? rows.map(contractRow) : [noteRow(5, 'No contracts yet. Contracts you buy on the Trade page appear here.')]));
        } else { find('[data-contract-rows]').replaceChildren(noteRow(5, 'Your contract history could not be loaded.')); failed.push(['contract history', latest.reason]); }

        if (open.status === 'fulfilled') {
            const rows = (open.value || []).filter((contract) => contract.state === 'OPEN');
            find('[data-open-contracts]')?.replaceChildren(...(rows.length ? rows.map((contract) => cellRow([contract.index_code, contractType(contract), Number(contract.stake).toFixed(2), Number(contract.payout).toFixed(2), `${contract.entry_tick_no} → ${contract.settle_tick_no}`])) : [noteRow(5, 'No open contracts.')]));
        } else { find('[data-open-contracts]')?.replaceChildren(noteRow(5, 'Open contracts could not be loaded.')); failed.push(['open contracts', open.reason]); }

        const accountConfig = (config.accounts || []).find((item) => item.id === account.accountId);
        const canReset = summary.status === 'fulfilled' && stats.status === 'fulfilled' && account.mode === 'DEMO' && Number(stats.value.open) === 0 && Number(summary.value.available) < Number(accountConfig?.limits?.min_stake);
        find('[data-reset]').hidden = !canReset;
        failed.forEach(([part, reason]) => console.error(`[smartprofit] ${part} could not be loaded`, { code: reason?.code ?? null, message: reason?.message ?? String(reason) }));
        status(failed.length ? `Some account data could not be loaded: ${failed.map(([part]) => part).join(', ')}. Market data below is unaffected; reload to try again.` : '');
    }

    async function start() {
        let engine;
        try { engine = await window.loadEngineConfig(); } catch (error) { window.smartProfitStartup?.log(error); status(window.smartProfitStartup?.message(error) || 'SmartProfit could not be reached.'); return; }
        const { client, config } = engine;
        const market = startMarket(client, config);
        const marketLoaded = market.refresh();
        let accountConfig;
        try { ({ config: accountConfig } = await window.initAccountSwitcher()); } catch (error) {
            status(window.smartProfitStartup?.message(error) || 'Your account could not be loaded.');
            for (const selector of ['[data-practice-balance]', '[data-net-result]', '[data-wins]', '[data-win-rate]']) text(selector, UNAVAILABLE);
            find('[data-contract-rows]')?.replaceChildren(noteRow(5, 'Account data is unavailable.'));
            find('[data-open-contracts]')?.replaceChildren(noteRow(5, 'Account data is unavailable.'));
            await marketLoaded;
            return;
        }
        const render = () => { clearAccountView(); return renderAccount(client, accountConfig || config).catch((error) => { console.error(error); status('Your account data could not be loaded. Reload to try again.'); }); };
        find('[data-reset]').addEventListener('click', async () => { const { error } = await client.rpc('reset_practice_balance', { p_account_id: window.smartProfitAccount.get().accountId }); status(error ? (resetMessages[errorCode(error)] || 'Practice funds could not be reset.') : 'Practice balance reset.'); if (!error) await render(); });
        document.addEventListener('smartprofit:account-changed', render);
        await render();
        await window.refreshRestrictionBanner?.().catch?.(console.error);
        await marketLoaded;
    }
    window.addEventListener('DOMContentLoaded', () => start().catch((error) => { console.error(error); status('The dashboard could not load. Reload the page to try again.'); })); window.smartProfitDashboard = { resetMessages };
})();
