(function () {
    /* The account the page is acting on. A Real "preview" (preview: true) is the Real view shown
       while Real deposits and withdrawals are not connected: pages show it as a Real account with a
       zero balance and keep its actions (buy, deposit, withdraw) disabled. It has no server-side
       trading account, so pages must never send its id to an account RPC; they check isPreview(). */
    const REAL_PREVIEW_ID = 'real-preview';
    let context = null;
    const listeners = new Set();
    function requireContext() {
        if (!context) throw new Error('An active account is required.');
        return { ...context };
    }
    function set(next) {
        if (!next || !next.accountId || !next.mode || !next.currency) throw new Error('Account context is incomplete.');
        context = Object.freeze({ accountId: next.accountId, mode: next.mode, currency: next.currency, preview: next.accountId === REAL_PREVIEW_ID });
        document.body.dataset.mode = context.mode.toLowerCase();
        listeners.forEach((listener) => listener(requireContext()));
        return requireContext();
    }
    const isPreview = () => Boolean(context?.preview);
    window.smartProfitAccount = Object.freeze({ get: requireContext, set, isPreview, previewId: REAL_PREVIEW_ID, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } });
})();
