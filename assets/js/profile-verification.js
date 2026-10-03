/* Profile: the customer's own verification status and the way into it (pages/verification.html).
   Verification is never forced; this is where a customer chooses to start, continue or review it. */
(function () {
    'use strict';
    async function render() {
        const root = document.querySelector('[data-verification]');
        if (!root) return;
        const status = root.querySelector('[data-verification-status]');
        const link = root.querySelector('[data-verification-link]');
        try {
            const client = await window.getSupabaseClient();
            const { data, error } = await client.rpc('get_my_verification');
            if (error || !data) throw error || new Error('no data');
            if (data.status === 'completed') {
                const when = data.completed_at ? new Date(data.completed_at).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : '';
                status.textContent = `Submitted${when ? ` on ${when}` : ''}. To change a detail, contact support.`;
                return;
            } else if (data.status === 'in_progress') {
                status.textContent = `In progress: step ${Math.min(Number(data.current_step) || 1, 6)} of 6.`;
                link.textContent = 'Continue verification';
            } else {
                status.textContent = 'Not started.';
                link.textContent = 'Start verification';
            }
            link.hidden = false;
        } catch (_) {
            status.textContent = 'Your verification status could not be loaded. Reload the page to try again.';
        }
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render, { once: true });
    else render();
})();
