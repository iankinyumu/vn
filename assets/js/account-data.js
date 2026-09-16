/* Authenticated account projection. Every query is constrained by Supabase RLS. */
(function () {
    let channel, channelAccount, running, refreshTimer, rerun = false;
    const cache = window.smartProfitCache;
    let authUserId;
    function requestRefresh(invalidate = true) {
        if (invalidate) cache.clear();
        // Keep one scheduled refresh even during a continuous event burst.
        if (refreshTimer) return;
        refreshTimer = setTimeout(() => { refreshTimer = null; refresh(); }, 300);
    }
    window.refreshAccountData = () => requestRefresh(true);
    function refresh() {
        if (running) { rerun = true; return running; }
        running = load().finally(() => { running = null; if (rerun) { rerun = false; requestRefresh(false); } });
        return running;
    }
    const setText = (selector, value) => document.querySelectorAll(selector).forEach((node) => { node.textContent = value; });
    const setValue = (selector, value) => document.querySelectorAll(selector).forEach((node) => { node.value = value; });
    const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
    const addCell = (row, text) => { const cell = document.createElement('td'); cell.textContent = text; row.appendChild(cell); };

    function renderTransactions(transactions) {
        const body = document.getElementById('transactionHistoryBody');
        if (!body) return;
        body.replaceChildren();
        if (!transactions.length) {
            const row = document.createElement('tr');
            const cell = document.createElement('td');
            cell.colSpan = 5;
            cell.className = 'text-secondary';
            cell.textContent = 'No ledger transactions have been recorded for this account.';
            row.appendChild(cell); body.appendChild(row); return;
        }
        transactions.forEach((transaction) => {
            const row = document.createElement('tr');
            addCell(row, new Date(transaction.created_at).toLocaleString());
            addCell(row, transaction.description);
            addCell(row, transaction.correlation_id);
            addCell(row, transaction.idempotency_key);
            addCell(row, 'Posted');
            body.appendChild(row);
        });
    }

    function renderOrders(orders) {
        const container = document.getElementById('openOrdersList');
        if (!container) return;
        container.replaceChildren();
        if (!orders.length) {
            const empty = document.createElement('div');
            empty.className = 'open-order-item text-secondary';
            empty.textContent = 'No open orders.';
            container.appendChild(empty); return;
        }
        orders.forEach((order) => {
            const item = document.createElement('div'); item.className = 'open-order-item';
            const info = document.createElement('div'); info.className = 'order-info';
            const side = document.createElement('span'); side.className = `order-type ${order.side.toLowerCase()}`; side.textContent = order.side;
            const pair = document.createElement('span'); pair.className = 'order-pair'; pair.textContent = order.symbol;
            info.append(side, pair);
            const details = document.createElement('div'); details.className = 'order-details';
            const quantity = document.createElement('span'); quantity.textContent = `${order.quantity} (${order.type})`;
            const timestamp = document.createElement('span'); timestamp.className = 'text-secondary'; timestamp.textContent = new Date(order.submitted_at).toLocaleString();
            details.append(quantity, timestamp); item.append(info, details); container.appendChild(item);
        });
    }

    function renderPositions(positions, quotes) {
        const body = document.getElementById('openPositionsBody');
        const quoteBySymbol = new Map();
        quotes.forEach((quote) => {
            if (Date.now() - Date.parse(quote.received_at) < 60000 && !quoteBySymbol.has(quote.symbol)) quoteBySymbol.set(quote.symbol, Number(quote.bid_price));
        });
        const openPositions = positions.filter((position) => Number(position.quantity) !== 0);
        const missingQuote = openPositions.some((position) => !quoteBySymbol.has(position.symbol));
        const unrealizedPnl = openPositions.reduce((total, position) => {
            const quantity = Number(position.quantity);
            const mark = quoteBySymbol.get(position.symbol) || 0;
            return total + ((mark - Number(position.average_entry_price)) * quantity);
        }, 0);
        const positionValue = openPositions.reduce((total, position) => total + (Number(position.quantity) * (quoteBySymbol.get(position.symbol) || 0)), 0);

        setText('[data-unrealized-pnl]', missingQuote ? 'Quote unavailable' : money.format(unrealizedPnl));
        if (body) {
            body.replaceChildren();
            if (!openPositions.length) {
                const row = document.createElement('tr');
                const cell = document.createElement('td');
                cell.colSpan = 5;
                cell.className = 'text-secondary';
                cell.textContent = 'No open positions.';
                row.appendChild(cell); body.appendChild(row);
            } else {
                openPositions.forEach((position) => {
                    const quantity = Number(position.quantity);
                    const mark = quoteBySymbol.get(position.symbol) || 0;
                    const pnl = (mark - Number(position.average_entry_price)) * quantity;
                    const row = document.createElement('tr');
                    addCell(row, position.symbol);
                    addCell(row, quantity.toLocaleString('en-US', { maximumFractionDigits: 8 }));
                    addCell(row, money.format(Number(position.average_entry_price)));
                    addCell(row, mark ? money.format(mark) : 'Quote unavailable');
                    addCell(row, mark ? money.format(pnl) : 'Quote unavailable');
                    body.appendChild(row);
                });
            }
        }
        return { unrealizedPnl, positionValue, quoteBySymbol, missingQuote };
    }

    async function load() {
    try {
        const client = await getSupabaseClient();
        const { data: { session }, error: sessionError } = await client.auth.getSession();
        if (sessionError) throw sessionError;
        const user = session?.user;
        if (!user) return;
        const scope = `${window.SMARTPROFIT_SUPABASE_CONFIG.url}:${user.id}:DEMO`;
        const read = (name, loader) => cache.read(scope, name, loader);
        const [{ data: profile, error: profileError }, { data: accounts, error: accountError }] = await Promise.all([
            read('profile', () => client.from('profiles').select('display_name, created_at').single()),
            read('accounts', () => client.from('trading_accounts').select('id, execution_mode, base_currency, status, created_at').eq('status', 'ACTIVE').order('created_at', { ascending: true }))
        ]);
        if (profileError) throw profileError;
        if (accountError) throw accountError;

        const name = profile?.display_name || user.user_metadata?.display_name || user.email || 'Trader';
        setText('[data-profile-name]', name); setText('[data-profile-email]', user.email || '');
        setValue('[data-profile-display-name]', name); setValue('[data-profile-email-input]', user.email || '');
        setText('[data-profile-avatar]', name.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]).join('').toUpperCase() || 'T');
        document.querySelectorAll('.toggle-switch input').forEach((toggle) => { toggle.checked = false; toggle.disabled = true; });
        if (profile?.created_at) setText('[data-profile-created]', new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric' }).format(new Date(profile.created_at)));

        // This release supports DEMO execution only. Never display a REAL account
        // while the trading page still submits orders to the demo endpoint.
        const account = accounts?.find((item) => item.execution_mode === 'DEMO') || null;
        window.smartProfitAccountData = { user, profile, account, balances: [] };
        if (!account) {
            setText('[data-account-load-status]', 'No active practice account is available.');
            return;
        }
        if (channelAccount !== account.id) {
            if (channel) await client.removeChannel(channel);
            channelAccount = account.id;
            channel = client.channel('account-orders-' + account.id)
                .on('postgres_changes', { event: '*', schema: 'public', table: 'orders', filter: 'trading_account_id=eq.' + account.id }, () => requestRefresh(true))
                .subscribe();
        }
        setText('[data-account-mode]', account.execution_mode);
        document.querySelectorAll('[data-mode-option]').forEach((button) => {
            const current = button.dataset.modeOption === account.execution_mode;
            button.classList.toggle('active', current); button.setAttribute('aria-pressed', String(current));
        });

        const [{ data: wallets, error: walletError }, { data: transactions, error: transactionError }, { data: orders, error: orderError }, { data: positions, error: positionError }] = await Promise.all([
            read('wallets:' + account.id, () => client.from('wallets').select('id, asset, ledger_scope, ledger_accounts(id, kind)').eq('trading_account_id', account.id).order('asset')),
            document.getElementById('transactionHistoryBody') ? read('ledger_transactions:' + account.id, () => client.from('ledger_transactions').select('description, correlation_id, idempotency_key, created_at').eq('trading_account_id', account.id).order('created_at', { ascending: false }).limit(50)) : { data: [] },
            read('orders:' + account.id, () => client.from('orders').select('symbol, side, type, quantity, submitted_at').eq('trading_account_id', account.id).in('state', ['PENDING_VALIDATION', 'ACCEPTED', 'OPEN', 'PARTIALLY_FILLED']).order('submitted_at', { ascending: false })),
            read('positions:' + account.id, () => client.from('positions').select('symbol, quantity, average_entry_price').eq('trading_account_id', account.id).eq('margin_type', 'SPOT'))
        ]);
        if (walletError || transactionError || orderError || positionError) throw walletError || transactionError || orderError || positionError;
        renderTransactions(transactions || []); renderOrders(orders || []);

        const symbols = [...new Set((positions || []).filter((position) => Number(position.quantity) !== 0).map((position) => position.symbol))];
        const snapshotResult = symbols.length
            ? await read('quotes:' + account.id + ':' + symbols.join(','), () => client.rpc('account_position_quotes', { p_account: account.id }))
            : { data: [] };
        if (snapshotResult.error) throw snapshotResult.error;
        const projection = renderPositions(positions || [], snapshotResult.data || []);

        const ledgerAccountIds = (wallets || []).flatMap((wallet) => (wallet.ledger_accounts || []).map((ledger) => ledger.id));
        const entryResult = ledgerAccountIds.length ? await read('ledger:' + account.id, () => client.rpc('account_balance_totals', { p_account: account.id })) : { data: [] };
        if (entryResult.error) throw entryResult.error;
        const totals = (entryResult.data || []).reduce((all, entry) => ({ ...all, [entry.ledger_account_id]: (all[entry.ledger_account_id] || 0) + Number(entry.amount) }), {});
        const balances = (wallets || []).map((wallet) => ({ asset: wallet.asset, available: totals[(wallet.ledger_accounts || []).find((ledger) => ledger.kind === 'AVAILABLE')?.id] || 0 }));
        window.smartProfitAccountData.balances = balances;
        document.querySelectorAll('[data-wallet-asset]').forEach((node) => { node.textContent = Number(balances.find((balance) => balance.asset === node.dataset.walletAsset)?.available || 0).toLocaleString('en-US', { maximumFractionDigits: 8 }); });
        // DEMO spot pairs settle in USDT. An account also has a zero-balance USD
        // base wallet, so always prefer the funded USDT trading wallet here.
        const settlementWallet = balances.find((item) => item.asset === 'USDT') || balances.find((item) => item.asset === 'USD');
        const cashValue = Number(settlementWallet?.available || 0);
        setText('[data-wallet-total-usd]', money.format(cashValue));
        document.querySelectorAll('[data-wallet-asset-usd]').forEach((node) => {
            const asset = node.dataset.walletAssetUsd;
            const amount = Number(balances.find((balance) => balance.asset === asset)?.available || 0);
            const mark = asset === 'USD' || asset === 'USDT' ? 1 : projection.quoteBySymbol.get(`${asset}USDT`);
            node.textContent = mark ? `≈ ${money.format(amount * mark)}` : 'Quote unavailable';
        });
        setText('[data-open-orders-count]', String((orders || []).length));
        setText('[data-total-equity]', projection.missingQuote ? 'Quote unavailable' : money.format(cashValue + projection.positionValue));
        setText('[data-account-load-status]', 'Balances may take a few seconds to update.');

        const profileForm = document.getElementById('profileForm');
        if (profileForm) profileForm.onsubmit = async (event) => {
            event.preventDefault(); const status = document.querySelector('[data-profile-save-status]'); const displayName = document.getElementById('profileDisplayName').value.trim();
            if (!displayName) return;
            status.textContent = 'Saving…';
            const { error } = await client.from('profiles').update({ display_name: displayName }).eq('id', user.id);
            status.textContent = error ? error.message : 'Saved.';
            if (!error) { cache.clear(); setText('[data-profile-name]', displayName); setText('[data-profile-avatar]', displayName.split(/\s+/).slice(0, 2).map((word) => word[0]).join('').toUpperCase()); }
        };
    } catch (error) {
        console.error('Unable to load authenticated account data.', error);
        setText('[data-account-load-status]', 'Account data is temporarily unavailable.');
    }
    }
    getSupabaseClient().then((client) => {
        client.auth.onAuthStateChange((event, session) => {
            if (event === 'SIGNED_OUT' || (authUserId && authUserId !== session?.user?.id)) {
                cache.clear();
                window.smartProfitAccountData = null;
                // Clear rendered private data when the identity changes.
                window.location.replace('login.html');
            }
            authUserId = session?.user?.id;
        });
        refresh();
    }).catch(() => setText('[data-account-load-status]', 'Account data is temporarily unavailable.'));
    // Expiry is checked when returning to the page; no background polling loop.
    window.addEventListener('focus', () => requestRefresh(false));
    window.addEventListener('pagehide', () => { clearTimeout(refreshTimer); });
})();
