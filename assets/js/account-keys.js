(function () {
    function key(name) {
        const { accountId, mode } = window.smartProfitAccount.get();
        return `${mode.toLowerCase()}:${accountId}:${name}`;
    }
    function clearAccountScoped() {
        const { accountId, mode } = window.smartProfitAccount.get();
        const prefix = `${mode.toLowerCase()}:${accountId}:`;
        [localStorage, sessionStorage].forEach((storage) => Object.keys(storage).filter((item) => item.startsWith(prefix)).forEach((item) => storage.removeItem(item)));
    }
    window.smartProfitAccountKeys = Object.freeze({ key, clearAccountScoped });
})();
