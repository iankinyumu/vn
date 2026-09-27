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
    // Daraja sandbox testing lives in Real mode only. For an owner-enabled sandbox
    // tester the switcher's Real entry opens the Real sandbox page; it never
    // selects a trading account, so Practice stays strictly virtual and Real
    // trading stays closed. Everyone else learns nothing.
    const REAL_SANDBOX = 'real-sandbox';
    const REAL_SANDBOX_PAGE = 'sandbox-deposit.html';
    async function sandboxOverview(client) {
        try {
            const { data, error } = await client.rpc('funding_sandbox_overview');
            return !error && data?.available === true ? data : null;
        } catch (_) { return null; }
    }

    const RESET_MESSAGES = Object.freeze({
        open_contracts_exist: 'Wait for open trades to settle before resetting.',
        reset_rate_limited: 'Practice funds can be reset once every 24 hours.',
        reset_not_available: 'Practice funds can be reset once the balance is below the minimum stake.',
    });
    const money = (value, currency = 'USD') => new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(Number(value));
    const errorCode = (error) => String(error?.message || error?.code || '').match(/[a-z_]+/)?.[0];

    function element(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    /* The mode switch is a plain text button (mode, balance, caret) that opens a
       menu of accounts. It renders into [data-account-switcher]. */
    function buildSwitch(host) {
        host.classList.add('mode-switch');
        const toggle = element('button', 'mode-switch-toggle');
        toggle.type = 'button';
        toggle.setAttribute('aria-haspopup', 'menu');
        toggle.setAttribute('aria-expanded', 'false');
        toggle.setAttribute('aria-controls', 'modeSwitchMenu');
        const label = element('span', 'mode-switch-label', '');
        label.dataset.modeLabel = '';
        const balance = element('span', 'mode-switch-balance', '—');
        balance.dataset.modeBalance = '';
        balance.setAttribute('aria-live', 'polite');
        const caret = element('i', 'fas fa-chevron-down mode-switch-caret');
        caret.setAttribute('aria-hidden', 'true');
        toggle.append(label, balance, caret);
        const menu = element('div', 'mode-menu');
        menu.id = 'modeSwitchMenu';
        menu.setAttribute('role', 'menu');
        menu.setAttribute('aria-label', 'Account');
        menu.hidden = true;
        const note = element('p', 'mode-menu-note');
        note.dataset.modeNote = '';
        note.setAttribute('role', 'status');
        note.hidden = true;
        host.replaceChildren(toggle, menu, note);

        const items = () => [...menu.querySelectorAll('[role^="menuitem"]:not([disabled]):not([hidden])')];
        const close = (focus = false) => { menu.hidden = true; toggle.setAttribute('aria-expanded', 'false'); if (focus) toggle.focus(); };
        const open = () => { note.hidden = true; menu.hidden = false; toggle.setAttribute('aria-expanded', 'true'); (menu.querySelector('[aria-checked="true"]:not([disabled])') || items()[0])?.focus(); };
        toggle.addEventListener('click', () => (menu.hidden ? open() : close()));
        toggle.addEventListener('keydown', (event) => { if (event.key === 'ArrowDown' && menu.hidden) { event.preventDefault(); open(); } });
        menu.addEventListener('keydown', (event) => {
            const list = items(); const at = list.indexOf(document.activeElement);
            if (event.key === 'Escape') { event.preventDefault(); close(true); }
            else if (event.key === 'ArrowDown') { event.preventDefault(); list[(at + 1) % list.length]?.focus(); }
            else if (event.key === 'ArrowUp') { event.preventDefault(); list[(at - 1 + list.length) % list.length]?.focus(); }
            else if (event.key === 'Tab') close();
        });
        document.addEventListener('pointerdown', (event) => { if (!host.contains(event.target)) close(); });
        return { toggle, label, balance, menu, note, close };
    }

    function menuItem(role, text, detail) {
        const item = element('button', 'mode-menu-item');
        item.type = 'button';
        item.setAttribute('role', role);
        item.append(element('span', 'mode-menu-name', text));
        const aside = element('span', 'mode-menu-detail', detail || '');
        item.append(aside);
        return item;
    }

    function markUnavailable(host) {
        if (!host) return;
        const ui = host.querySelector('.mode-switch-toggle') ? null : buildSwitch(host);
        const toggle = host.querySelector('.mode-switch-toggle');
        if (ui) ui.label.textContent = 'Account';
        host.querySelector('[data-mode-balance]').textContent = 'Unavailable';
        toggle.disabled = true;
    }

    async function init({ realSandbox = false } = {}) {
        const host = document.querySelector('[data-account-switcher]');
        try {
            const { client, config } = await loadEngineConfig();
            await rpc(client, 'enroll_practice_account');
            const accounts = await rpc(client, 'list_my_accounts');
            if (!Array.isArray(accounts)) throw new StartupError('list_my_accounts', new Error('The accounts response was not a list.'));
            const practice = accounts.find((account) => account.execution_mode === 'DEMO' && account.status === 'ACTIVE');
            if (!practice) throw new StartupError('practice_unavailable', new Error('Practice account is unavailable.'));
            const real = accounts.find((account) => account.execution_mode === 'REAL');
            const choose = (account) => {
                window.smartProfitAccount?.set(accountFields(account));
                document.dispatchEvent(new CustomEvent('smartprofit:account-changed', { detail: window.smartProfitAccount.get() }));
            };
            const sandbox = host || realSandbox ? await sandboxOverview(client) : null;
            if (host) {
                const ui = buildSwitch(host);
                const practiceItem = menuItem('menuitemradio', 'Practice', 'Virtual funds');
                practiceItem.dataset.accountId = practice.id;
                const realItem = menuItem('menuitemradio', 'Real', '');
                const realOpen = Boolean(real && real.status === 'ACTIVE' && config.real_enabled);
                if (sandbox && !realOpen) {
                    realItem.dataset.accountId = REAL_SANDBOX;
                    realItem.querySelector('.mode-menu-detail').textContent = `Sandbox · ${money(sandbox.test_balance_usd)}`;
                } else {
                    realItem.dataset.accountId = real?.id || '';
                    realItem.disabled = !realOpen;
                    realItem.querySelector('.mode-menu-detail').textContent = realOpen ? '' : 'Not open yet';
                }
                const reset = menuItem('menuitem', 'Reset practice funds', '');
                reset.dataset.resetPractice = '';
                reset.hidden = true;
                const divider = element('div', 'mode-menu-divider');
                divider.setAttribute('role', 'separator');
                divider.hidden = true;
                ui.menu.append(practiceItem, realItem, divider, reset);

                const current = () => {
                    if (realSandbox) return REAL_SANDBOX;
                    try { return window.smartProfitAccount.get().accountId; } catch (_) { return practice.id; }
                };
                const paint = () => {
                    const id = current();
                    [practiceItem, realItem].forEach((item) => item.setAttribute('aria-checked', String(item.dataset.accountId === id)));
                    const isReal = id !== practice.id;
                    ui.label.textContent = isReal ? 'Real' : 'Practice';
                    host.dataset.mode = isReal ? 'real' : 'demo';
                    // Deposit and Withdraw belong to Real mode only.
                    document.querySelectorAll('[data-funding-actions]').forEach((actions) => { actions.hidden = !isReal; });
                    ui.toggle.setAttribute('aria-label', `Account: ${ui.label.textContent}, balance ${ui.balance.textContent}. Change account`);
                };
                let balanceRequest = 0;
                const refreshBalance = async () => {
                    const request = ++balanceRequest;
                    if (realSandbox) {
                        const fresh = await sandboxOverview(client);
                        if (request !== balanceRequest) return;
                        ui.balance.textContent = fresh ? money(fresh.test_balance_usd) : 'Unavailable';
                        if (fresh) realItem.querySelector('.mode-menu-detail').textContent = `Sandbox · ${money(fresh.test_balance_usd)}`;
                        paint();
                        return;
                    }
                    let active;
                    try { active = window.smartProfitAccount.get(); } catch (_) { return; }
                    const { data, error } = await client.rpc('get_account_summary', { p_account_id: active.accountId });
                    if (request !== balanceRequest) return;
                    if (error || !data || !Number.isFinite(Number(data.available))) { ui.balance.textContent = 'Unavailable'; reset.hidden = true; divider.hidden = true; paint(); return; }
                    ui.balance.textContent = money(data.available, data.currency || 'USD');
                    const minimum = Number(config.accounts?.find((account) => account.id === active.accountId)?.limits?.min_stake);
                    reset.hidden = !(active.mode === 'DEMO' && Number.isFinite(minimum) && Number(data.available) < minimum);
                    divider.hidden = reset.hidden;
                    paint();
                };
                const say = (message) => { ui.note.textContent = message; ui.note.hidden = !message; };
                practiceItem.addEventListener('click', () => {
                    ui.close(true);
                    if (realSandbox) { window.location.assign('dashboard.html'); return; }
                    if (current() !== practice.id) select(practice);
                });
                realItem.addEventListener('click', () => {
                    ui.close(true);
                    if (realItem.dataset.accountId === REAL_SANDBOX) { if (!realSandbox) window.location.assign(REAL_SANDBOX_PAGE); return; }
                    if (realSandbox) { window.location.assign('dashboard.html'); return; }
                    if (real && current() !== real.id) select(real);
                });
                reset.addEventListener('click', async () => {
                    ui.close(true);
                    const { error } = await client.rpc('reset_practice_balance', { p_account_id: practice.id });
                    say(error ? (RESET_MESSAGES[errorCode(error)] || 'Practice funds could not be reset.') : '');
                    if (!error) document.dispatchEvent(new Event('smartprofit:balance-changed'));
                });
                const select = (account) => {
                    if (!account || account.status !== 'ACTIVE') return;
                    window.smartProfitAccountKeys?.clearAccountScoped();
                    window.smartProfitCache?.clear();
                    document.dispatchEvent(new Event('smartprofit:clear-trade-state'));
                    ui.balance.textContent = '—';
                    choose(account);
                };
                document.addEventListener('smartprofit:account-changed', () => { paint(); refreshBalance().catch(() => {}); });
                document.addEventListener('smartprofit:balance-changed', () => refreshBalance().catch(() => {}));
                window.smartProfitBalance = Object.freeze({ refresh: refreshBalance });
                paint();
                if (realSandbox) refreshBalance().catch(() => {});
            }
            // The Real sandbox page never activates a trading account; sessions otherwise start in Practice.
            if (!realSandbox) choose(practice);
            return { client, config, accounts, sandbox };
        } catch (error) {
            const failure = error instanceof StartupError ? error : new StartupError('client', error);
            markUnavailable(host);
            logStartupFailure(failure);
            throw failure;
        }
    }

    window.loadEngineConfig = loadEngineConfig;
    window.initAccountSwitcher = init;
    window.smartProfitStartup = Object.freeze({ message: startupMessage, log: logStartupFailure, StartupError });
})();
