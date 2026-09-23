(function () {
    async function rpc(client, name, args) {
        const result = await client.rpc(name, args);
        if (result.error) throw result.error;
        return result.data;
    }
    function accountFields(account) {
        return { accountId: account.id, mode: account.execution_mode, currency: account.currency };
    }
    async function init() {
        const client = await window.getSupabaseClient();
        await rpc(client, 'enroll_practice_account');
        const config = await rpc(client, 'get_engine_config');
        const accounts = await rpc(client, 'list_my_accounts');
        if (!Array.isArray(accounts)) throw new Error('Accounts could not be loaded.');
        const practice = accounts.find((account) => account.execution_mode === 'DEMO' && account.status === 'ACTIVE');
        if (!practice) throw new Error('Practice account is unavailable.');
        const select = document.querySelector('[data-account-switcher]');
        const label = document.querySelector('[data-practice-ribbon]');
        const choose = (account) => {
            window.smartProfitAccount?.set(accountFields(account));
            if (label) label.hidden = account.execution_mode !== 'DEMO';
            document.dispatchEvent(new CustomEvent('smartprofit:account-changed', { detail: window.smartProfitAccount.get() }));
        };
        if (select) {
            select.replaceChildren();
            accounts.forEach((account) => {
                const option = new Option(account.execution_mode === 'DEMO' ? 'Practice' : 'Real — Not available yet', account.id);
                option.disabled = account.execution_mode === 'REAL' && !config.real_enabled;
                select.add(option);
            });
            select.addEventListener('change', () => {
                const selected = accounts.find((account) => account.id === select.value);
                if (!selected || selected.status !== 'ACTIVE') return;
                window.smartProfitAccountKeys?.clearAccountScoped();
                window.smartProfitCache?.clear();
                document.dispatchEvent(new Event('smartprofit:clear-trade-state'));
                choose(selected);
            });
        }
        choose(practice);
        return { client, config, accounts };
    }
    window.initAccountSwitcher = init;
})();
