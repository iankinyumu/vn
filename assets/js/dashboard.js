(function () {
    async function start() {
        const { client } = await window.initAccountSwitcher();
        const render = async () => {
            const account = window.smartProfitAccount.get();
            const [summary, contracts] = await Promise.all([client.rpc('get_account_summary', { p_account_id: account.accountId }), client.rpc('list_my_contracts', { p_account_id: account.accountId, p_state: null, p_before: null, p_limit: 20 })]);
            if (summary.error) throw summary.error; if (contracts.error) throw contracts.error;
            document.querySelector('[data-practice-balance]').textContent = `${summary.data.currency} ${Number(summary.data.available).toFixed(2)}`;
            const settled = (contracts.data || []).filter((contract) => contract.state !== 'OPEN');
            document.querySelector('[data-wins]').textContent = settled.filter((contract) => contract.state === 'WON').length;
            document.querySelector('[data-losses]').textContent = settled.filter((contract) => contract.state === 'LOST').length;
            document.querySelector('[data-net-result]').textContent = settled.reduce((total, contract) => total + (contract.state === 'WON' ? Number(contract.payout) - Number(contract.stake) : -Number(contract.stake)), 0).toFixed(2);
            const body = document.querySelector('[data-contract-rows]'); body.replaceChildren(...(contracts.data || []).map((contract) => { const row = document.createElement('tr'); row.innerHTML = `<td>${contract.index_code}</td><td>${contract.contract_type}</td><td>${contract.state}</td><td>${contract.stake}</td><td>${contract.payout}</td>`; return row; }));
            document.querySelector('[data-reset]').hidden = account.mode !== 'DEMO';
        };
        document.querySelector('[data-reset]').addEventListener('click', async () => { const { error } = await client.rpc('reset_practice_balance', { p_account_id: window.smartProfitAccount.get().accountId }); document.querySelector('[data-dashboard-status]').textContent = error ? String(error.message) : 'Practice balance reset.'; if (!error) render(); });
        document.addEventListener('smartprofit:account-changed', render); await render(); await window.refreshRestrictionBanner();
    }
    window.addEventListener('DOMContentLoaded', () => start().catch((error) => { console.error(error); document.querySelector('[data-dashboard-status]').textContent = 'Unable to load account data.'; }));
})();
