(() => {
    'use strict';
    async function load() {
        const status = document.getElementById('accountStatus');
        const balance = document.getElementById('practiceBalance');
        if (!status || !balance || typeof window.getSupabaseClient !== 'function') return;
        try {
            const client = await window.getSupabaseClient();
            const accounts = await client.rpc('list_my_accounts');
            if (accounts.error) throw accounts.error;
            const account = (accounts.data || []).find((item) => item.execution_mode === 'DEMO');
            if (!account) { status.textContent = 'Practice account is unavailable.'; return; }
            const summary = await client.rpc('get_account_summary', { p_account_id: account.id });
            if (summary.error) throw summary.error;
            balance.textContent = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(summary.data.available || 0));
            status.textContent = 'Practice mode · virtual funds';
        } catch (error) {
            console.error('Unable to load practice account', error);
            status.textContent = 'Your practice account could not be loaded.';
        }
    }
    document.addEventListener('DOMContentLoaded', load);
})();
