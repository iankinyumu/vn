/* Display-only cache. Trading authorization and balances are checked on the server. */
(function () {
    const prefix = 'smartprofit:account:v1:';
    const pending = new Map();
    let generation = 0;
    function clear() {
        generation++;
        pending.clear();
        try {
            Object.keys(sessionStorage).filter((key) => key.startsWith(prefix)).forEach((key) => sessionStorage.removeItem(key));
        } catch (_) { /* Storage may be disabled. */ }
    }
    async function read(scope, name, loader, ttl = 15000) {
        const key = prefix + scope + ':' + name;
        try {
            const cached = JSON.parse(sessionStorage.getItem(key));
            if (cached && cached.expires > Date.now()) return cached.value;
        } catch (_) { /* Ignore unavailable or malformed storage. */ }
        if (pending.has(key)) return pending.get(key);
        const version = generation;
        const promise = Promise.resolve().then(loader).then((value) => {
            if (!value.error && version === generation) {
                try { sessionStorage.setItem(key, JSON.stringify({ expires: Date.now() + ttl, value })); } catch (_) { /* Read still succeeds. */ }
            }
            return value;
        }).finally(() => { if (pending.get(key) === promise) pending.delete(key); });
        pending.set(key, promise);
        return promise;
    }
    window.smartProfitCache = { read, clear };
})();
