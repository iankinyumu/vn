import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

const tick = () => new Promise(resolve => setTimeout(resolve, 5));
async function setup({ guest = false, rpc, requiredStep = null, role = 'owner', mfaError = null } = {}) {
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
        window: { getSupabaseClient: async () => client, addEventListener: (event, fn) => { windowListeners[event] = fn; } },
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
