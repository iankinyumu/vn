(function () {
    async function refresh() {
        const banner = document.querySelector('[data-restriction-banner]');
        if (!banner) return;
        const client = await window.getSupabaseClient();
        const { data, error } = await client.rpc('get_my_active_restrictions');
        if (error) { console.error(error); return; }
        const restrictions = data || [];
        const active = restrictions.filter((item) => !item.execution_mode || item.execution_mode === window.smartProfitAccount.get().mode);
        banner.hidden = active.length === 0;
        banner.textContent = active.map((item) => `${item.severity === 'BLOCKED' ? 'Trading is blocked' : 'Trading limits apply'}: ${item.reason}${item.expires_at ? ` until ${new Date(item.expires_at).toLocaleString()}` : ''}`).join(' ');
    }
    window.refreshRestrictionBanner = refresh;
})();
