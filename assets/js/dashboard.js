(function () {
    const resetMessages = Object.freeze({ account_not_available: 'This account cannot reset Practice funds.', open_contracts_exist: 'Practice funds can be reset after all open contracts settle.', reset_not_available: 'Your Practice balance is not eligible for reset.', reset_rate_limited: 'Practice funds can be reset once every 24 hours.' });
    const errorCode = (error) => String(error?.message || error?.code || '').match(/[a-z_]+/)?.[0];
    function contractRow(contract) { const row = document.createElement('tr'); row.innerHTML = `<td>${contract.index_code}</td><td>${contract.contract_type}</td><td>${contract.state}</td><td>${contract.stake}</td><td>${contract.payout}</td>`; return row; }
    async function start() {
        const { client, config } = await window.initAccountSwitcher();
        const render = async () => {
            const account = window.smartProfitAccount.get();
            const [summary, contracts] = await Promise.all([client.rpc('get_account_summary', { p_account_id: account.accountId }), client.rpc('list_my_contracts', { p_account_id: account.accountId, p_state: null, p_before: null, p_limit: 20 })]);
            if (summary.error) throw summary.error; if (contracts.error) throw contracts.error;
            const rows = contracts.data || []; const settled = rows.filter((contract) => contract.state !== 'OPEN');
            document.querySelector('[data-practice-balance]').textContent = `${summary.data.currency} ${Number(summary.data.available).toFixed(2)}`;
            document.querySelector('[data-wins]').textContent = settled.filter((contract) => contract.state === 'WON').length;
            document.querySelector('[data-losses]').textContent = settled.filter((contract) => contract.state === 'LOST').length;
            document.querySelector('[data-net-result]').textContent = settled.reduce((total, contract) => total + (contract.state === 'WON' ? Number(contract.payout) - Number(contract.stake) : -Number(contract.stake)), 0).toFixed(2);
            document.querySelector('[data-contract-rows]').replaceChildren(...rows.map(contractRow));
            const accountConfig = (config.accounts || []).find((item) => item.id === account.accountId);
            const canReset = account.mode === 'DEMO' && rows.every((contract) => contract.state !== 'OPEN') && Number(summary.data.available) < Number(accountConfig?.limits?.min_stake);
            document.querySelector('[data-reset]').hidden = !canReset;
        };
        document.querySelector('[data-reset]').addEventListener('click', async () => { const { error } = await client.rpc('reset_practice_balance', { p_account_id: window.smartProfitAccount.get().accountId }); const status = document.querySelector('[data-dashboard-status]'); status.textContent = error ? (resetMessages[errorCode(error)] || 'Practice funds could not be reset.') : 'Practice balance reset.'; if (!error) await render(); });
        document.addEventListener('smartprofit:account-changed', () => render().catch((error) => { console.error(error); document.querySelector('[data-dashboard-status]').textContent = 'Unable to load account data.'; })); await render(); await window.refreshRestrictionBanner();
    }
    window.addEventListener('DOMContentLoaded', () => start().catch((error) => { console.error(error); document.querySelector('[data-dashboard-status]').textContent = 'Unable to load account data.'; })); window.smartProfitDashboard = { resetMessages };
})();
