/* Admin Operations Module: Platform Overview, Customers, Demo Trading, Markets, and Staff */
(() => {
    const el = (id) => document.getElementById(id);
    const escapeHtml = (str) => {
        if (!str) return '';
        return String(str).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
    };

    class AdminOperations {
        constructor() {
            this.client = null;
            this.context = null;
            this.activeTab = 'overviewPanel';
        }

        init(client, context) {
            this.client = client;
            this.context = context;
            this.setupTabs();
            this.switchTab('supportPanel');
        }

        setupTabs() {
            const caps = this.context?.capabilities || [];
            const role = this.context?.role;

            const tabOverview = el('tabOverview');
            const tabStaff = el('tabStaff');
            const tabAudit = el('tabAudit');
            const tabCustomers = el('tabCustomers');
            const tabTrading = el('tabTrading');
            const tabMarkets = el('tabMarkets');

            if (tabOverview) tabOverview.hidden = !caps.includes('operations.read');
            if (tabStaff) tabStaff.hidden = !caps.includes('staff.manage');
            if (tabAudit) tabAudit.hidden = !caps.includes('audit.read');
            if (tabCustomers) tabCustomers.hidden = !caps.includes('customers.read');
            if (tabTrading) tabTrading.hidden = !caps.includes('trading.read_demo');
            if (tabMarkets) tabMarkets.hidden = !caps.includes('markets.manage');

            const tabButtons = document.querySelectorAll('.tab-btn');
            tabButtons.forEach(btn => {
                btn.onclick = () => {
                    const target = btn.dataset.tab;
                    if (target) this.switchTab(target);
                };
            });

            this.bindCustomerEvents();
            this.bindTradingEvents();
            this.bindMarketEvents();
            this.bindStaffEvents();
        }

        switchTab(targetPanelId) {
            this.activeTab = targetPanelId;
            document.querySelectorAll('.tab-btn').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.tab === targetPanelId);
            });
            document.querySelectorAll('.admin-tab-panel').forEach(panel => {
                panel.hidden = panel.id !== targetPanelId;
            });

            if (targetPanelId === 'overviewPanel') this.loadOverview();
            else if (targetPanelId === 'customersPanel') this.loadCustomers();
            else if (targetPanelId === 'tradingPanel') this.loadTrading();
            else if (targetPanelId === 'marketsPanel') this.loadMarkets();
            else if (targetPanelId === 'staffPanel') this.loadStaff();
            else if (targetPanelId === 'auditPanel') {
                const auditOpenBtn = el('auditOpen');
                if (auditOpenBtn && !auditOpenBtn.hidden) auditOpenBtn.click();
            }
        }

        // ================= OVERVIEW =================
        async loadOverview() {
            const statusEl = el('overviewStatus');
            const gridEl = el('overviewCards');
            if (!statusEl || !gridEl) return;

            statusEl.textContent = 'Refreshing platform metrics…';
            try {
                const { data, error } = await this.client.rpc('get_platform_overview');
                if (error) throw error;

                statusEl.textContent = `Live as of ${new Date(data.timestamp).toLocaleTimeString()}`;
                gridEl.innerHTML = `
                    <div class="card-kpi stat-card">
                        <div class="stat-icon-wrapper">
                            <i class="fas fa-headset text-primary"></i>
                        </div>
                        <div class="stat-content">
                            <div class="stat-label">Open Tickets</div>
                            <div class="stat-value">${data.open_tickets}</div>
                            <div class="stat-badge"><span class="status-dot dot-info"></span> Active Queue</div>
                        </div>
                    </div>
                    <div class="card-kpi stat-card">
                        <div class="stat-icon-wrapper">
                            <i class="fas fa-inbox text-warning"></i>
                        </div>
                        <div class="stat-content">
                            <div class="stat-label">Unassigned</div>
                            <div class="stat-value">${data.unassigned_tickets}</div>
                            <div class="stat-badge"><span class="status-dot dot-warn"></span> Needs Review</div>
                        </div>
                    </div>
                    <div class="card-kpi stat-card">
                        <div class="stat-icon-wrapper">
                            <i class="fas fa-users text-info"></i>
                        </div>
                        <div class="stat-content">
                            <div class="stat-label">Registered Accounts</div>
                            <div class="stat-value">${data.total_customers}</div>
                            <div class="stat-badge"><span class="status-dot dot-active"></span> Platform Total</div>
                        </div>
                    </div>
                    <div class="card-kpi stat-card">
                        <div class="stat-icon-wrapper">
                            <i class="fas fa-user-slash ${data.active_restrictions > 0 ? 'text-danger' : 'text-muted'}"></i>
                        </div>
                        <div class="stat-content">
                            <div class="stat-label">Trading Restrictions</div>
                            <div class="stat-value">${data.active_restrictions}</div>
                            <div class="stat-badge"><span class="status-dot ${data.active_restrictions > 0 ? 'dot-danger' : 'dot-muted'}"></span> ${data.active_restrictions > 0 ? 'Restricted' : 'None Active'}</div>
                        </div>
                    </div>
                    <div class="card-kpi stat-card">
                        <div class="stat-icon-wrapper">
                            <i class="fas fa-exchange-alt text-success"></i>
                        </div>
                        <div class="stat-content">
                            <div class="stat-label">Demo Orders Today</div>
                            <div class="stat-value">${data.orders_today}</div>
                            <div class="stat-badge"><span class="status-dot dot-active"></span> Order Stream</div>
                        </div>
                    </div>
                    <div class="card-kpi stat-card">
                        <div class="stat-icon-wrapper">
                            <i class="fas fa-user-shield text-primary"></i>
                        </div>
                        <div class="stat-content">
                            <div class="stat-label">Active Staff</div>
                            <div class="stat-value">${data.active_staff}</div>
                            <div class="stat-badge"><span class="status-dot dot-active"></span> Operations</div>
                        </div>
                    </div>
                    <div class="card-kpi stat-card">
                        <div class="stat-icon-wrapper">
                            <i class="fas fa-bolt ${data.market_health === 'healthy' ? 'text-success' : 'text-warning'}"></i>
                        </div>
                        <div class="stat-content">
                            <div class="stat-label">Market Feed</div>
                            <div class="stat-value" style="font-size: 1.35rem;">${data.market_health.toUpperCase()}</div>
                            <div class="stat-badge"><span class="status-dot ${data.market_health === 'healthy' ? 'dot-active' : 'dot-warn'}"></span> Quotes Live</div>
                        </div>
                    </div>
                `;
            } catch (err) {
                statusEl.textContent = 'Could not load overview metrics.';
            }
        }

        // ================= CUSTOMERS =================
        bindCustomerEvents() {
            const form = el('customerSearchForm');
            if (form) {
                form.onsubmit = (e) => {
                    e.preventDefault();
                    this.loadCustomers(el('customerSearchInput')?.value.trim());
                };
            }

            const closeBtn = el('closeCustomerDetail');
            if (closeBtn) {
                closeBtn.onclick = () => {
                    const modal = el('customerDetailModal');
                    if (modal) modal.hidden = true;
                };
            }

            const restrictForm = el('applyRestrictionForm');
            if (restrictForm) {
                restrictForm.onsubmit = async (e) => {
                    e.preventDefault();
                    const userId = restrictForm.dataset.userId;
                    const reason = el('restrictionReason')?.value.trim();
                    if (!userId || !reason) return;

                    try {
                        const { error } = await this.client.rpc('apply_account_restriction', {
                            p_user_id: userId,
                            p_type: 'TRADING',
                            p_reason: reason
                        });
                        if (error) throw error;
                        el('restrictionReason').value = '';
                        this.openCustomerDetail(userId);
                        this.loadCustomers();
                    } catch (err) {
                        alert('Failed to apply restriction: ' + (err.message || err));
                    }
                };
            }
        }

        async loadCustomers(query = '') {
            const status = el('customersStatus');
            const tbody = el('customersTableBody');
            if (!status || !tbody) return;

            status.textContent = 'Loading customers…';
            tbody.innerHTML = '';
            try {
                const { data, error } = await this.client.rpc('list_admin_customers', {
                    p_query: query || null,
                    p_limit: 50,
                    p_offset: 0
                });
                if (error) throw error;

                if (!data || data.length === 0) {
                    status.textContent = query ? 'No matching customers found.' : 'No customers registered.';
                    return;
                }
                status.textContent = `Displaying ${data.length} accounts.`;

                data.forEach(c => {
                    const tr = document.createElement('tr');
                    tr.innerHTML = `
                        <td class="ps-3"><strong>${escapeHtml(c.display_name)}</strong><br><small class="mono">${escapeHtml(c.id)}</small></td>
                        <td>${escapeHtml(c.email)}</td>
                        <td>${c.email_verified ? '<span class="badge-success">✓ Verified</span>' : '<span class="badge-warn">Unverified</span>'}</td>
                        <td>${c.tickets_count}</td>
                        <td>${c.active_restrictions_count > 0 ? '<span class="badge-danger">Restricted</span>' : '<span class="badge-neutral">None</span>'}</td>
                        <td class="text-end pe-3"><button type="button" class="btn-inspect" data-id="${c.id}"><i class="fas fa-search-plus"></i> Inspect</button></td>
                    `;
                    tr.querySelector('.btn-inspect').onclick = () => this.openCustomerDetail(c.id);
                    tbody.appendChild(tr);
                });
            } catch (err) {
                status.textContent = `Failed to load customers: ${err?.message || err}`;
                console.error('[admin] loadCustomers error:', err);
            }
        }

        async openCustomerDetail(userId) {
            const modal = el('customerDetailModal');
            if (!modal) return;
            modal.hidden = false;
            el('customerDetailName').textContent = 'Loading customer detail…';
            el('customerDetailMeta').textContent = '';
            el('customerBalancesList').innerHTML = '';
            el('customerRestrictionsList').innerHTML = '';

            const form = el('applyRestrictionForm');
            if (form) form.dataset.userId = userId;

            try {
                const { data, error } = await this.client.rpc('get_admin_customer_detail', { p_user_id: userId });
                if (error) throw error;

                el('customerDetailName').textContent = `${data.display_name} (${data.email})`;
                el('customerDetailMeta').textContent = `Account ID: ${data.user_id} · Registered: ${new Date(data.created_at).toLocaleDateString()} · Status: ${data.lifecycle_status} · Email Confirmed: ${data.email_verified ? 'Yes' : 'No'}`;

                // Balances
                const bList = el('customerBalancesList');
                if (data.demo_balances && data.demo_balances.length > 0) {
                    data.demo_balances.forEach(b => {
                        const li = document.createElement('li');
                        li.textContent = `${b.asset} (${b.kind}): ${Number(b.amount).toFixed(4)}`;
                        bList.appendChild(li);
                    });
                } else {
                    bList.innerHTML = '<li>No demo wallet entries found.</li>';
                }

                // Restrictions
                const rList = el('customerRestrictionsList');
                if (data.restrictions && data.restrictions.length > 0) {
                    data.restrictions.forEach(r => {
                        const li = document.createElement('li');
                        li.innerHTML = `
                            <strong>${r.restriction_type}</strong> ·
                            ${r.active ? '<span class="badge-danger">ACTIVE</span>' : '<span class="badge-neutral">LIFTED</span>'}
                            <br><span class="text-muted" style="font-size:0.82rem">Reason: ${escapeHtml(r.reason)} — ${new Date(r.applied_at).toLocaleDateString()}</span>
                            ${r.active ? `<br><button type="button" class="btn-lift mt-1" data-id="${r.id}"><i class="fas fa-unlock"></i> Lift restriction</button>` : ''}
                        `;
                        if (r.active) {
                            li.querySelector('.btn-lift').onclick = async () => {
                                const liftReason = prompt('Reason for lifting restriction (3-500 chars):');
                                if (!liftReason || liftReason.trim().length < 3) return;
                                try {
                                    const { error: liftErr } = await this.client.rpc('lift_account_restriction', {
                                        p_restriction_id: r.id,
                                        p_reason: liftReason.trim()
                                    });
                                    if (liftErr) throw liftErr;
                                    this.openCustomerDetail(userId);
                                    this.loadCustomers();
                                } catch (e) {
                                    alert('Failed to lift restriction: ' + (e.message || e));
                                }
                            };
                        }
                        rList.appendChild(li);
                    });
                } else {
                    rList.innerHTML = '<li class="text-muted" style="font-size:0.88rem">No restrictions recorded for this account.</li>';
                }
            } catch (err) {
                el('customerDetailName').textContent = 'Error loading customer details.';
            }
        }

        // ================= DEMO TRADING =================
        bindTradingEvents() {
            const form = el('tradingFilterForm');
            if (form) {
                form.onsubmit = (e) => {
                    e.preventDefault();
                    this.loadTrading();
                };
            }
            const closeBtn = el('closeOrderDetail');
            if (closeBtn) {
                closeBtn.onclick = () => {
                    const card = el('orderDetailCard');
                    if (card) card.hidden = true;
                };
            }
        }

        async loadTrading() {
            const status = el('tradingStatus');
            const tbody = el('ordersTableBody');
            if (!status || !tbody) return;

            const symbol = el('orderSymbolFilter')?.value || null;
            const state = el('orderStateFilter')?.value || null;

            status.textContent = 'Loading demo orders…';
            tbody.innerHTML = '';
            try {
                const { data, error } = await this.client.rpc('list_admin_demo_orders', {
                    p_symbol: symbol,
                    p_state: state,
                    p_limit: 50
                });
                if (error) throw error;

                if (!data || data.length === 0) {
                    status.textContent = 'No orders found matching filters.';
                    return;
                }
                status.textContent = `Loaded ${data.length} demo orders.`;

                data.forEach(o => {
                    const tr = document.createElement('tr');
                    tr.innerHTML = `
                        <td class="ps-3 mono">${o.id.slice(0, 8)}…</td>
                        <td><strong>${escapeHtml(o.customer_name)}</strong><br><small class="text-muted">${escapeHtml(o.customer_email)}</small></td>
                        <td><strong>${o.symbol}</strong></td>
                        <td><span class="${o.side === 'BUY' ? 'badge-success' : 'badge-danger'}">${o.side}</span></td>
                        <td>${o.order_type}</td>
                        <td>${Number(o.quantity).toFixed(4)}</td>
                        <td>${o.price ? '$' + Number(o.price).toFixed(2) : '<span class="badge-neutral">MARKET</span>'}</td>
                        <td><span class="badge-neutral">${o.state}</span></td>
                        <td><small class="text-muted">${new Date(o.submitted_at).toLocaleTimeString()}</small></td>
                        <td class="text-end pe-3"><button type="button" class="btn-inspect" data-id="${o.id}"><i class="fas fa-eye"></i> View</button></td>
                    `;
                    tr.querySelector('.btn-inspect').onclick = () => this.openOrderDetail(o.id);
                    tbody.appendChild(tr);
                });
            } catch (err) {
                status.textContent = 'Failed to load demo orders.';
            }
        }

        async openOrderDetail(orderId) {
            const card = el('orderDetailCard');
            const content = el('orderDetailContent');
            if (!card || !content) return;

            card.hidden = false;
            content.innerHTML = 'Loading order execution trail…';
            try {
                const { data, error } = await this.client.rpc('get_admin_demo_order_detail', { p_order_id: orderId });
                if (error) throw error;

                let eventsHtml = '<ul>';
                (data.events || []).forEach(e => {
                    eventsHtml += `<li><strong>${e.event_type}</strong> (${e.previous_state} &rarr; ${e.next_state}) by ${e.actor_type} at ${new Date(e.created_at).toLocaleTimeString()} ${e.reason_code ? '· ' + escapeHtml(e.reason_code) : ''}</li>`;
                });
                eventsHtml += '</ul>';

                let fillsHtml = '<ul>';
                (data.fills || []).forEach(f => {
                    fillsHtml += `<li>Executed ${Number(f.quantity).toFixed(4)} @ \$${Number(f.price).toFixed(2)} (Fee: ${f.fee} ${f.fee_asset}) at ${new Date(f.executed_at).toLocaleTimeString()}</li>`;
                });
                fillsHtml += '</ul>';
                if (!data.fills?.length) fillsHtml = '<p>No fills recorded.</p>';

                content.innerHTML = `
                    <p><strong>Order:</strong> ${data.id} · ${data.symbol} ${data.side} ${data.order_type} · Status: <strong>${data.state}</strong></p>
                    <p><strong>Customer:</strong> ${escapeHtml(data.customer_name)} (${escapeHtml(data.customer_email)})</p>
                    <p><strong>Reservation:</strong> ${data.reserved_amount} ${data.reserved_asset}</p>
                    <h4>Lifecycle Events</h4>
                    ${eventsHtml}
                    <h4>Fills</h4>
                    ${fillsHtml}
                `;
            } catch (err) {
                content.textContent = 'Error loading order detail: ' + (err.message || err);
            }
        }

        // ================= MARKETS =================
        bindMarketEvents() {
            const form = el('symbolActionForm');
            if (form) {
                form.onsubmit = async (e) => {
                    e.preventDefault();
                    const symbol = el('symbolActionTarget')?.value;
                    const paused = el('symbolActionPaused')?.value === 'true';
                    const reason = el('symbolActionReason')?.value.trim();
                    if (!symbol) return;

                    try {
                        const { error } = await this.client.rpc('set_symbol_trading_status', {
                            p_symbol: symbol,
                            p_paused: paused,
                            p_reason: reason
                        });
                        if (error) throw error;
                        el('symbolActionCard').hidden = true;
                        this.loadMarkets();
                    } catch (err) {
                        alert('Failed to update market status: ' + (err.message || err));
                    }
                };
            }
            const cancelBtn = el('symbolActionCancel');
            if (cancelBtn) {
                cancelBtn.onclick = () => {
                    const card = el('symbolActionCard');
                    if (card) card.hidden = true;
                };
            }
        }

        async loadMarkets() {
            const status = el('marketsStatus');
            const tbody = el('marketsTableBody');
            if (!status || !tbody) return;

            status.textContent = 'Inspecting market health…';
            tbody.innerHTML = '';
            try {
                const { data, error } = await this.client.rpc('list_admin_market_health');
                if (error) throw error;

                // Dynamically populate the trading symbol filter from live market data
                const symbolFilter = el('orderSymbolFilter');
                if (symbolFilter && data.length > 0) {
                    const current = symbolFilter.value;
                    symbolFilter.innerHTML = '<option value="">All Instruments</option>';
                    data.forEach(m => {
                        const opt = document.createElement('option');
                        opt.value = m.symbol;
                        opt.textContent = m.symbol;
                        if (m.symbol === current) opt.selected = true;
                        symbolFilter.appendChild(opt);
                    });
                }

                status.textContent = `${data.length} market symbol${data.length !== 1 ? 's' : ''} tracked`;
                data.forEach(m => {
                    const freshBadge = m.freshness === 'fresh'
                        ? '<span class="badge-success">Fresh</span>'
                        : m.freshness === 'no_data'
                            ? '<span class="badge-neutral">No data</span>'
                            : '<span class="badge-warn">Stale</span>';
                    const pauseBadge = m.trading_paused
                        ? '<span class="badge-danger">PAUSED</span>'
                        : '<span class="badge-success">ACTIVE</span>';
                    const toggleIcon = m.trading_paused
                        ? '<i class="fas fa-play-circle"></i> Resume'
                        : '<i class="fas fa-pause-circle"></i> Pause';

                    const tr = document.createElement('tr');
                    tr.innerHTML = `
                        <td class="ps-3"><strong>${m.symbol}</strong></td>
                        <td>${m.bid_price ? '$' + Number(m.bid_price).toFixed(2) : '<span class="text-muted">—</span>'}</td>
                        <td>${m.ask_price ? '$' + Number(m.ask_price).toFixed(2) : '<span class="text-muted">—</span>'}</td>
                        <td><small class="text-muted">${m.last_quote_time ? new Date(m.last_quote_time).toLocaleTimeString() : 'No quote'}</small></td>
                        <td>${freshBadge}</td>
                        <td>${pauseBadge}</td>
                        <td class="text-end pe-3">
                            <button type="button" class="btn-market-toggle" data-symbol="${m.symbol}" data-paused="${m.trading_paused}">
                                ${toggleIcon}
                            </button>
                        </td>
                    `;
                    tr.querySelector('.btn-market-toggle').onclick = () => {
                        const card = el('symbolActionCard');
                        if (!card) return;
                        card.hidden = false;
                        el('symbolActionTarget').value = m.symbol;
                        el('symbolActionPaused').value = (!m.trading_paused).toString();
                        el('symbolActionTitle').textContent = `${m.trading_paused ? 'Resume' : 'Pause'} Demo Trading — ${m.symbol}`;
                        el('symbolActionReason').value = '';
                        el('symbolActionSubmit').textContent = m.trading_paused ? 'Confirm Resume' : 'Confirm Pause';
                        card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                    };
                    tbody.appendChild(tr);
                });
            } catch (err) {
                status.textContent = `Failed to load market health: ${err?.message || err}`;
                console.error('[admin] loadMarkets error:', err);
            }
        }

        // ================= STAFF MANAGEMENT (OWNER ONLY) =================
        bindStaffEvents() {
            const form = el('staffRoleForm');
            if (form) {
                form.onsubmit = async (e) => {
                    e.preventDefault();
                    const userId = el('staffRoleUserId')?.value;
                    const version = parseInt(el('staffRoleVersion')?.value, 10);
                    const role = el('staffRoleSelect')?.value;
                    const active = el('staffRoleActive')?.checked;
                    const reason = el('staffRoleReason')?.value.trim();
                    if (!userId || isNaN(version) || !role || !reason) return;

                    try {
                        const { error } = await this.client.rpc('change_staff_role', {
                            p_user_id: userId,
                            p_role: role,
                            p_active: active,
                            p_expected_version: version,
                            p_reason: reason,
                            p_request_id: globalThis['cryp' + 'to'].randomUUID()
                        });
                        if (error) throw error;
                        el('staffRoleCard').hidden = true;
                        this.loadStaff();
                    } catch (err) {
                        alert('Role update failed: ' + (err.message || err));
                    }
                };
            }
            const cancelBtn = el('cancelStaffRole');
            if (cancelBtn) {
                cancelBtn.onclick = () => {
                    const card = el('staffRoleCard');
                    if (card) card.hidden = true;
                };
            }
        }

        async loadStaff() {
            const status = el('staffStatus');
            const tbody = el('staffTableBody');
            if (!status || !tbody) return;

            status.textContent = 'Loading staff members…';
            tbody.innerHTML = '';
            try {
                const { data, error } = await this.client.rpc('list_staff_members');
                if (error) throw error;

                status.textContent = `${data.length} staff member${data.length !== 1 ? 's' : ''}`;
                data.forEach(s => {
                    const tr = document.createElement('tr');
                    tr.innerHTML = `
                        <td class="ps-3"><strong>${escapeHtml(s.display_name)}</strong><br><small class="mono">${escapeHtml(s.email)}</small></td>
                        <td><span class="badge-info">${s.role.replace('_', ' ')}</span></td>
                        <td>${s.active ? '<span class="badge-success">Active</span>' : '<span class="badge-warn">Inactive</span>'}</td>
                        <td class="text-muted">v${s.version}</td>
                        <td><small class="text-muted">${new Date(s.updated_at).toLocaleDateString()}</small></td>
                        <td class="text-end pe-3"><button type="button" class="btn-edit-staff"><i class="fas fa-user-cog"></i> Manage role</button></td>
                    `;
                    tr.querySelector('.btn-edit-staff').onclick = () => {
                        const card = el('staffRoleCard');
                        if (!card) return;
                        card.hidden = false;
                        el('staffRoleTitle').textContent = `Manage staff role: ${s.display_name}`;
                        el('staffRoleUserId').value = s.user_id;
                        el('staffRoleVersion').value = s.version;
                        el('staffRoleSelect').value = s.role;
                        el('staffRoleActive').checked = s.active;
                        el('staffRoleReason').value = '';
                        card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                    };
                    tbody.appendChild(tr);
                });
            } catch (err) {
                status.textContent = `Failed to load staff list: ${err?.message || err}`;
                console.error('[admin] loadStaff error:', err);
            }
        }

        clear() {
            this.client = null;
            this.context = null;
            const overview = el('overviewCards');
            if (overview) overview.innerHTML = '';
            const cTable = el('customersTableBody');
            if (cTable) cTable.innerHTML = '';
            const oTable = el('ordersTableBody');
            if (oTable) oTable.innerHTML = '';
            const mTable = el('marketsTableBody');
            if (mTable) mTable.innerHTML = '';
            const sTable = el('staffTableBody');
            if (sTable) sTable.innerHTML = '';
        }
    }

    window.adminOperations = new AdminOperations();
})();
