(function () {
    let context = null;
    const listeners = new Set();
    function requireContext() {
        if (!context) throw new Error('An active account is required.');
        return { ...context };
    }
    function set(next) {
        if (!next || !next.accountId || !next.mode || !next.currency) throw new Error('Account context is incomplete.');
        context = Object.freeze({ accountId: next.accountId, mode: next.mode, currency: next.currency });
        document.body.dataset.mode = context.mode.toLowerCase();
        listeners.forEach((listener) => listener(requireContext()));
        return requireContext();
    }
    window.smartProfitAccount = Object.freeze({ get: requireContext, set, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } });
})();
