import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { webcrypto } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { createTestDatabase } from './helpers/test-db.mjs';

const tick = () => new Promise(resolve => setTimeout(resolve, 5));
async function setup({ guest = false, rpc, requiredStep = null, role = 'owner', mfaError = null, staffClient = true } = {}) {
    const elements = new Map();
    const el = (id) => {
        if (!elements.has(id)) elements.set(id, {
            value: '', hidden: true, disabled: false, textContent: '', children: [], listeners: {},
            addEventListener(event, fn) { this.listeners[event] = fn; },
            append(...children) { this.children.push(...children); },
            replaceChildren(...children) { this.children = children; }
        });
        return elements.get(id);
    };
    let init, authCallback;
    let session = guest ? null : { user: { id: 'staff', email: 'staff@example.test' } };
    let ctx = { user_id: 'staff', role, version: 1, capabilities: requiredStep ? [] : role === 'owner' ? ['staff.enter', 'audit.read'] : ['staff.enter'], required_step: requiredStep };
    const calls = [], timers = new Set();
    const client = {
        auth: {
            onAuthStateChange(fn) { authCallback = fn; return { data: { subscription: { unsubscribe() {} } } }; },
            getSession: async () => ({ data: { session } }),
            signOut: async () => { session = null; authCallback('SIGNED_OUT', null); return {}; },
            mfa: {
                listFactors: async () => ({ data: { totp: [{ id: 'factor', friendly_name: 'My authenticator' }] } }),
                challengeAndVerify: async (payload) => { calls.push({ name: 'verify', payload }); if (mfaError) return { error: mfaError }; ctx = { ...ctx, required_step: null, capabilities: ['staff.enter', 'audit.read'] }; return {}; }
            }
        },
        async rpc(name, payload) { calls.push({ name, payload }); return rpc ? rpc(name, payload) : { data: name === 'get_staff_context' ? ctx : [] }; }
    };
    const windowListeners = {};
    vm.runInNewContext(fs.readFileSync('assets/js/admin.js', 'utf8'), {
        document: { getElementById: el, createElement: () => el(Symbol()), addEventListener: (_, fn) => { init = fn; } },
        // The console binds to the isolated staff client only. `staffClient: false`
        // exposes the customer client instead — what the old shared-auth build did —
        // and the tests below assert that this no longer opens the workspace.
        window: {
            getStaffSupabaseClient: staffClient ? async () => client : undefined,
            getSupabaseClient: async () => client,
            addEventListener: (event, fn) => { windowListeners[event] = fn; }
        },
        setTimeout(fn, delay) { if (delay > 1000) return 0; const timer = setTimeout(fn, delay); timers.add(timer); return timer; },
        clearTimeout, Date
    });
    const ready = init();
    return { el, calls, ready, client,
        auth(next) { session = next; authCallback(next ? 'SIGNED_IN' : 'SIGNED_OUT', next); },
        dispose() { windowListeners.pagehide?.(); timers.forEach(clearTimeout); },
        click: (id) => el(id).listeners.click(),
        submit: () => el('mfaForm').listeners.submit({ preventDefault() {} })
    };
}

test('guest sees a sign-in path without requesting staff data', async () => {
    const b = await setup({ guest: true }); await b.ready;
    assert.equal(b.el('adminSignIn').hidden, false);
    assert.equal(b.el('adminWorkspace').hidden, true);
    assert.equal(b.calls.length, 0); b.dispose();
});

test('denied and network error states differ and never expose the workspace', async () => {
    for (const [message, expected] of [['forbidden', /does not have staff access/], ['network', /could not verify/]]) {
        const b = await setup({ rpc: async () => ({ error: { message } }) }); await b.ready;
        assert.match(b.el('adminStatus').textContent, expected);
        assert.equal(b.el('adminWorkspace').hidden, true);
        assert.equal(b.el('adminRetry').hidden, false); b.dispose();
    }
});

test('MFA gate blocks protected reads and opens workspace only after confirmation', async () => {
    const b = await setup({ requiredStep: 'mfa' }); await b.ready;
    assert.equal(b.el('adminMfa').hidden, false);
    assert.equal(b.el('adminWorkspace').hidden, true);
    await b.click('auditOpen'); assert.equal(b.calls.length, 1);
    b.el('mfaCode').value = '123456'; await b.submit();
    assert.equal(b.el('adminWorkspace').hidden, false);
    assert.equal(b.el('mfaCode').value, ''); b.dispose();
});

test('failed MFA verification stays gated with a retryable error', async () => {
    const b = await setup({ requiredStep: 'mfa', mfaError: new Error('invalid code') }); await b.ready;
    b.el('mfaCode').value = '123456'; await b.submit();
    assert.equal(b.el('adminWorkspace').hidden, true);
    assert.equal(b.el('mfaVerify').disabled, false);
    assert.match(b.el('mfaStatus').textContent, /Verification failed/); b.dispose();
});

test('role controls navigation and identity comes from the current session', async () => {
    const b = await setup({ role: 'support_agent' }); await b.ready;
    assert.match(b.el('adminIdentity').textContent, /staff@example.test · Support agent/);
    assert.equal(b.el('auditOpen').hidden, true);
    await b.click('auditOpen'); assert.equal(b.calls.length, 1); b.dispose();
});

test('late permission response after sign-out cannot restore protected content', async () => {
    let finish;
    const b = await setup({ rpc: () => new Promise(resolve => { finish = resolve; }) });
    await tick(); b.auth(null);
    finish({ data: { user_id: 'staff', role: 'owner', capabilities: ['staff.enter', 'audit.read'], required_step: null } });
    await b.ready; await tick();
    assert.equal(b.el('adminWorkspace').hidden, true);
    assert.equal(b.el('adminIdentity').textContent, '');
    assert.equal(b.el('adminSignIn').hidden, false); b.dispose();
});

test('late audit response after identity change is discarded and secrets are cleared', async () => {
    let finish;
    const b = await setup({ rpc: async (name) => name === 'get_staff_context' ? { data: { user_id: 'staff', role: 'owner', capabilities: ['staff.enter', 'audit.read'] } } : new Promise(resolve => { finish = resolve; }) });
    await b.ready;
    b.el('mfaSecret').value = 'sensitive setup key';
    const pending = b.click('auditOpen'); b.auth(null);
    assert.equal(b.el('mfaSecret').value, '');
    finish({ data: [{ id: 'audit', reason: 'Sensitive staff action', created_at: new Date().toISOString() }] });
    await pending; await tick();
    assert.equal(b.el('auditEvents').children.length, 0);
    assert.equal(b.el('auditPanel').hidden, true);
    assert.equal(b.el('auditOpen').disabled, false); b.dispose();
});

test('revocation during audit read immediately clears all staff data', async () => {
    const b = await setup({ rpc: async (name) => name === 'get_staff_context' ? { data: { user_id: 'staff', role: 'owner', capabilities: ['staff.enter', 'audit.read'] } } : { error: { message: 'forbidden' } } });
    await b.ready; await b.click('auditOpen');
    assert.equal(b.el('adminWorkspace').hidden, true);
    assert.equal(b.el('adminIdentity').textContent, '');
    assert.match(b.el('adminStatus').textContent, /does not have staff access/); b.dispose();
});

test('audit distinguishes empty from failed queries and renders reasons literally', async () => {
    let response = { data: [] };
    const b = await setup({ rpc: async (name) => name === 'get_staff_context' ? { data: { user_id: 'staff', role: 'owner', capabilities: ['staff.enter', 'audit.read'] } } : response });
    await b.ready; await b.click('auditOpen');
    assert.equal(b.el('auditStatus').textContent, 'No audit events yet.');
    response = { error: new Error('network') };
    await b.click('auditOpen');
    assert.match(b.el('auditStatus').textContent, /could not be loaded/);
    assert.equal(b.el('auditOpen').disabled, false);
    const reason = '<img src=x onerror=alert(1)>';
    response = { data: [{ id: 'event', action: 'staff.role_change', reason, created_at: new Date().toISOString() }] };
    await b.click('auditOpen');
    assert.equal(b.el('auditEvents').children[0].children[1].textContent, reason);
    b.dispose();
});

test('the console refuses to run on the customer client', async () => {
    // A valid customer session must never reach staff data, and the console must
    // not quietly keep working off whichever client happens to be loaded.
    const b = await setup({ staffClient: false }); await b.ready;
    assert.equal(b.el('adminWorkspace').hidden, true);
    assert.equal(b.el('adminMfa').hidden, true);
    assert.equal(b.el('adminIdentity').textContent, '');
    assert.equal(b.calls.length, 0);
    assert.match(b.el('adminStatus').textContent, /Staff sign-in is unavailable/);
    assert.equal(b.el('adminSignIn').hidden, false);
    b.dispose();
});

test('staff and customer authentication clients never share a page', () => {
    const pages = fs.readdirSync('pages').filter((name) => name.endsWith('.html'));
    const loadsCustomerClient = (html) => html.includes('assets/js/auth.js');
    const loadsStaffClient = (html) => html.includes('assets/js/staff-auth.js');

    for (const page of pages) {
        const html = fs.readFileSync(`pages/${page}`, 'utf8');
        assert.ok(
            !(loadsCustomerClient(html) && loadsStaffClient(html)),
            `${page} loads both authentication clients; the sessions would share a page`
        );
    }

    const admin = fs.readFileSync('pages/admin.html', 'utf8');
    assert.ok(loadsStaffClient(admin), 'the console must bind the isolated staff client');
    assert.ok(!loadsCustomerClient(admin), 'the console must not load the customer client');
    assert.match(admin, /staff-login\.html\?redirect=admin\.html/, 'the console must send staff to the staff sign-in page');

    const staffLogin = fs.readFileSync('pages/staff-login.html', 'utf8');
    assert.ok(loadsStaffClient(staffLogin), 'the staff sign-in page must use the staff client');
    assert.ok(!loadsCustomerClient(staffLogin), 'the staff sign-in page must not use the customer client');
});

/* ---------- Operations console (admin.html + admin-operations.js) ---------- */

const adminScripts = ['assets/js/admin.js', 'assets/js/admin-operations.js', 'assets/js/support-workspace.js', 'assets/js/support-ui.js'];

// Replays every migration in order and returns the public functions that exist at the end.
function deployedFunctions() {
    const functions = new Set();
    for (const file of fs.readdirSync('supabase/migrations').filter((name) => name.endsWith('.sql')).sort()) {
        const sql = fs.readFileSync(`supabase/migrations/${file}`, 'utf8');
        const statements = [
            ...[...sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+public\.(\w+)/gi)].map((match) => ({ at: match.index, add: match[1] })),
            ...[...sql.matchAll(/drop\s+function\s+(?:if\s+exists\s+)?public\.(\w+)/gi)].map((match) => ({ at: match.index, remove: match[1] })),
            ...[...sql.matchAll(/alter\s+function\s+public\.(\w+)\s*\([^)]*\)\s*rename\s+to\s+(\w+)/gi)].map((match) => ({ at: match.index, remove: match[1], add: match[2] })),
        ].sort((a, b) => a.at - b.at);
        for (const statement of statements) {
            if (statement.remove) functions.delete(statement.remove);
            if (statement.add) functions.add(statement.add);
        }
    }
    return functions;
}

test('the console calls only RPCs that exist after the last migration, and none that Phase 1 dropped', () => {
    const deployed = deployedFunctions();
    const called = new Set(adminScripts.flatMap((file) => [...fs.readFileSync(file, 'utf8').matchAll(/\b(?:rpc|call)\(\s*'([a-z_]+)'/g)].map((match) => match[1])));
    assert.ok(called.size > 10);
    for (const name of called) assert.ok(deployed.has(name), `the console calls ${name}, which no migration leaves in place`);
    const dropped = ['list_admin_demo_orders', 'get_admin_demo_order_detail', 'set_symbol_trading_status', 'list_admin_market_health'];
    for (const name of dropped) assert.equal(deployed.has(name), false, `${name} should be dropped`);
    for (const root of ['assets/js', 'pages']) {
        for (const file of fs.readdirSync(root)) {
            const source = fs.readFileSync(`${root}/${file}`, 'utf8');
            for (const name of dropped) assert.ok(!source.includes(name), `${root}/${file} still references ${name}`);
        }
    }
    for (const file of [...adminScripts, 'pages/admin.html']) assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /\b(?:window\.)?(?:alert|prompt)\(/, `${file} uses alert() or prompt()`);
});

let roleCapabilities;
async function capabilitiesFor(role) {
    if (!roleCapabilities) {
        const db = await createTestDatabase();
        try {
            // The shared test database stops before the funding migrations; apply the
            // capability registry exactly as the latest migration defines it (20261003100000: notifications.send, announcements.manage).
            const source = fs.readFileSync('supabase/migrations/20261003100000_notifications.sql', 'utf8');
            const registry = source.match(/create or replace function admin_private\.role_capabilities\(p_role text\)[\s\S]*?\n\$\$;/);
            assert.ok(registry, 'the notifications migration defines the capability registry');
            await db.query(registry[0]);
            roleCapabilities = {};
            for (const name of ['support_agent', 'administrator', 'owner']) roleCapabilities[name] = (await db.query('select admin_private.role_capabilities($1) caps', [name])).rows[0].caps;
        } finally { await db.close(); }
    }
    return roleCapabilities[role];
}

const openContract = { id: '11111111-1111-4111-8111-111111111111', trading_account_id: '22222222-2222-4222-8222-222222222222', execution_mode: 'DEMO', index_code: 'SPI10', contract_type: 'EVEN', barrier: null, stake: 10, payout: 19.3, payout_multiplier: 1.93, win_digits: 5, policy_version: 1, entry_tick_no: 40, settle_tick_no: 44, state: 'OPEN', exit_digit: null, settlement_attempts: 0, last_error: null, created_at: '2026-09-23T10:00:00Z', settled_at: null };
const consoleData = {
    get_platform_overview: { open_tickets: 3, unassigned_tickets: 1, waiting_tickets: 0, total_customers: 12, active_restrictions: 2, active_staff: 4, contracts_today: { DEMO: 7, REAL: 0 }, engine_health: 'healthy', timestamp: '2026-09-23T10:00:00Z' },
    list_admin_customers: [{ id: '33333333-3333-4333-8333-333333333333', email: 'customer@example.test', display_name: 'Customer', email_verified: true, tickets_count: 0, active_restrictions_count: 4 }],
    get_admin_customer_detail: {
        user_id: '33333333-3333-4333-8333-333333333333', email: 'customer@example.test', display_name: 'Customer', lifecycle_status: 'ACTIVE', created_at: '2026-09-01T00:00:00Z', email_verified: true, currency: 'USD',
        accounts: [{ id: '22222222-2222-4222-8222-222222222222', execution_mode: 'DEMO', status: 'ACTIVE', balances: { AVAILABLE: 9990, RESERVED: 10 }, open_contracts: 1 }],
        restrictions: [
            { id: 'r-notice', restriction_type: 'TRADING', scope: 'DEMO', severity: 'NOTICE', params: {}, active: true, expired: false, reason: 'Notice', applied_at: '2026-09-20T00:00:00Z' },
            { id: 'r-limit', restriction_type: 'TRADING', scope: 'REAL', severity: 'LIMITED', params: { max_stake: 5 }, active: true, expired: false, reason: 'Limit', applied_at: '2026-09-20T00:00:00Z' },
            { id: 'r-block', restriction_type: 'TRADING', scope: 'DEMO', severity: 'BLOCKED', params: {}, active: true, expired: false, reason: 'Block', applied_at: '2026-09-20T00:00:00Z' },
            { id: 'r-severe', restriction_type: 'ACCESS', scope: 'ALL', severity: 'BLOCKED', params: {}, active: true, expired: false, reason: 'Severe', applied_at: '2026-09-20T00:00:00Z' },
            { id: 'r-lifted', restriction_type: 'TRADING', scope: 'DEMO', severity: 'NOTICE', params: {}, active: false, expired: false, reason: 'Old', applied_at: '2026-09-01T00:00:00Z', lifted_reason: 'Resolved' },
        ],
        recent_tickets: [],
    },
    list_admin_contracts: [openContract],
    get_admin_contract_detail: { contract: openContract, customer: { user_id: '33333333-3333-4333-8333-333333333333', email: 'customer@example.test' }, entry_tick: { tick_no: 40, digit: 3, price: '1000.123', scheduled_at: '2026-09-23T10:00:00Z' }, settle_tick: null, events: [], ledger_transactions: [{ id: 'tx-buy', idempotency_key: `buy-${openContract.id}`, description: 'Buy', created_at: '2026-09-23T10:00:00Z' }] },
    get_admin_engine_health: [{ index_code: 'SPI10', execution_mode: 'DEMO', last_tick_no: 50, lag_seconds: 1.2, missing_ticks_last_hour: 0, stuck_contracts: 1, retry_contracts: 0, chi_square: 8.1, longest_run: 3, status: 'healthy' }],
    list_admin_engine_indices: [{ code: 'SPI10', execution_mode: 'DEMO', display_name: 'SP Index 10', status: 'ACTIVE' }],
    list_admin_engine_policies: [{ version: 1, effective_from: '2026-09-20T00:00:00Z', house_margin: 0.035, margin_overrides: {}, min_ticks: 1, max_ticks: 10, max_settlement_delay_seconds: 30, max_feed_lag_seconds: 10, min_profit_ratio: 0.01, tick_retention_days: 30, enabled_contract_types: ['EVEN', 'ODD'], reason: 'Initial digit-index policy', limits: { DEMO: { min_stake: 1, max_stake: 1000, max_open_contracts: 20, max_buys_per_minute: 30, max_liability_per_tick: 100000 } } }],
    get_admin_engine_exposure: [],
    list_admin_engine_epochs: [{ id: 'e1', execution_mode: 'DEMO', starts_at: '2026-09-23T00:00:00Z', ends_at: '2026-09-24T00:00:00Z', seed_commitment: 'ab'.repeat(32), chain_hash: 'cd'.repeat(32), committed_at: '2026-09-22T00:00:00Z', revealed_at: null, reveal_status: 'active' }],
    list_admin_stuck_contracts: [{ ...openContract, last_tick_no: 50, stuck_reason: 'settle_tick_passed' }],
    list_staff_members: [],
    funding_treasury_snapshot_status: { environment: 'SANDBOX', automatic: true, latest_id: 2, latest_recorded_at: '2026-09-27T03:25:00Z', latest_automatic: true, owner_snapshot_id: 1, owner_recorded_at: '2026-09-26T03:00:00Z', owner_kes_liquid_reserve: 250000, owner_confirmation_due: '2099-10-26T03:00:00Z' },
    funding_rate_sync_status: { band_bp: 150, last: { id: 9, last_seen_at: '2026-09-28T10:15:00Z', kes_per_usd: 135, rate_date: '2026-09-28', outcome: 'PENDING_APPROVAL', detail: 'move larger than the automatic band', change_bp: 415 }, last_success_at: '2026-09-28T10:15:00Z', pending: [{ id: 9, kes_per_usd: 135, rate_date: '2026-09-28', change_bp: 415, detail: 'move larger than the automatic band' }], recent: [] },
    funding_staff_overview: { environment: 'SANDBOX', sandbox_module: true, production_module: false, rate: { version: 1, kes_per_usd: 129.62, rate_date: '2026-09-25', stale: false }, treasury: { environment: 'SANDBOX', status: 'OK', coverage_bp: 50000, kes_liquid_reserve: 250000, snapshot_at: '2026-09-26T03:00:00Z' }, states: {}, attention: [], open_actions: [], last_reconciliation: null },
};

async function openConsole(role, responses = {}) {
    const capabilities = await capabilitiesFor(role);
    const dom = new JSDOM(fs.readFileSync('pages/admin.html', 'utf8'), { runScripts: 'outside-only', url: 'https://example.test/pages/admin.html' });
    Object.defineProperty(dom.window, 'crypto', { value: webcrypto });
    const calls = [];
    const client = { rpc: async (name, args) => { calls.push({ name, args: JSON.parse(JSON.stringify(args ?? null)) }); return name in responses ? responses[name] : { data: consoleData[name] ?? null, error: null }; } };
    dom.window.eval(fs.readFileSync('assets/js/admin-operations.js', 'utf8'));
    dom.window.adminOperations.init(client, { user_id: 'staff', role, capabilities });
    const document = dom.window.document;
    return {
        dom, document, calls, capabilities,
        visible: (id) => !document.getElementById(id).hidden,
        click: (element) => element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })),
        options: (id) => [...document.getElementById(id).options].map((option) => option.value),
        async until(predicate) { const started = Date.now(); while (!predicate()) { if (Date.now() - started > 2000) assert.fail('console did not reach the expected state'); await tick(); } },
    };
}

test('each role sees exactly the console tabs its capabilities allow', async () => {
    const expected = {
        support_agent: { tabOverview: false, tabCustomers: false, tabContracts: false, tabEngine: false, tabFunding: false, tabNotifications: false, tabStaff: false, tabAudit: false },
        administrator: { tabOverview: true, tabCustomers: true, tabContracts: true, tabEngine: true, tabFunding: true, tabNotifications: true, tabStaff: false, tabAudit: false },
        owner: { tabOverview: true, tabCustomers: true, tabContracts: true, tabEngine: true, tabFunding: true, tabNotifications: true, tabStaff: true, tabAudit: true },
    };
    for (const [role, tabs] of Object.entries(expected)) {
        const page = await openConsole(role);
        try {
            assert.deepEqual(Object.fromEntries(Object.keys(tabs).map((id) => [id, page.visible(id)])), tabs, role);
            assert.equal(page.document.getElementById('tabTrading'), null);
            assert.equal(page.document.getElementById('tabMarkets'), null);
            page.dom.window.adminOperations.switchTab('enginePanel');
            assert.equal(page.visible('enginePanel'), tabs.tabEngine, `${role} engine panel`);
            assert.equal(page.calls.some((call) => call.name === 'get_admin_engine_health'), tabs.tabEngine, `${role} engine reads`);
            if (tabs.tabEngine) await page.until(() => !page.document.getElementById('enginePanel').textContent.includes('Loading…'));
        } finally { page.dom.window.close(); }
    }
});

test('the overview reports engine health and contracts today split by account type', async () => {
    const page = await openConsole('administrator');
    try {
        page.click(page.document.getElementById('tabOverview'));
        await page.until(() => page.document.getElementById('overviewCards').children.length);
        const text = page.document.getElementById('overviewCards').textContent;
        assert.match(text, /Contracts today7Practice 7 · Real 0/);
        assert.match(text, /EngineHEALTHY/);
        assert.doesNotMatch(text, /Market Feed|orders/i);
    } finally { page.dom.window.close(); }
});

test('contracts can be filtered by account type, account, index, state and date, and only an Owner sees void', async () => {
    for (const role of ['administrator', 'owner']) {
        const page = await openConsole(role);
        try {
            const { document } = page;
            page.click(document.getElementById('tabContracts'));
            document.getElementById('contractModeFilter').value = 'DEMO';
            document.getElementById('contractAccountFilter').value = openContract.trading_account_id;
            document.getElementById('contractIndexFilter').value = 'SPI10';
            document.getElementById('contractStateFilter').value = 'OPEN';
            document.getElementById('contractFromFilter').value = '2026-09-20';
            document.getElementById('contractToFilter').value = '2026-09-23';
            document.getElementById('contractFilterForm').dispatchEvent(new page.dom.window.Event('submit', { cancelable: true }));
            await page.until(() => page.calls.filter((call) => call.name === 'list_admin_contracts').length === 2 && document.querySelector('#contractsTableBody .btn-inspect'));
            assert.deepEqual(page.calls.filter((call) => call.name === 'list_admin_contracts').at(-1).args, { p_mode: 'DEMO', p_state: 'OPEN', p_limit: 200, p_account_id: openContract.trading_account_id, p_index: 'SPI10', p_from: '2026-09-20T00:00:00Z', p_to: '2026-09-24T00:00:00.000Z' });
            page.click(document.querySelector('#contractsTableBody .btn-inspect'));
            await page.until(() => /Policy version/.test(document.getElementById('contractDetailContent').textContent));
            const detail = document.getElementById('contractDetailContent').textContent;
            assert.match(detail, /#40: digit 3/);
            assert.match(detail, new RegExp(`buy-${openContract.id}`));
            assert.equal(page.visible('contractVoidForm'), role === 'owner', `${role} void form`);

            page.click(document.getElementById('tabEngine'));
            await page.until(() => document.querySelector('#engineStuckBody td') && document.querySelector('#engineHealthBody .btn-market-toggle'));
            assert.equal(Boolean(document.querySelector('#engineStuckBody .btn-lift')), role === 'owner', `${role} stuck void button`);
            assert.equal(page.visible('policyPublishForm'), true);
        } finally { page.dom.window.close(); }
    }
});

test('a void needs a ten-character reason, then asks for a fresh authenticator code when the server requires it', async () => {
    const page = await openConsole('owner', { void_contract: { data: null, error: { message: 'reauthentication_required' } } });
    try {
        const { document } = page;
        page.click(document.getElementById('tabEngine'));
        await page.until(() => document.querySelector('#engineStuckBody .btn-lift'));
        page.click(document.querySelector('#engineStuckBody .btn-lift'));
        const submit = () => document.getElementById('engineVoidForm').dispatchEvent(new page.dom.window.Event('submit', { cancelable: true }));
        document.getElementById('engineVoidReason').value = 'too short';
        submit();
        assert.match(document.getElementById('engineVoidStatus').textContent, /at least 10 characters/);
        assert.equal(page.calls.some((call) => call.name === 'void_contract'), false);
        document.getElementById('engineVoidReason').value = 'Settlement is stuck behind the published tick';
        submit();
        await page.until(() => /authenticator code/.test(document.getElementById('engineVoidStatus').textContent));
        assert.equal(document.querySelector('#engineVoidForm [data-reverify]').hidden, false);
        assert.deepEqual(page.calls.find((call) => call.name === 'void_contract').args, { p_contract_id: openContract.id, p_reason: 'Settlement is stuck behind the published tick' });
    } finally { page.dom.window.close(); }
});

test('the restriction form offers only the choices each role may apply', async () => {
    const choices = async (role, severity, type) => {
        const page = await openConsole(role);
        try {
            const operations = page.dom.window.adminOperations;
            operations.renderRestrictionChoices();
            const result = { hidden: !page.visible('applyRestrictionForm'), severities: page.options('restrictionSeverity') };
            if (severity) { page.document.getElementById('restrictionSeverity').value = severity; operations.renderRestrictionChoices(); result.types = page.options('restrictionType'); }
            if (type) { page.document.getElementById('restrictionType').value = type; operations.renderRestrictionChoices(); }
            result.scopes = page.options('restrictionScope');
            result.params = [...page.document.querySelectorAll('[data-param]')].filter((input) => !input.closest('label').hidden).map((input) => input.dataset.param);
            return result;
        } finally { page.dom.window.close(); }
    };
    assert.deepEqual(await choices('support_agent', 'NOTICE'), { hidden: false, severities: ['NOTICE'], types: ['TRADING', 'WITHDRAWAL', 'DEPOSIT', 'ACCESS'], scopes: ['DEMO', 'REAL', 'ALL'], params: [] });
    assert.deepEqual(await choices('administrator', 'BLOCKED'), { hidden: false, severities: ['NOTICE', 'LIMITED', 'BLOCKED'], types: ['TRADING'], scopes: ['DEMO'], params: [] });
    assert.deepEqual(await choices('administrator', 'LIMITED', 'TRADING'), { hidden: false, severities: ['NOTICE', 'LIMITED', 'BLOCKED'], types: ['TRADING', 'WITHDRAWAL', 'DEPOSIT'], scopes: ['DEMO', 'REAL', 'ALL'], params: ['max_stake', 'max_open_contracts', 'max_daily_net_loss'] });
    assert.deepEqual(await choices('owner', 'BLOCKED', 'ACCESS'), { hidden: false, severities: ['NOTICE', 'LIMITED', 'BLOCKED'], types: ['TRADING', 'WITHDRAWAL', 'DEPOSIT', 'ACCESS'], scopes: ['DEMO', 'REAL', 'ALL'], params: [] });
});

test('restrictions list type, scope, severity and expiry, and offer lifting only where the role may lift', async () => {
    const lifts = {};
    for (const role of ['administrator', 'owner']) {
        const page = await openConsole(role);
        try {
            const { document } = page;
            page.click(document.getElementById('tabCustomers'));
            await page.until(() => document.querySelector('#customersTableBody .btn-inspect'));
            page.click(document.querySelector('#customersTableBody .btn-inspect'));
            await page.until(() => document.querySelectorAll('#customerRestrictionsList [data-restriction]').length === 5);
            const list = document.getElementById('customerRestrictionsList').textContent;
            assert.match(list, /ACCESS · All accounts · BLOCKED/);
            assert.match(list, /Limits: max stake 5\. Expires: never/);
            assert.match(document.getElementById('customerAccountsList').textContent, /Practice · ACTIVE · USD available 9990\.00/);
            lifts[role] = [...document.querySelectorAll('#customerRestrictionsList [data-restriction]')].filter((item) => item.querySelector('[data-lift-form]')).map((item) => item.dataset.restriction);
        } finally { page.dom.window.close(); }
    }
    assert.deepEqual(lifts, { administrator: ['r-notice', 'r-limit', 'r-block'], owner: ['r-notice', 'r-limit', 'r-block', 'r-severe'] });
});

test('lifting uses an inline reason form and reports the result in a live region', async () => {
    const page = await openConsole('owner');
    try {
        const { document } = page;
        page.click(document.getElementById('tabCustomers'));
        await page.until(() => document.querySelector('#customersTableBody .btn-inspect'));
        page.click(document.querySelector('#customersTableBody .btn-inspect'));
        await page.until(() => document.querySelector('[data-lift-form="r-severe"]'));
        const form = document.querySelector('[data-lift-form="r-severe"]');
        assert.equal(form.hidden, true);
        page.click(form.previousElementSibling);
        assert.equal(form.hidden, false);
        form.querySelector('input').value = 'Reviewed and cleared';
        form.dispatchEvent(new page.dom.window.Event('submit', { cancelable: true }));
        await page.until(() => document.getElementById('restrictionListStatus').textContent === 'Restriction lifted.');
        assert.deepEqual(page.calls.find((call) => call.name === 'lift_account_restriction').args, { p_restriction_id: 'r-severe', p_reason: 'Reviewed and cleared' });
        assert.equal(document.getElementById('restrictionListStatus').getAttribute('aria-live'), 'polite');
    } finally { page.dom.window.close(); }
});

test('an announcement is previewed, refused if it pressures customers, confirmed with its audience size, then published once', async () => {
    const live = { id: 'a-live', title: 'Maintenance tonight', body: 'Trading pauses briefly.', severity: 'important', audience: 'all', starts_at: '2026-10-03T10:00:00Z', ends_at: null, state: 'live', reads: 12 };
    const page = await openConsole('administrator', {
        staff_list_announcements: { data: [live, { ...live, id: 'a-old', title: 'Old news', state: 'withdrawn', reads: 3 }], error: null },
        staff_announcement_audience_count: { data: 1240, error: null },
        staff_publish_announcement: { data: { id: 'x', duplicate: false }, error: null },
    });
    try {
        const { document } = page;
        page.click(document.getElementById('tabNotifications'));
        await page.until(() => document.querySelector('[data-announcement="a-live"]'));
        assert.match(document.querySelector('[data-announcement="a-live"]').textContent, /Maintenance tonight.*All customers.*Live/);
        assert.ok(document.querySelector('[data-announcement="a-live"] button'), 'a live announcement cannot be withdrawn');
        assert.equal(document.querySelector('[data-announcement="a-old"] button'), null, 'a withdrawn announcement offers withdraw');

        const set = (id, value) => { const node = document.getElementById(id); node.value = value; node.dispatchEvent(new page.dom.window.Event('input')); };
        const submit = () => document.getElementById('announcementForm').dispatchEvent(new page.dom.window.Event('submit', { cancelable: true }));
        set('announcementTitle', 'Win big this weekend');
        set('announcementBody', 'New indices open on Saturday.');
        assert.equal(document.getElementById('announcementCheck').hidden, false);
        assert.match(document.getElementById('announcementCheck').textContent, /Remove "Win big"/);
        assert.match(document.getElementById('announcementPreview').textContent, /^Announcement · now · UnreadWin big this weekend/);
        set('announcementReason', 'Product update');
        submit();
        assert.match(document.getElementById('announcementStatus').textContent, /must not promise profit or create urgency/);
        assert.equal(page.calls.some((call) => call.name === 'staff_announcement_audience_count'), false);

        set('announcementTitle', 'New indices on Saturday');
        set('announcementLink', 'https://elsewhere.example');
        submit();
        assert.match(document.getElementById('announcementStatus').textContent, /page on this site/);
        set('announcementLink', 'faq.html');
        document.getElementById('announcementSeverity').value = 'important';
        submit();
        await page.until(() => page.visible('announcementConfirm'));
        assert.equal(document.getElementById('announcementConfirmText').textContent, 'Show "New indices on Saturday" to 1240 customers now?');
        assert.equal(page.visible('announcementReview'), false);
        page.click(document.getElementById('announcementConfirmSend'));
        await page.until(() => document.getElementById('announcementStatus').textContent === 'Announcement published.');
        const published = page.calls.filter((call) => call.name === 'staff_publish_announcement');
        assert.equal(published.length, 1);
        assert.deepEqual({ ...published[0].args, p_request_id: typeof published[0].args.p_request_id }, { p_title: 'New indices on Saturday', p_body: 'New indices open on Saturday.', p_link: 'faq.html', p_severity: 'important', p_audience: 'all', p_starts_at: null, p_ends_at: null, p_reason: 'Product update', p_request_id: 'string' });
        assert.equal(document.getElementById('announcementTitle').value, '', 'the form was not cleared');
        assert.equal(page.visible('announcementConfirm'), false);
    } finally { page.dom.window.close(); }
});

test('an administrator can message one customer from the inspector; a support agent never sees the form', async () => {
    const page = await openConsole('administrator', { staff_send_notification: { data: { id: 'n-1', duplicate: false }, error: null } });
    try {
        const { document } = page;
        page.click(document.getElementById('tabCustomers'));
        await page.until(() => document.querySelector('#customersTableBody .btn-inspect'));
        page.click(document.querySelector('#customersTableBody .btn-inspect'));
        await page.until(() => page.visible('customerMessageForm'));
        document.getElementById('customerMessageTitle').value = 'About your deposit';
        document.getElementById('customerMessageBody').value = 'We have checked your M-Pesa receipt.';
        document.getElementById('customerMessageReason').value = 'Customer asked by phone';
        document.getElementById('customerMessageForm').dispatchEvent(new page.dom.window.Event('submit', { cancelable: true }));
        await page.until(() => /^Message sent/.test(document.getElementById('customerMessageStatus').textContent));
        const sent = page.calls.find((call) => call.name === 'staff_send_notification').args;
        assert.deepEqual({ ...sent, p_request_id: typeof sent.p_request_id }, { p_user_id: consoleData.get_admin_customer_detail.user_id, p_title: 'About your deposit', p_body: 'We have checked your M-Pesa receipt.', p_link: null, p_ticket_id: null, p_reason: 'Customer asked by phone', p_request_id: 'string' });
        assert.equal(document.getElementById('customerMessageTitle').value, '');
    } finally { page.dom.window.close(); }
    const agent = await openConsole('support_agent');
    try { assert.equal(agent.visible('customerMessageForm'), false); } finally { agent.dom.window.close(); }
});

test('the Funding tab shows the current rate and treasury; only an owner publishes a rate, with a typo guard and a fresh authenticator code', async () => {
    const admin = await openConsole('administrator');
    try {
        admin.dom.window.adminOperations.switchTab('fundingPanel');
        await admin.until(() => admin.document.getElementById('fundingRateValue').textContent !== '—');
        assert.equal(admin.document.getElementById('fundingRateValue').textContent, 'KES 129.6200');
        assert.match(admin.document.getElementById('fundingRateMeta').textContent, /Version 1, dated 2026-09-25\. Fresh\./);
        assert.match(admin.document.getElementById('fundingTreasuryValue').textContent, /^OK · 500\.00%$/);
        await admin.until(() => admin.document.getElementById('fundingTreasuryChain').textContent !== '');
        assert.match(admin.document.getElementById('fundingTreasuryChain').textContent, /^Latest snapshot was carried forward automatically from the owner figure of KES 250,000 .*Automatic refresh continues until .*record a new figure before then.$/);
        assert.equal(admin.visible('fundingRateForm'), false, 'an administrator only reads');
        assert.equal(admin.visible('fundingTreasuryForm'), false);
    } finally { admin.dom.window.close(); }

    let publishAttempts = 0;
    const page = await openConsole('owner', {
        funding_publish_rate: (() => ({ then(resolve) { publishAttempts += 1; resolve(publishAttempts === 1 ? { data: null, error: { message: 'reauthentication_required' } } : { data: { version: 2, kes_per_usd: 135.5, rate_date: '2026-09-26' }, error: null }); } }))(),
    });
    try {
        const { document } = page;
        page.click(document.getElementById('tabFunding'));
        await page.until(() => document.getElementById('fundingRateValue').textContent === 'KES 129.6200');
        assert.equal(page.visible('fundingRateForm'), true);
        const submit = () => document.getElementById('fundingRateForm').dispatchEvent(new page.dom.window.Event('submit', { cancelable: true }));
        const publishCalls = () => page.calls.filter((call) => call.name === 'funding_publish_rate');
        document.getElementById('fundingRateInput').value = '1296.2';
        document.getElementById('fundingRateDate').value = '2026-09-26';
        document.getElementById('fundingRateReason').value = 'CBK mean for 26 September';
        submit();
        assert.match(document.getElementById('fundingRateStatus').textContent, /between 50 and 500/);
        document.getElementById('fundingRateInput').value = '135.5';
        submit();
        assert.match(document.getElementById('fundingRateCheck').textContent, /differs from the current KES 129\.6200 by 4\.5%/);
        assert.equal(publishCalls().length, 0, 'a large move needs a second submit');
        submit();
        await page.until(() => /authenticator code/.test(document.getElementById('fundingRateStatus').textContent));
        assert.equal(document.querySelector('#fundingRateForm [data-reverify]').hidden, false);
        assert.deepEqual(publishCalls()[0].args, { p_kes_per_usd: 135.5, p_rate_date: '2026-09-26', p_source_reference: 'https://www.centralbank.go.ke/rates/forex-exchange-rates/', p_reason: 'CBK mean for 26 September' });
    } finally { page.dom.window.close(); }
});

test('the treasury snapshot form validates, then records the reserve for the chosen environment', async () => {
    const page = await openConsole('owner', { funding_record_treasury_snapshot: { data: { status: 'OK' }, error: null } });
    try {
        const { document } = page;
        page.click(document.getElementById('tabFunding'));
        await page.until(() => document.getElementById('fundingTreasuryValue').textContent !== '—');
        const submit = () => document.getElementById('fundingTreasuryForm').dispatchEvent(new page.dom.window.Event('submit', { cancelable: true }));
        document.getElementById('fundingTreasuryInput').value = '250000';
        document.getElementById('fundingTreasuryNote').value = 'short';
        submit();
        assert.match(document.getElementById('fundingTreasuryStatus').textContent, /at least 10 characters/);
        document.getElementById('fundingTreasuryNote').value = 'Sandbox test float, not real cash';
        submit();
        await page.until(() => /Snapshot recorded/.test(document.getElementById('fundingTreasuryStatus').textContent));
        assert.deepEqual(page.calls.find((call) => call.name === 'funding_record_treasury_snapshot').args, { p_environment: 'SANDBOX', p_kes_liquid_reserve: 250000, p_note: 'Sandbox test float, not real cash' });
    } finally { page.dom.window.close(); }
});

test('the automatic CBK import shows its last check; a held rate is approved by an owner with a reason and a fresh code', async () => {
    const admin = await openConsole('administrator');
    try {
        admin.dom.window.adminOperations.switchTab('fundingPanel');
        await admin.until(() => admin.document.querySelectorAll('#fundingPendingBody tr').length === 1);
        assert.match(admin.document.getElementById('fundingSyncMeta').textContent, /held for approval \(KES 135\.0000 posted 2026-09-28\)\. New CBK rates within 1\.5% of the current rate publish automatically/);
        assert.equal(admin.document.querySelectorAll('#fundingPendingBody button').length, 0, 'an administrator cannot decide');
    } finally { admin.dom.window.close(); }

    let attempts = 0;
    const page = await openConsole('owner', {
        funding_decide_rate_observation: (() => ({ then(resolve) { attempts += 1; resolve(attempts === 1 ? { data: null, error: { message: 'reauthentication_required' } } : { data: { observation_id: 9, outcome: 'APPROVED', version: 3 }, error: null }); } }))(),
    });
    try {
        const { document } = page;
        page.dom.window.adminOperations.switchTab('fundingPanel');
        await page.until(() => document.querySelectorAll('#fundingPendingBody button').length === 2);
        const row = document.querySelector('#fundingPendingBody tr').textContent;
        assert.match(row, /2026-09-28.*KES 135\.0000.*4\.15%.*move larger than the automatic band/s);
        page.click([...document.querySelectorAll('#fundingPendingBody button')].find((button) => button.textContent === 'Approve'));
        assert.equal(page.visible('fundingDecisionForm'), true);
        assert.equal(document.getElementById('fundingDecisionSummary').textContent, 'Publish KES 135.0000 per USD posted 2026-09-28.');
        const submit = () => document.getElementById('fundingDecisionForm').dispatchEvent(new page.dom.window.Event('submit', { cancelable: true }));
        document.getElementById('fundingDecisionReason').value = 'short';
        submit();
        assert.match(document.getElementById('fundingDecisionStatus').textContent, /at least 10 characters/);
        document.getElementById('fundingDecisionReason').value = 'Checked against the CBK site';
        submit();
        await page.until(() => /authenticator code/.test(document.getElementById('fundingDecisionStatus').textContent));
        assert.equal(document.querySelector('#fundingDecisionForm [data-reverify]').hidden, false);
        assert.deepEqual(page.calls.find((call) => call.name === 'funding_decide_rate_observation').args, { p_observation: 9, p_approve: true, p_reason: 'Checked against the CBK site' });
    } finally { page.dom.window.close(); }
});
