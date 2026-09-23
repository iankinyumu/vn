(function () {
    const resetMessages = Object.freeze({ account_not_available: 'This account cannot reset Practice funds.', open_contracts_exist: 'Practice funds can be reset after all open contracts settle.', reset_not_available: 'Your Practice balance is not eligible for reset.', reset_rate_limited: 'Practice funds can be reset once every 24 hours.' });
    // Index prices and the chart refresh on this cadence while the tab is visible; the trade page carries the live feed.
    const MARKET_REFRESH_MS = 10000;
    const CHART_TICKS = 120;
    const errorCode = (error) => String(error?.message || error?.code || '').match(/[a-z_]+/)?.[0];
    const text = (selector, value) => { const node = document.querySelector(selector); if (node) node.textContent = value; };
    function cellRow(values) { const row = document.createElement('tr'); values.forEach((value) => { const cell = document.createElement('td'); if (value instanceof Node) cell.append(value); else cell.textContent = value; row.append(cell); }); return row; }
    function emptyRow(columns, message) { const row = document.createElement('tr'); const cell = document.createElement('td'); cell.colSpan = columns; cell.className = 'text-secondary'; cell.textContent = message; row.append(cell); return row; }
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

    async function start() {
        const { client, config } = await window.initAccountSwitcher();
        const indices = config.indices || [];
        let chartIndex = indices[0]?.code || null;
        let marketTimer = null;

        async function rpc(name, args) { const { data, error } = await client.rpc(name, args); if (error) throw error; return data; }

        const render = async () => {
            const account = window.smartProfitAccount.get();
            // Wins, losses and net result are lifetime aggregates computed on the server; the table lists only the latest 20 contracts.
            const [summary, stats, contracts, open] = await Promise.all([
                client.rpc('get_account_summary', { p_account_id: account.accountId }),
                client.rpc('get_account_stats', { p_account_id: account.accountId }),
                client.rpc('list_my_contracts', { p_account_id: account.accountId, p_state: null, p_before: null, p_limit: 20 }),
                client.rpc('list_my_contracts', { p_account_id: account.accountId, p_state: 'OPEN', p_before: null, p_limit: 100 }),
            ]);
            for (const result of [summary, stats, contracts, open]) if (result.error) throw result.error;
            if (account.accountId !== window.smartProfitAccount.get().accountId) return;
            const rows = contracts.data || [];
            const decided = Number(stats.data.wins) + Number(stats.data.losses);
            text('[data-practice-balance]', `${summary.data.currency} ${Number(summary.data.available).toFixed(2)}`);
            text('[data-wins]', stats.data.wins);
            text('[data-losses]', stats.data.losses);
            text('[data-voids]', `${stats.data.voids} voided · ${stats.data.open} open`);
            text('[data-net-result]', `${stats.data.currency} ${Number(stats.data.net_result).toFixed(2)}`);
            text('[data-win-rate]', decided ? `${(Number(stats.data.wins) / decided * 100).toFixed(1)}%` : '—');
            text('[data-settled-count]', decided + Number(stats.data.voids));
            document.querySelector('[data-contract-rows]').replaceChildren(...rows.map(contractRow));
            const openRows = (open.data || []).filter((contract) => contract.state === 'OPEN');
            document.querySelector('[data-open-contracts]')?.replaceChildren(...(openRows.length ? openRows.map((contract) => cellRow([contract.index_code, contractType(contract), Number(contract.stake).toFixed(2), Number(contract.payout).toFixed(2), `${contract.entry_tick_no} → ${contract.settle_tick_no}`])) : [emptyRow(5, 'No open contracts.')]));
            const accountConfig = (config.accounts || []).find((item) => item.id === account.accountId);
            const canReset = account.mode === 'DEMO' && Number(stats.data.open) === 0 && Number(summary.data.available) < Number(accountConfig?.limits?.min_stake);
            document.querySelector('[data-reset]').hidden = !canReset;
        };

        // Index facts come from get_engine_config; prices from the shared tick stream.
        function renderIndexFacts() {
            const open = indices.filter((item) => item.status === 'ACTIVE').length;
            text('[data-index-count]', indices.length ? `${open} / ${indices.length}` : '—');
            const intervals = [...new Set(indices.map((item) => Number(item.interval_ms)))];
            text('[data-tick-interval]', intervals.length === 1 ? `${intervals[0] / 1000} s` : intervals.length ? `${Math.min(...intervals) / 1000}-${Math.max(...intervals) / 1000} s` : '—');
            text('[data-contract-types]', (config.enabled_contract_types || []).join(' · ') || '—');
            const buttons = document.querySelector('[data-chart-indices]');
            buttons?.replaceChildren(...indices.map((item) => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = `btn btn-timeframe${item.code === chartIndex ? ' active' : ''}`;
                button.textContent = item.code;
                button.setAttribute('aria-pressed', String(item.code === chartIndex));
                button.addEventListener('click', () => { chartIndex = item.code; renderIndexFacts(); refreshChart().catch(reportMarket); });
                return button;
            }));
        }

        async function refreshChart() {
            const index = indices.find((item) => item.code === chartIndex);
            if (!index) return;
            const recent = (await rpc('get_recent_ticks', { p_index: index.code, p_limit: CHART_TICKS }) || []).slice().reverse();
            if (index.code !== chartIndex) return;
            text('[data-chart-title]', `${index.display_name || index.code} price`);
            const canvas = document.querySelector('[data-index-chart]');
            if (canvas && window.drawIndexChart) window.drawIndexChart(canvas, recent);
            document.querySelector('[data-latest-ticks]')?.replaceChildren(...(recent.length ? recent.slice(-10).reverse().map((tick) => {
                const row = document.createElement('div');
                row.className = `ob-mini-row digit-row ${Number(tick.digit) % 2 ? 'digit-odd' : 'digit-even'}`;
                const number = document.createElement('span');
                number.textContent = `#${tick.tick_no}`;
                row.append(number, priceWithDigit(tick.price, Number(index.decimals)));
                return row;
            }) : [Object.assign(document.createElement('div'), { className: 'ob-mini-row', textContent: 'No ticks published yet.' })]));
        }

        async function refreshIndexTable() {
            const latest = await Promise.all(indices.map((item) => rpc('get_recent_ticks', { p_index: item.code, p_limit: 1 }).then((rows) => rows?.[0] || null)));
            document.querySelector('[data-index-rows]')?.replaceChildren(...(indices.length ? indices.map((item, position) => {
                const tick = latest[position];
                const trade = document.createElement('a');
                trade.className = 'btn btn-timeframe btn-sm';
                trade.href = `trade.html?index=${encodeURIComponent(item.code)}`;
                trade.textContent = 'Trade';
                const status = document.createElement('span');
                status.className = item.status === 'ACTIVE' ? 'text-success' : 'text-warning';
                status.textContent = item.status === 'ACTIVE' ? 'Open' : 'Paused';
                return cellRow([position + 1, item.display_name || item.code, tick ? priceWithDigit(tick.price, Number(item.decimals)) : '—', tick ? tick.digit : '—', tick ? `#${tick.tick_no}` : '—', status, trade]);
            }) : [emptyRow(7, 'No indices are available.')]));
            text('[data-index-updated]', `UPDATED ${new Date().toLocaleTimeString()}`);
            text('[data-market-state]', 'Live indices');
        }

        function reportMarket(error) { console.error(error); text('[data-index-updated]', 'UNAVAILABLE'); text('[data-market-state]', 'Index data unavailable'); }
        const refreshMarket = () => Promise.all([refreshChart(), refreshIndexTable()]).catch(reportMarket);
        function scheduleMarket() {
            clearInterval(marketTimer);
            marketTimer = setInterval(() => { if (!document.hidden) refreshMarket(); }, MARKET_REFRESH_MS);
        }

        document.querySelector('[data-reset]').addEventListener('click', async () => { const { error } = await client.rpc('reset_practice_balance', { p_account_id: window.smartProfitAccount.get().accountId }); const status = document.querySelector('[data-dashboard-status]'); status.textContent = error ? (resetMessages[errorCode(error)] || 'Practice funds could not be reset.') : 'Practice balance reset.'; if (!error) await render(); });
        document.addEventListener('smartprofit:account-changed', () => render().catch((error) => { console.error(error); document.querySelector('[data-dashboard-status]').textContent = 'Unable to load account data.'; }));
        renderIndexFacts();
        await render();
        await window.refreshRestrictionBanner();
        await refreshMarket();
        scheduleMarket();
    }
    window.addEventListener('DOMContentLoaded', () => start().catch((error) => { console.error(error); document.querySelector('[data-dashboard-status]').textContent = 'Unable to load account data.'; })); window.smartProfitDashboard = { resetMessages };
})();
