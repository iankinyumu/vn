(function () {
    async function refresh() {
        const banner = document.querySelector('[data-restriction-banner]');
        if (!banner) return;
        const client = await window.getSupabaseClient();
        const { data, error } = await client.rpc('get_my_active_restrictions');
        if (error) { console.error(error); return; }
        const restrictions = data || [];
        const mode = window.smartProfitAccount.get().mode;
        const active = restrictions.filter((item) => item.scope === 'ALL' || item.scope === mode);
        banner.hidden = active.length === 0;
        banner.textContent = active.map((item) => {
            const state = item.severity === 'BLOCKED' ? 'Trading is blocked' : item.severity === 'LIMITED' ? `Trading limits apply (${Object.entries(item.params || {}).map(([key, value]) => `${key}: ${value}`).join(', ')})` : 'Trading notice';
            return `${state}: ${item.reason}${item.expires_at ? ` until ${new Date(item.expires_at).toLocaleString()}` : ''}`;
        }).join(' ');
    }
    window.refreshRestrictionBanner = refresh;
})();
