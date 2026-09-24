/* Admin operations: Overview, Customers, Contracts, Engine and Staff tabs.
   The staff context only decides what is shown; every RPC re-checks the
   capability on the server, which stays the authority. */
(() => {
    const el = (id) => document.getElementById(id);
    const RESTRICTION_TYPES = ['TRADING', 'WITHDRAWAL', 'DEPOSIT', 'ACCESS'];
    const RESTRICTION_SCOPES = ['DEMO', 'REAL', 'ALL'];
    const RESTRICTION_SEVERITIES = ['NOTICE', 'LIMITED', 'BLOCKED'];
    const RESTRICTION_PARAMS = Object.freeze({ TRADING: ['max_stake', 'max_open_contracts', 'max_daily_net_loss'], WITHDRAWAL: ['max_amount_per_day'], DEPOSIT: ['max_amount_per_day'], ACCESS: [] });
    const MODE_LABELS = Object.freeze({ DEMO: 'Practice', REAL: 'Real' });
    const SCOPE_LABELS = Object.freeze({ DEMO: 'Practice', REAL: 'Real', ALL: 'All accounts' });
    const TABS = [
        ['tabOverview', 'overviewPanel', 'operations.read'],
        ['tabCustomers', 'customersPanel', 'customers.read'],
        ['tabContracts', 'contractsPanel', 'contracts.read'],
        ['tabEngine', 'enginePanel', 'engine.read'],
        ['tabStaff', 'staffPanel', 'staff.manage'],
        ['tabAudit', 'auditPanel', 'audit.read'],
    ];
    const failures = Object.freeze({
        forbidden: 'Your role does not allow this action.',
        reauthentication_required: 'Confirm with a current authenticator code, then submit again.',
        mfa_required: 'Complete two-factor verification to continue.',
        unauthenticated: 'Your staff session has expired. Sign in again.',
        validation_failed: 'The server rejected the values.',
        not_found: 'This record no longer exists or has already changed.',
        conflict: 'Someone else changed this record. Reload and try again.',
        rate_limited: 'Too many changes in a short time. Wait a moment and try again.',
        self_role_change_forbidden: 'You cannot change your own role.',
        last_owner_required: 'At least one active owner must remain.',
    });
    const STALE = Symbol('stale');
    const codeOf = (error) => String(error?.message || '').match(/^[a-z_]+/)?.[0];
    function explain(error) {
        const code = codeOf(error);
        if (!failures[code]) { console.error('[admin] request failed', error); return 'The request failed. Try again; if it keeps failing, report the time of this attempt.'; }
        return code === 'validation_failed' && error.details ? `${failures[code]} ${error.details}` : failures[code];
    }

    // Mirrors admin_private.restriction_capability; the server applies the same rule regardless of the UI.
    function restrictionCapability(type, scope, severity) {
        if (severity === 'NOTICE') return 'customers.restrict.notice';
        if (severity === 'LIMITED') return 'customers.restrict.limit';
        return ['ACCESS', 'WITHDRAWAL', 'DEPOSIT'].includes(type) || ['ALL', 'REAL'].includes(scope) ? 'customers.restrict.block_severe' : 'customers.restrict.block';
    }
    // LIMITED needs at least one parameter, and ACCESS has none, so that pair is never offered.
    const restrictionAllowed = (capabilities, type, scope, severity) => capabilities.has(restrictionCapability(type, scope, severity)) && !(severity === 'LIMITED' && !RESTRICTION_PARAMS[type].length);

    function h(tag, options = {}, children = []) {
        const item = document.createElement(tag);
        if (options.className) item.className = options.className;
        if (options.text !== undefined && options.text !== null) item.textContent = String(options.text);
        for (const [name, value] of Object.entries(options.attrs || {})) item.setAttribute(name, value);
        if (options.onClick) item.addEventListener('click', options.onClick);
        item.append(...children);
        return item;
    }
    const cell = (value, className) => h('td', { text: value === null || value === undefined || value === '' ? '—' : value, className });
    const short = (value) => (value ? `${String(value).slice(0, 8)}…` : '—');
    const when = (value) => (value ? new Date(value).toLocaleString() : '—');
    const money = (value) => (value === null || value === undefined ? '—' : Number(value).toFixed(2));
    const badge = (text, tone) => h('span', { className: `badge-${tone}`, text });
    const emptyRow = (columns, text) => h('tr', {}, [h('td', { text, attrs: { colspan: String(columns) }, className: 'text-muted ps-3' })]);
    const button = (label, className, onClick) => h('button', { className, text: label, attrs: { type: 'button' }, onClick });
    const setOptions = (select, values, label = (value) => value, keep = select.value) => {
        select.replaceChildren(...values.map((value) => new Option(label(value), value)));
        if (values.includes(keep)) select.value = keep;
    };

    class AdminOperations {
        constructor() {
            this.client = null;
            this.context = null;
            this.capabilities = new Set();
            this.generation = 0;
            this.activeTab = 'supportPanel';
            this.customerId = null;
            this.contract = null;
        }

        init(client, context) {
            this.generation++;
            this.client = client;
            this.context = context;
            this.capabilities = new Set(context?.capabilities || []);
            this.setupTabs();
            this.switchTab('supportPanel');
        }

        can(capability) { return this.capabilities.has(capability); }

        async call(name, args) {
            const { client, generation } = this;
            if (!client) throw STALE;
            const { data, error } = await client.rpc(name, args);
            if (generation !== this.generation) throw STALE;
            if (error) throw error;
            return data;
        }

        report(target, error) {
            if (error !== STALE && target) target.textContent = explain(error);
        }

        setupTabs() {
            for (const [tabId, panelId, capability] of TABS) {
                el(tabId).hidden = !this.can(capability);
                if (!this.can(capability)) el(panelId).hidden = true;
            }
            document.querySelectorAll('.tab-btn').forEach((tab) => {
                tab.onclick = () => { if (tab.dataset.tab && !tab.hidden) this.switchTab(tab.dataset.tab); };
            });
            this.bindCustomerEvents();
            this.bindContractEvents();
            this.bindEngineEvents();
            this.bindStaffEvents();
        }

        switchTab(panelId) {
            const gate = TABS.find(([, panel]) => panel === panelId);
            if (gate && !this.can(gate[2])) return;
            this.activeTab = panelId;
            document.querySelectorAll('.tab-btn').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === panelId));
            document.querySelectorAll('.admin-tab-panel').forEach((panel) => { panel.hidden = panel.id !== panelId; });
            if (panelId === 'overviewPanel') this.loadOverview();
            else if (panelId === 'customersPanel') this.loadCustomers();
            else if (panelId === 'contractsPanel') this.loadContracts();
            else if (panelId === 'enginePanel') this.loadEngine();
            else if (panelId === 'staffPanel') this.loadStaff();
            else if (panelId === 'auditPanel') { const audit = el('auditOpen'); if (audit && !audit.hidden) audit.click(); }
        }

        /* A protected action (void, severe restriction, role change) may need a TOTP
           verification from the last ten minutes. On reauthentication_required the
           form reveals its code field; the next submit verifies, then retries. */
        async runProtected(form, status, action) {
            const wrap = form.querySelector('[data-reverify]');
            const input = wrap?.querySelector('input');
            if (wrap && !wrap.hidden && input.value) {
                if (!/^[0-9]{6}$/.test(input.value)) { status.textContent = 'Enter the 6-digit code from your authenticator.'; return false; }
                const client = this.client;
                const factors = await client.auth.mfa.listFactors();
                if (factors.error) throw factors.error;
                const factor = factors.data?.totp?.[0];
                if (!factor) throw new Error('mfa_required');
                const verified = await client.auth.mfa.challengeAndVerify({ factorId: factor.id, code: input.value });
                input.value = '';
                if (verified.error) { status.textContent = 'That code was not accepted. Enter a current code and try again.'; return false; }
                wrap.hidden = true;
            }
            try {
                await action();
                return true;
            } catch (error) {
                if (codeOf(error) === 'reauthentication_required' && wrap) { wrap.hidden = false; input.focus?.(); }
                throw error;
            }
        }

        // ================= OVERVIEW =================
        async loadOverview() {
            const status = el('overviewStatus');
            const grid = el('overviewCards');
            status.textContent = 'Refreshing platform metrics…';
            try {
                const data = await this.call('get_platform_overview');
                const today = data.contracts_today || {};
                const card = (label, value, icon, note) => h('div', { className: 'card-kpi stat-card' }, [
                    h('div', { className: 'stat-icon-wrapper' }, [h('i', { className: `fas ${icon}` })]),
                    h('div', { className: 'stat-content' }, [h('div', { className: 'stat-label', text: label }), h('div', { className: 'stat-value', text: value }), h('div', { className: 'stat-badge', text: note })]),
                ]);
                grid.replaceChildren(
                    card('Open tickets', data.open_tickets, 'fa-headset text-primary', 'Active queue'),
                    card('Unassigned', data.unassigned_tickets, 'fa-inbox text-warning', 'Needs review'),
                    card('Registered accounts', data.total_customers, 'fa-users text-info', 'Platform total'),
                    card('Active restrictions', data.active_restrictions, 'fa-user-slash text-danger', 'Unexpired'),
                    card('Contracts today', `${(today.DEMO ?? 0) + (today.REAL ?? 0)}`, 'fa-exchange-alt text-success', `Practice ${today.DEMO ?? 0} · Real ${today.REAL ?? 0}`),
                    card('Active staff', data.active_staff, 'fa-user-shield text-primary', 'Operations'),
                    card('Engine', String(data.engine_health || 'unavailable').toUpperCase(), `fa-bolt ${{ healthy: 'text-success', watch: 'text-warning', alert: 'text-danger', degraded: 'text-danger' }[data.engine_health] || 'text-secondary'}`, 'Details in the Engine tab'),
                );
                status.textContent = `Live as of ${new Date(data.timestamp).toLocaleTimeString()}`;
            } catch (error) {
                if (error !== STALE) { grid.replaceChildren(); status.textContent = `Could not load overview metrics. ${explain(error)}`; }
            }
        }

        // ================= CUSTOMERS =================
        bindCustomerEvents() {
            el('customerSearchForm').onsubmit = (event) => { event.preventDefault(); this.loadCustomers(el('customerSearchInput').value.trim()); };
            el('closeCustomerDetail').onclick = () => { el('customerDetailModal').hidden = true; this.customerId = null; };
            const form = el('applyRestrictionForm');
            for (const id of ['restrictionSeverity', 'restrictionType', 'restrictionScope']) el(id).onchange = () => this.renderRestrictionChoices();
            form.onsubmit = async (event) => {
                event.preventDefault();
                const status = el('restrictionStatus');
                const type = el('restrictionType').value, scope = el('restrictionScope').value, severity = el('restrictionSeverity').value;
                const reason = el('restrictionReason').value.trim();
                if (!this.customerId || !restrictionAllowed(this.capabilities, type, scope, severity)) { status.textContent = 'Choose a restriction your role may apply.'; return; }
                if (reason.length < 3) { status.textContent = 'Give a reason of at least 3 characters.'; return; }
                const params = {};
                if (severity === 'LIMITED') {
                    for (const name of RESTRICTION_PARAMS[type]) {
                        const value = form.querySelector(`[data-param="${name}"]`).value.trim();
                        if (value) params[name] = Number(value);
                    }
                    if (!Object.keys(params).length) { status.textContent = 'A limited restriction needs at least one limit.'; return; }
                }
                const expires = el('restrictionExpires').value;
                const userId = this.customerId;
                status.textContent = 'Applying restriction…';
                try {
                    const done = await this.runProtected(form, status, () => this.call('apply_account_restriction', { p_user_id: userId, p_type: type, p_scope: scope, p_severity: severity, p_params: params, p_expires_at: expires ? new Date(expires).toISOString() : null, p_reason: reason }));
                    if (!done) return;
                    form.reset();
                    this.renderRestrictionChoices();
                    await this.openCustomerDetail(userId);
                    el('restrictionStatus').textContent = 'Restriction applied.';
                    this.loadCustomers(el('customerSearchInput').value.trim());
                } catch (error) { this.report(status, error); }
            };
            this.renderRestrictionChoices();
        }

        // Shows only the type, scope and severity combinations this staff member may apply.
        renderRestrictionChoices() {
            const form = el('applyRestrictionForm');
            const caps = this.capabilities;
            const severities = RESTRICTION_SEVERITIES.filter((severity) => RESTRICTION_TYPES.some((type) => RESTRICTION_SCOPES.some((scope) => restrictionAllowed(caps, type, scope, severity))));
            form.hidden = !severities.length;
            if (!severities.length) return;
            const severity = el('restrictionSeverity');
            setOptions(severity, severities, (value) => ({ NOTICE: 'Notice (shown, not enforced)', LIMITED: 'Limited (enforces limits)', BLOCKED: 'Blocked' })[value]);
            const type = el('restrictionType');
            setOptions(type, RESTRICTION_TYPES.filter((value) => RESTRICTION_SCOPES.some((scope) => restrictionAllowed(caps, value, scope, severity.value))));
            const scope = el('restrictionScope');
            setOptions(scope, RESTRICTION_SCOPES.filter((value) => restrictionAllowed(caps, type.value, value, severity.value)), (value) => SCOPE_LABELS[value]);
            const limited = severity.value === 'LIMITED';
            el('restrictionParams').hidden = !limited;
            form.querySelectorAll('[data-param]').forEach((input) => {
                const shown = limited && RESTRICTION_PARAMS[type.value].includes(input.dataset.param);
                input.closest('label').hidden = !shown;
                if (!shown) input.value = '';
            });
        }

        async loadCustomers(query = '') {
            const status = el('customersStatus');
            const body = el('customersTableBody');
            status.textContent = 'Loading customers…';
            body.replaceChildren();
            try {
                const data = await this.call('list_admin_customers', { p_query: query || null, p_limit: 50, p_offset: 0 });
                if (!data?.length) { status.textContent = query ? 'No matching customers found.' : 'No customers registered.'; return; }
                status.textContent = `Displaying ${data.length} customers.`;
                body.replaceChildren(...data.map((customer) => h('tr', {}, [
                    h('td', { className: 'ps-3' }, [h('strong', { text: customer.display_name }), h('br'), h('small', { className: 'mono', text: customer.id })]),
                    cell(customer.email),
                    h('td', {}, [customer.email_verified ? badge('Verified', 'success') : badge('Unverified', 'warn')]),
                    cell(customer.tickets_count),
                    h('td', {}, [customer.active_restrictions_count > 0 ? badge(`${customer.active_restrictions_count} active`, 'danger') : badge('None', 'neutral')]),
                    h('td', { className: 'text-end pe-3' }, [button('Inspect', 'btn-inspect', () => this.openCustomerDetail(customer.id))]),
                ])));
            } catch (error) {
                if (error !== STALE) status.textContent = `Could not load customers. ${explain(error)}`;
            }
        }

        async openCustomerDetail(userId) {
            this.customerId = userId;
            el('customerDetailModal').hidden = false;
            el('customerDetailName').textContent = 'Loading customer detail…';
            el('customerDetailMeta').textContent = '';
            el('customerAccountsList').replaceChildren();
            el('customerRestrictionsList').replaceChildren();
            el('restrictionListStatus').textContent = '';
            this.renderRestrictionChoices();
            try {
                const data = await this.call('get_admin_customer_detail', { p_user_id: userId });
                if (this.customerId !== userId) return;
                el('customerDetailName').textContent = `${data.display_name} (${data.email})`;
                el('customerDetailMeta').textContent = `Customer ID: ${data.user_id} · Registered: ${new Date(data.created_at).toLocaleDateString()} · Status: ${data.lifecycle_status} · Email confirmed: ${data.email_verified ? 'yes' : 'no'}`;
                el('customerAccountsList').replaceChildren(...(data.accounts?.length ? data.accounts.map((account) => h('li', { className: 'list-group-item', text: `${MODE_LABELS[account.execution_mode] || account.execution_mode} · ${account.status} · ${data.currency} available ${money(account.balances?.AVAILABLE)}, reserved ${money(account.balances?.RESERVED)} · ${account.open_contracts} open contracts · ${account.id}` })) : [h('li', { className: 'list-group-item text-muted', text: 'No trading account yet.' })]));
                el('customerRestrictionsList').replaceChildren(...(data.restrictions?.length ? data.restrictions.map((row) => this.restrictionItem(row, userId)) : [h('li', { className: 'list-group-item text-muted', text: 'No restrictions recorded for this customer.' })]));
            } catch (error) {
                if (error !== STALE) el('customerDetailName').textContent = `Could not load customer detail. ${explain(error)}`;
            }
        }

        restrictionItem(row, userId) {
            const state = !row.active ? 'Lifted' : row.expired ? 'Expired' : 'Active';
            const params = Object.entries(row.params || {}).map(([key, value]) => `${key.replaceAll('_', ' ')} ${value}`).join(', ');
            const item = h('li', { className: 'list-group-item', attrs: { 'data-restriction': row.id } }, [
                h('strong', { text: `${row.restriction_type} · ${SCOPE_LABELS[row.scope] || row.scope} · ${row.severity}` }), ' ',
                badge(state, state === 'Active' ? 'danger' : 'neutral'),
                h('div', { className: 'text-muted small', text: `${params ? `Limits: ${params}. ` : ''}Expires: ${row.expires_at ? when(row.expires_at) : 'never'}. Reason: ${row.reason} (applied ${when(row.applied_at)})${row.lifted_reason ? `. Lifted: ${row.lifted_reason}` : ''}` }),
            ]);
            if (!row.active || !this.can(restrictionCapability(row.restriction_type, row.scope, row.severity))) return item;
            const reason = h('input', { className: 'form-control form-control-sm', attrs: { 'aria-label': 'Reason for lifting', minlength: '3', maxlength: '500', placeholder: 'Reason for lifting (3-500 characters)' } });
            const code = h('input', { className: 'form-control form-control-sm', attrs: { inputmode: 'numeric', maxlength: '6', autocomplete: 'one-time-code' } });
            const reverify = h('label', { className: 'small d-block', attrs: { 'data-reverify': '' }, text: 'Authenticator code ' }, [code]);
            reverify.hidden = true;
            const form = h('form', { className: 'mt-2', attrs: { 'data-lift-form': row.id } }, [reason, reverify, h('button', { className: 'btn-lift mt-1', text: 'Confirm lift', attrs: { type: 'submit' } })]);
            form.hidden = true;
            form.onsubmit = async (event) => {
                event.preventDefault();
                const status = el('restrictionListStatus');
                if (reason.value.trim().length < 3) { status.textContent = 'Give a reason of at least 3 characters for lifting.'; return; }
                status.textContent = 'Lifting restriction…';
                try {
                    if (!await this.runProtected(form, status, () => this.call('lift_account_restriction', { p_restriction_id: row.id, p_reason: reason.value.trim() }))) return;
                    await this.openCustomerDetail(userId);
                    el('restrictionListStatus').textContent = 'Restriction lifted.';
                    this.loadCustomers(el('customerSearchInput').value.trim());
                } catch (error) { this.report(status, error); }
            };
            item.append(button('Lift restriction', 'btn-lift mt-1', () => { form.hidden = false; reason.focus?.(); }), form);
            return item;
        }

        // ================= CONTRACTS =================
        bindContractEvents() {
            el('contractFilterForm').onsubmit = (event) => { event.preventDefault(); this.loadContracts(); };
            el('closeContractDetail').onclick = () => { el('contractDetailCard').hidden = true; this.contract = null; };
            el('contractVoidForm').onsubmit = (event) => { event.preventDefault(); if (this.contract) this.voidContract(el('contractVoidForm'), el('contractVoidReason'), el('contractVoidStatus'), this.contract.id); };
        }

        async loadContracts() {
            const status = el('contractsStatus');
            const body = el('contractsTableBody');
            const account = el('contractAccountFilter').value.trim();
            const from = el('contractFromFilter').value, to = el('contractToFilter').value;
            if (account && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(account)) { status.textContent = 'Enter a full account ID or leave the account filter empty.'; return; }
            if (from && to && to < from) { status.textContent = 'The end date must not be before the start date.'; return; }
            const nextDay = (date) => new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString();
            status.textContent = 'Loading contracts…';
            body.replaceChildren();
            try {
                const rows = await this.call('list_admin_contracts', {
                    p_mode: el('contractModeFilter').value || null, p_state: el('contractStateFilter').value || null, p_limit: 200,
                    p_account_id: account || null, p_index: el('contractIndexFilter').value || null,
                    p_from: from ? `${from}T00:00:00Z` : null, p_to: to ? nextDay(to) : null,
                });
                if (!rows?.length) { status.textContent = 'No contracts match these filters.'; return; }
                status.textContent = `Showing the latest ${rows.length} matching contracts (dates in UTC).`;
                body.replaceChildren(...rows.map((contract) => h('tr', {}, [
                    cell(when(contract.created_at), 'ps-3'),
                    cell(short(contract.id), 'mono'),
                    cell(MODE_LABELS[contract.execution_mode] || contract.execution_mode),
                    cell(short(contract.trading_account_id), 'mono'),
                    cell(contract.index_code),
                    cell(`${contract.contract_type}${contract.barrier === null || contract.barrier === undefined ? '' : ` ${contract.barrier}`}`),
                    cell(money(contract.stake)),
                    cell(money(contract.payout)),
                    h('td', {}, [badge(contract.state, contract.state === 'WON' ? 'success' : contract.state === 'OPEN' ? 'info' : 'neutral')]),
                    cell(`${contract.entry_tick_no} → ${contract.settle_tick_no}`),
                    h('td', { className: 'text-end pe-3' }, [button('View', 'btn-inspect', () => this.openContract(contract.id))]),
                ])));
            } catch (error) {
                if (error !== STALE) status.textContent = `Could not load contracts. ${explain(error)}`;
            }
        }

        async openContract(contractId) {
            const content = el('contractDetailContent');
            el('contractDetailCard').hidden = false;
            this.contract = null;
            el('contractVoidForm').hidden = true;
            content.replaceChildren(h('p', { text: 'Loading contract…' }));
            try {
                const detail = await this.call('get_admin_contract_detail', { p_contract_id: contractId });
                const contract = detail.contract;
                this.contract = contract;
                const tick = (value) => (value ? `#${value.tick_no}: digit ${value.digit}, price ${value.price}, scheduled ${when(value.scheduled_at)}` : 'not published yet, or purged after retention');
                const facts = [
                    ['Contract', contract.id],
                    ['Customer', detail.customer ? `${detail.customer.email} (${detail.customer.user_id})` : '—'],
                    ['Account', `${MODE_LABELS[contract.execution_mode] || contract.execution_mode} · ${contract.trading_account_id}`],
                    ['Index and type', `${contract.index_code} · ${contract.contract_type}${contract.barrier === null ? '' : ` ${contract.barrier}`} · ${contract.win_digits} winning digits`],
                    ['Stake and payout', `${money(contract.stake)} → ${money(contract.payout)} (×${Number(contract.payout_multiplier).toFixed(4)})`],
                    ['Policy version', contract.policy_version],
                    ['Entry tick', tick(detail.entry_tick)],
                    ['Settle tick', tick(detail.settle_tick)],
                    ['Result', `${contract.state}${contract.exit_digit === null ? '' : ` · exit digit ${contract.exit_digit} at ${contract.exit_price}`} · settled ${when(contract.settled_at)}`],
                    ['Settlement attempts', `${contract.settlement_attempts}${contract.last_error ? ` · last error: ${contract.last_error}` : ''}`],
                ];
                content.replaceChildren(
                    h('dl', { className: 'row small' }, facts.flatMap(([term, value]) => [h('dt', { className: 'col-sm-3', text: term }), h('dd', { className: 'col-sm-9 mono', text: value })])),
                    h('h4', { className: 'h6', text: 'Ledger transactions' }),
                    h('ul', { className: 'small', attrs: { 'data-ledger': '' } }, detail.ledger_transactions.length ? detail.ledger_transactions.map((row) => h('li', { className: 'mono', text: `${row.id} · ${row.idempotency_key} · ${row.description} · ${when(row.created_at)}` })) : [h('li', { text: 'None.' })]),
                    h('h4', { className: 'h6', text: 'Events' }),
                    h('ul', { className: 'small', attrs: { 'data-events': '' } }, detail.events.length ? detail.events.map((row) => h('li', { text: `${row.event_type}${row.reason ? ` · ${row.reason}` : ''} · ${when(row.created_at)}` })) : [h('li', { text: 'None.' })]),
                );
                el('contractVoidForm').hidden = !(this.can('contracts.void') && contract.state === 'OPEN');
            } catch (error) {
                if (error !== STALE) content.replaceChildren(h('p', { text: `Could not load the contract. ${explain(error)}` }));
            }
        }

        async voidContract(form, reasonInput, status, contractId) {
            const reason = reasonInput.value.trim();
            if (reason.length < 10) { status.textContent = 'A void needs a reason of at least 10 characters.'; return; }
            status.textContent = 'Voiding contract…';
            try {
                if (!await this.runProtected(form, status, () => this.call('void_contract', { p_contract_id: contractId, p_reason: reason }))) return;
                reasonInput.value = '';
                form.hidden = true;
                status.textContent = 'Contract voided and the stake refunded.';
                if (this.contract?.id === contractId) await this.openContract(contractId);
                if (this.activeTab === 'enginePanel') this.loadStuck();
            } catch (error) { this.report(status, error); }
        }

        // ================= ENGINE =================
        bindEngineEvents() {
            el('engineModeFilter').onchange = () => this.loadEngine();
            el('engineRefresh').onclick = () => this.loadEngine();
            el('indexStatusCancel').onclick = () => { el('indexStatusCard').hidden = true; };
            el('indexStatusForm').onsubmit = async (event) => {
                event.preventDefault();
                const status = el('indexStatusMessage');
                const reason = el('indexStatusReason').value.trim();
                if (reason.length < 10) { status.textContent = 'Give a reason of at least 10 characters.'; return; }
                status.textContent = 'Updating index…';
                try {
                    await this.call('set_index_trading_status', { p_index: el('indexStatusIndex').value, p_mode: el('indexStatusMode').value, p_status: el('indexStatusTarget').value, p_reason: reason });
                    el('indexStatusCard').hidden = true;
                    el('engineStatus').textContent = `${el('indexStatusIndex').value} is now ${el('indexStatusTarget').value}.`;
                    this.loadIndices();
                } catch (error) { this.report(status, error); }
            };
            el('policyPublishForm').onsubmit = (event) => { event.preventDefault(); this.publishPolicy(); };
            el('engineVoidCancel').onclick = () => { el('engineVoidCard').hidden = true; };
            el('engineVoidForm').onsubmit = (event) => { event.preventDefault(); this.voidContract(el('engineVoidForm'), el('engineVoidReason'), el('engineVoidStatus'), el('engineVoidContract').value); };
        }

        engineMode() { return el('engineModeFilter').value || null; }

        loadEngine() {
            el('engineStatus').textContent = '';
            el('indexStatusCard').hidden = true;
            el('engineVoidCard').hidden = true;
            el('policyPublishForm').hidden = !this.can('engine.manage');
            return Promise.all([this.loadIndices(), this.loadPolicies(), this.loadExposure(), this.loadEpochs(), this.loadStuck()]);
        }

        async section(body, columns, loader) {
            body.replaceChildren(emptyRow(columns, 'Loading…'));
            try { await loader(); } catch (error) { if (error !== STALE) body.replaceChildren(emptyRow(columns, `Could not load. ${explain(error)}`)); }
        }

        loadIndices() {
            const body = el('engineHealthBody');
            return this.section(body, 12, async () => {
                const mode = this.engineMode();
                const [health, indices] = await Promise.all([this.call('get_admin_engine_health'), this.call('list_admin_engine_indices', { p_mode: mode })]);
                const rows = (health || []).filter((row) => !mode || row.execution_mode === mode);
                if (!rows.length) { body.replaceChildren(emptyRow(12, 'No indices for this account type.')); return; }
                body.replaceChildren(...rows.map((row) => {
                    const index = (indices || []).find((item) => item.code === row.index_code && item.execution_mode === row.execution_mode);
                    const next = index?.status === 'PAUSED' ? 'ACTIVE' : 'PAUSED';
                    const action = this.can('engine.manage') && index ? [button(next === 'PAUSED' ? 'Pause' : 'Resume', 'btn-market-toggle', () => this.openIndexStatus(row.index_code, row.execution_mode, next))] : [];
                    return h('tr', {}, [
                        cell(row.index_code, 'ps-3'), cell(MODE_LABELS[row.execution_mode] || row.execution_mode),
                        h('td', {}, [badge(index?.status || '—', index?.status === 'PAUSED' ? 'danger' : 'success')]),
                        h('td', {}, [badge(row.status, row.status === 'healthy' ? 'success' : row.status === 'watch' ? 'warn' : 'danger')]),
                        cell(row.last_tick_no), cell(`${Number(row.lag_seconds).toFixed(1)} s`), cell(row.missing_ticks_last_hour), cell(row.stuck_contracts), cell(row.retry_contracts),
                        cell(Number(row.chi_square).toFixed(2)), cell(row.longest_run),
                        h('td', { className: 'text-end pe-3' }, action),
                    ]);
                }));
            });
        }

        openIndexStatus(index, mode, target) {
            el('indexStatusIndex').value = index;
            el('indexStatusMode').value = mode;
            el('indexStatusTarget').value = target;
            el('indexStatusTitle').textContent = `${target === 'PAUSED' ? 'Pause' : 'Resume'} ${index} (${MODE_LABELS[mode] || mode})`;
            el('indexStatusReason').value = '';
            el('indexStatusMessage').textContent = target === 'PAUSED' ? 'Pausing blocks new purchases; ticks continue so open contracts settle.' : '';
            el('indexStatusCard').hidden = false;
        }

        loadPolicies() {
            const body = el('enginePolicyHistory');
            return this.section(body, 7, async () => {
                const history = await this.call('list_admin_engine_policies', { p_limit: 20 }) || [];
                const current = history[0];
                el('enginePolicyCurrent').textContent = current ? `Version ${current.version}, effective ${when(current.effective_from)}: margin ${(Number(current.house_margin) * 100).toFixed(2)}%, ${current.min_ticks}-${current.max_ticks} ticks, types ${current.enabled_contract_types.join(', ')}, Practice stake ${money(current.limits?.DEMO?.min_stake)}-${money(current.limits?.DEMO?.max_stake)}, liability per tick ${money(current.limits?.DEMO?.max_liability_per_tick)}. Reason: ${current.reason}` : 'No policy has been published.';
                body.replaceChildren(...(history.length ? history.map((row) => h('tr', {}, [
                    cell(row.version, 'ps-3'), cell(when(row.effective_from)), cell(`${(Number(row.house_margin) * 100).toFixed(2)}%`), cell(row.enabled_contract_types.join(', ')),
                    cell(`${money(row.limits?.DEMO?.min_stake)}-${money(row.limits?.DEMO?.max_stake)}`), cell(`${row.min_ticks}-${row.max_ticks}`), cell(row.reason),
                ])) : [emptyRow(7, 'No versions.')]));
                if (current && this.can('engine.manage')) this.fillPolicyForm(current);
            });
        }

        fillPolicyForm(policy) {
            const limits = policy.limits?.DEMO || {};
            const values = { policyHouseMargin: policy.house_margin, policyMinTicks: policy.min_ticks, policyMaxTicks: policy.max_ticks, policySettlementDelay: policy.max_settlement_delay_seconds, policyFeedLag: policy.max_feed_lag_seconds, policyMinProfit: policy.min_profit_ratio, policyRetention: policy.tick_retention_days, policyOverrides: JSON.stringify(policy.margin_overrides || {}), policyMinStake: limits.min_stake, policyMaxStake: limits.max_stake, policyMaxOpen: limits.max_open_contracts, policyMaxBuys: limits.max_buys_per_minute, policyMaxLiability: limits.max_liability_per_tick };
            for (const [id, value] of Object.entries(values)) el(id).value = value ?? '';
            el('policyPublishForm').querySelectorAll('[name="policyType"]').forEach((box) => { box.checked = policy.enabled_contract_types.includes(box.value); });
        }

        async publishPolicy() {
            const status = el('policyPublishStatus');
            const reason = el('policyReason').value.trim();
            if (reason.length < 10) { status.textContent = 'Give a reason of at least 10 characters.'; return; }
            let overrides;
            try { overrides = JSON.parse(el('policyOverrides').value.trim() || '{}'); } catch { status.textContent = 'Margin overrides must be JSON, for example {"MATCH": 0.05}.'; return; }
            const number = (id) => Number(el(id).value);
            const policy = {
                house_margin: number('policyHouseMargin'), min_ticks: number('policyMinTicks'), max_ticks: number('policyMaxTicks'),
                max_settlement_delay_seconds: number('policySettlementDelay'), max_feed_lag_seconds: number('policyFeedLag'), min_profit_ratio: number('policyMinProfit'), tick_retention_days: number('policyRetention'),
                enabled_contract_types: [...el('policyPublishForm').querySelectorAll('[name="policyType"]:checked')].map((box) => box.value), margin_overrides: overrides,
                limits: { DEMO: { min_stake: number('policyMinStake'), max_stake: number('policyMaxStake'), max_open_contracts: number('policyMaxOpen'), max_buys_per_minute: number('policyMaxBuys'), max_liability_per_tick: number('policyMaxLiability') } },
            };
            status.textContent = 'Publishing policy…';
            try {
                const version = await this.call('publish_engine_policy', { p_policy: policy, p_reason: reason });
                el('policyReason').value = '';
                await this.loadPolicies();
                status.textContent = `Published policy version ${version}. It applies to new purchases only.`;
            } catch (error) { this.report(status, error); }
        }

        loadExposure() {
            const body = el('engineExposureBody');
            return this.section(body, 5, async () => {
                const rows = await this.call('get_admin_engine_exposure', { p_mode: this.engineMode() }) || [];
                body.replaceChildren(...(rows.length ? rows.map((row) => h('tr', {}, [
                    cell(MODE_LABELS[row.execution_mode] || row.execution_mode, 'ps-3'), cell(row.index_code), cell(row.settle_tick_no), cell(money(row.max_liability)),
                    cell(row.net_loss_by_digit.map((value, digit) => `${digit}: ${money(value)}`).join(' · '), 'small mono'),
                ])) : [emptyRow(5, 'No open exposure.')]));
            });
        }

        loadEpochs() {
            const body = el('engineEpochsBody');
            return this.section(body, 6, async () => {
                const rows = await this.call('list_admin_engine_epochs', { p_mode: this.engineMode(), p_limit: 30 }) || [];
                const labels = { revealed: 'Revealed', awaiting_reveal: 'Awaiting reveal', active: 'In use', upcoming: 'Committed, upcoming' };
                body.replaceChildren(...(rows.length ? rows.map((row) => h('tr', {}, [
                    cell(`${String(row.starts_at).slice(0, 10)} (UTC)`, 'ps-3'), cell(MODE_LABELS[row.execution_mode] || row.execution_mode),
                    h('td', { className: 'mono small', text: short(row.seed_commitment), attrs: { title: row.seed_commitment } }),
                    h('td', { className: 'mono small', text: short(row.chain_hash), attrs: { title: row.chain_hash } }),
                    cell(when(row.committed_at)),
                    cell(row.revealed_at ? `${labels[row.reveal_status]} ${when(row.revealed_at)}` : labels[row.reveal_status]),
                ])) : [emptyRow(6, 'No epochs yet.')]));
            });
        }

        loadStuck() {
            const body = el('engineStuckBody');
            return this.section(body, 8, async () => {
                const rows = await this.call('list_admin_stuck_contracts', { p_mode: this.engineMode() }) || [];
                const reasons = { settle_tick_passed: 'Settle tick passed', settlement_retrying: 'Settlement retrying' };
                body.replaceChildren(...(rows.length ? rows.map((row) => h('tr', {}, [
                    cell(short(row.id), 'ps-3 mono'), cell(MODE_LABELS[row.execution_mode] || row.execution_mode), cell(row.index_code),
                    cell(`${row.settle_tick_no} (last ${row.last_tick_no})`), cell(reasons[row.stuck_reason] || row.stuck_reason), cell(row.settlement_attempts), cell(row.last_error),
                    h('td', { className: 'text-end pe-3' }, this.can('contracts.void') ? [button('Void', 'btn-lift', () => this.openEngineVoid(row))] : []),
                ])) : [emptyRow(8, 'No stuck contracts.')]));
            });
        }

        openEngineVoid(contract) {
            el('engineVoidContract').value = contract.id;
            el('engineVoidTitle').textContent = `Void contract ${contract.id}`;
            el('engineVoidReason').value = '';
            el('engineVoidStatus').textContent = 'The stake is refunded to the customer. Owner only; the void is audited.';
            el('engineVoidForm').hidden = false;
            el('engineVoidCard').hidden = false;
        }

        // ================= STAFF MANAGEMENT (OWNER ONLY) =================
        bindStaffEvents() {
            const form = el('staffRoleForm');
            form.onsubmit = async (event) => {
                event.preventDefault();
                const status = el('staffRoleStatus');
                const userId = el('staffRoleUserId').value;
                const version = parseInt(el('staffRoleVersion').value, 10);
                const reason = el('staffRoleReason').value.trim();
                if (!userId || Number.isNaN(version)) return;
                if (reason.length < 3) { status.textContent = 'Give a reason of at least 3 characters.'; return; }
                // One request id per intended change, reused if the same change is retried.
                if (!form.dataset.requestId) form.dataset.requestId = window.crypto.randomUUID();
                status.textContent = 'Saving role…';
                try {
                    if (!await this.runProtected(form, status, () => this.call('change_staff_role', { p_user_id: userId, p_role: el('staffRoleSelect').value, p_active: el('staffRoleActive').checked, p_expected_version: version, p_reason: reason, p_request_id: form.dataset.requestId }))) return;
                    delete form.dataset.requestId;
                    el('staffRoleCard').hidden = true;
                    await this.loadStaff();
                    el('staffStatus').textContent = 'Staff role saved.';
                } catch (error) { this.report(status, error); }
            };
            el('cancelStaffRole').onclick = () => { el('staffRoleCard').hidden = true; };
        }

        async loadStaff() {
            const status = el('staffStatus');
            const body = el('staffTableBody');
            status.textContent = 'Loading staff members…';
            body.replaceChildren();
            try {
                const data = await this.call('list_staff_members') || [];
                status.textContent = `${data.length} staff member${data.length !== 1 ? 's' : ''}`;
                body.replaceChildren(...data.map((member) => h('tr', {}, [
                    h('td', { className: 'ps-3' }, [h('strong', { text: member.display_name }), h('br'), h('small', { className: 'mono', text: member.email })]),
                    h('td', {}, [badge(member.role.replace('_', ' '), 'info')]),
                    h('td', {}, [member.active ? badge('Active', 'success') : badge('Inactive', 'warn')]),
                    cell(`v${member.version}`, 'text-muted'),
                    cell(new Date(member.updated_at).toLocaleDateString(), 'text-muted'),
                    h('td', { className: 'text-end pe-3' }, [button('Manage role', 'btn-edit-staff', () => {
                        el('staffRoleTitle').textContent = `Manage staff role: ${member.display_name}`;
                        el('staffRoleUserId').value = member.user_id;
                        el('staffRoleVersion').value = member.version;
                        el('staffRoleSelect').value = member.role;
                        el('staffRoleActive').checked = member.active;
                        el('staffRoleReason').value = '';
                        el('staffRoleStatus').textContent = '';
                        delete el('staffRoleForm').dataset.requestId;
                        el('staffRoleCard').hidden = false;
                    })]),
                ])));
            } catch (error) {
                if (error !== STALE) status.textContent = `Could not load staff. ${explain(error)}`;
            }
        }

        clear() {
            this.generation++;
            this.client = null;
            this.context = null;
            this.capabilities = new Set();
            this.customerId = null;
            this.contract = null;
            for (const id of ['overviewCards', 'customersTableBody', 'customerAccountsList', 'customerRestrictionsList', 'contractsTableBody', 'contractDetailContent', 'engineHealthBody', 'enginePolicyHistory', 'engineExposureBody', 'engineEpochsBody', 'engineStuckBody', 'staffTableBody']) el(id)?.replaceChildren();
            for (const id of ['overviewStatus', 'customersStatus', 'restrictionStatus', 'restrictionListStatus', 'contractsStatus', 'contractVoidStatus', 'engineStatus', 'enginePolicyCurrent', 'policyPublishStatus', 'indexStatusMessage', 'engineVoidStatus', 'staffStatus', 'staffRoleStatus']) { const node = el(id); if (node) node.textContent = ''; }
            for (const id of ['customerDetailModal', 'contractDetailCard', 'indexStatusCard', 'engineVoidCard', 'staffRoleCard']) { const node = el(id); if (node) node.hidden = true; }
            document.querySelectorAll('[data-reverify]').forEach((wrap) => { wrap.hidden = true; wrap.querySelectorAll('input').forEach((input) => { input.value = ''; }); });
        }
    }

    window.adminOperations = new AdminOperations();
    window.smartProfitAdminRules = Object.freeze({ restrictionCapability, restrictionAllowed });
})();
