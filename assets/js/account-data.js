/* Authenticated account projection. Every query is constrained by Supabase RLS. */
(async function () {
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
            empty.textContent = 'No open orders. Order execution is not enabled.';
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

    try {
        const client = await getSupabaseClient();
        const { data: { user } } = await client.auth.getUser();
        if (!user) return;
        const [{ data: profile, error: profileError }, { data: accounts, error: accountError }] = await Promise.all([
            client.from('profiles').select('display_name, created_at').single(),
            client.from('trading_accounts').select('id, execution_mode, base_currency, status, created_at').eq('status', 'ACTIVE').order('created_at', { ascending: true })
        ]);
        if (profileError) throw profileError;
        if (accountError) throw accountError;

        const name = profile?.display_name || user.user_metadata?.display_name || user.email || 'Trader';
        setText('[data-profile-name]', name); setText('[data-profile-email]', user.email || '');
        setValue('[data-profile-display-name]', name); setValue('[data-profile-email-input]', user.email || '');
        setText('[data-profile-avatar]', name.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]).join('').toUpperCase() || 'T');
        document.querySelectorAll('.toggle-switch input').forEach((toggle) => { toggle.checked = false; toggle.disabled = true; });
        if (profile?.created_at) setText('[data-profile-created]', new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric' }).format(new Date(profile.created_at)));

        const account = accounts?.find((item) => item.execution_mode === 'DEMO') || accounts?.[0] || null;
        window.smartProfitAccountData = { user, profile, account, balances: [] };
        if (!account) return;
        // Account lifecycle changes are published by Supabase Realtime; all data is
        // re-read through RLS rather than trusting a websocket payload as a balance.
        client.channel(`account-orders-${account.id}`)
            .on('postgres_changes', { event: '*', schema: 'public', table: 'orders', filter: `trading_account_id=eq.${account.id}` }, () => window.location.reload())
            .subscribe();
        setText('[data-account-mode]', account.execution_mode);
        document.querySelectorAll('[data-mode-option]').forEach((button) => {
            const current = button.dataset.modeOption === account.execution_mode;
            button.classList.toggle('active', current); button.setAttribute('aria-pressed', String(current));
        });

        const [{ data: wallets, error: walletError }, { data: transactions, error: transactionError }, { data: orders, error: orderError }] = await Promise.all([
            client.from('wallets').select('id, asset, ledger_scope, ledger_accounts(id, kind)').eq('trading_account_id', account.id).order('asset'),
            client.from('ledger_transactions').select('description, correlation_id, idempotency_key, created_at').eq('trading_account_id', account.id).order('created_at', { ascending: false }).limit(50),
            client.from('orders').select('symbol, side, type, quantity, submitted_at').eq('trading_account_id', account.id).in('state', ['PENDING_VALIDATION', 'ACCEPTED', 'OPEN', 'PARTIALLY_FILLED']).order('submitted_at', { ascending: false })
        ]);
        if (walletError || transactionError || orderError) throw walletError || transactionError || orderError;
        renderTransactions(transactions || []); renderOrders(orders || []);

        const ledgerAccountIds = (wallets || []).flatMap((wallet) => (wallet.ledger_accounts || []).map((ledger) => ledger.id));
        const entryResult = ledgerAccountIds.length ? await client.from('ledger_entries').select('ledger_account_id, amount').in('ledger_account_id', ledgerAccountIds) : { data: [] };
        if (entryResult.error) throw entryResult.error;
        const totals = (entryResult.data || []).reduce((all, entry) => ({ ...all, [entry.ledger_account_id]: (all[entry.ledger_account_id] || 0) + Number(entry.amount) }), {});
        const balances = (wallets || []).map((wallet) => ({ asset: wallet.asset, available: totals[(wallet.ledger_accounts || []).find((ledger) => ledger.kind === 'AVAILABLE')?.id] || 0 }));
        window.smartProfitAccountData.balances = balances;
        document.querySelectorAll('[data-wallet-asset]').forEach((node) => { node.textContent = Number(balances.find((balance) => balance.asset === node.dataset.walletAsset)?.available || 0).toLocaleString('en-US', { maximumFractionDigits: 8 }); });
        const usd = balances.find((item) => item.asset === 'USD' || item.asset === 'USDT'); setText('[data-wallet-total-usd]', money.format(usd?.available || 0));

        const profileForm = document.getElementById('profileForm');
        if (profileForm) profileForm.addEventListener('submit', async (event) => {
            event.preventDefault(); const status = document.querySelector('[data-profile-save-status]'); const displayName = document.getElementById('profileDisplayName').value.trim();
            if (!displayName) return;
            status.textContent = 'Saving…';
            const { error } = await client.from('profiles').update({ display_name: displayName }).eq('id', user.id);
            status.textContent = error ? error.message : 'Saved.';
            if (!error) { setText('[data-profile-name]', displayName); setText('[data-profile-avatar]', displayName.split(/\s+/).slice(0, 2).map((word) => word[0]).join('').toUpperCase()); }
        });
    } catch (error) {
        console.error('Unable to load authenticated account data.', error);
        setText('[data-account-load-status]', 'Account data is temporarily unavailable.');
    }
})();
