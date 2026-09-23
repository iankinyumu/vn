(function () {
    /* Startup is two steps. loadEngineConfig() needs no account: it opens the
       Supabase client and reads get_engine_config, so market data can render even
       when an account call fails. initAccountSwitcher() then enrolls the Practice
       account and selects it. Every failure is a StartupError naming the step that
       failed, so pages can tell the customer what is wrong without server detail. */
    class StartupError extends Error {
        constructor(step, cause, status) {
            super(`${step}: ${cause?.message || 'failed'}`);
            this.name = 'StartupError';
            this.step = step;
            this.cause = cause;
            this.status = status ?? null;
        }
    }
    const messages = Object.freeze({
        client: 'SmartProfit could not be reached. Check your connection and reload the page.',
        session: 'Your session has expired. Sign in again to continue.',
        get_engine_config: 'Index configuration is unavailable right now. Please try again shortly.',
        enroll_practice_account: 'Your Practice account could not be opened. Reload the page; if this continues, contact support.',
        list_my_accounts: 'Your accounts could not be loaded. Reload the page to try again.',
        practice_unavailable: 'Your Practice account is not available. Contact support for help.',
    });
    const sessionFailure = (cause, status) => status === 401 || cause?.code === 'PGRST301' || /jwt/i.test(String(cause?.message || ''));

    async function rpc(client, name, args) {
        const result = await client.rpc(name, args);
        if (result.error) throw new StartupError(sessionFailure(result.error, result.status) ? 'session' : name, result.error, result.status);
        return result.data;
    }

    let configPromise = null;
    function loadEngineConfig({ refresh = false } = {}) {
        if (!configPromise || refresh) {
            const pending = (async () => {
                let client;
                try { client = await window.getSupabaseClient(); } catch (error) { throw new StartupError('client', error); }
                const config = await rpc(client, 'get_engine_config');
                if (!config || typeof config !== 'object') throw new StartupError('get_engine_config', new Error('The configuration response was empty.'));
                return { client, config };
            })();
            configPromise = pending;
            // A failed load is never cached, so the next call retries.
            pending.catch(() => { if (configPromise === pending) configPromise = null; });
        }
        return configPromise;
    }

    // Customer-safe text for a startup failure; the detail goes to the console for support, never to the page.
    function startupMessage(error) {
        return messages[error?.step] || messages.client;
    }
    function logStartupFailure(error) {
        const cause = error?.cause;
        console.error('[smartprofit] startup failed', { step: error?.step || 'unknown', status: error?.status ?? null, code: cause?.code ?? null, message: cause?.message ?? error?.message, details: cause?.details ?? null, hint: cause?.hint ?? null });
    }

    function accountFields(account) {
        return { accountId: account.id, mode: account.execution_mode, currency: account.currency };
    }
    function markUnavailable(select) {
        if (!select) return;
        select.replaceChildren(new Option('Account unavailable', ''));
        select.disabled = true;
    }

    async function init() {
        const select = document.querySelector('[data-account-switcher]');
        try {
            const { client, config } = await loadEngineConfig();
            await rpc(client, 'enroll_practice_account');
            const accounts = await rpc(client, 'list_my_accounts');
            if (!Array.isArray(accounts)) throw new StartupError('list_my_accounts', new Error('The accounts response was not a list.'));
            const practice = accounts.find((account) => account.execution_mode === 'DEMO' && account.status === 'ACTIVE');
            if (!practice) throw new StartupError('practice_unavailable', new Error('Practice account is unavailable.'));
            const label = document.querySelector('[data-practice-ribbon]');
            const choose = (account) => {
                window.smartProfitAccount?.set(accountFields(account));
                if (label) label.hidden = account.execution_mode !== 'DEMO';
                document.dispatchEvent(new CustomEvent('smartprofit:account-changed', { detail: window.smartProfitAccount.get() }));
            };
            if (select) {
                select.replaceChildren();
                select.disabled = false;
                accounts.forEach((account) => {
                    const option = new Option(account.execution_mode === 'DEMO' ? 'Practice' : 'Real — Not available yet', account.id);
                    option.disabled = account.execution_mode === 'REAL' && !config.real_enabled;
                    select.add(option);
                });
                // Sessions start in Practice; the picker must show it whatever order the accounts arrive in.
                select.value = practice.id;
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
        } catch (error) {
            const failure = error instanceof StartupError ? error : new StartupError('client', error);
            markUnavailable(select);
            logStartupFailure(failure);
            throw failure;
        }
    }

    window.loadEngineConfig = loadEngineConfig;
    window.initAccountSwitcher = init;
    window.smartProfitStartup = Object.freeze({ message: startupMessage, log: logStartupFailure, StartupError });
})();
