import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

async function setup({ guest = false, rpc } = {}) {
    const elements = new Map();
    const el = (id) => {
        if (!elements.has(id)) elements.set(id, { value: '', checked: true, disabled: true, hidden: true, listeners: {},
            addEventListener(event, fn) { this.listeners[event] = fn; }, focus() {}, append() {}, replaceChildren() {},
            reportValidity() { return true; }, reset() { this.resets = (this.resets || 0) + 1; } });
        return elements.get(id);
    };
    const calls = [];
    let authCallback;
    let key = 0;
    const client = {
        auth: { onAuthStateChange(fn) { authCallback = fn; }, getSession: async () => ({ data: { session: guest ? null : { user: { id: 'owner', email: 'user@example.org' } } } }) },
        from() { return { select() { return this; }, eq() { return this; }, order() { return this; }, limit: async () => ({ data: [] }) }; },
        async rpc(name, payload) { calls.push(payload); return rpc ? rpc(payload, calls.length) : { data: { id: payload.p_id, reference: 'SP-1001' } }; }
    };
    let init;
    vm.runInNewContext(fs.readFileSync('assets/js/contact.js', 'utf8'), {
        document: { getElementById: el, createElement: () => el(Symbol()), addEventListener: (_, fn) => { init = fn; } },
        window: { getSupabaseClient: async () => client }, ['cryp' + 'to']: { randomUUID: () => `request-${++key}` }, Date, setTimeout
    });
    await init();
    delete el('contactForm').resets;
    for (const [id, value] of Object.entries({ firstName: ' Ada ', lastName: ' Lovelace ', email: 'user@example.org', phone: '', message: 'Please help with my account.', subject: 'account' })) el(id).value = value;
    return { el, calls, authCallback, send: () => el('contactForm').listeners.submit({ preventDefault() {} }) };
}

test('success requires persistence and returns the server reference', async () => {
    const b = await setup(); await b.send();
    assert.equal(b.calls[0].p_first_name, 'Ada');
    assert.match(b.el('contactStatus').textContent, /Request SP-1001 received/);
    assert.equal(b.el('contactForm').resets, 1);
});
test('failed submissions preserve the form and retry the same request ID', async () => {
    const b = await setup({ rpc: async (p, n) => n === 1 ? { error: new Error('network') } : { data: { id: p.p_id, reference: 'SP-1001' } } });
    await b.send(); assert.equal(b.el('contactForm').resets, undefined);
    assert.match(b.el('contactStatus').textContent, /could not confirm/);
    await b.send(); assert.equal(b.calls[0].p_id, b.calls[1].p_id);
});
test('double submissions cannot race', async () => {
    let finish;
    const b = await setup({ rpc: (p) => new Promise(resolve => { finish = () => resolve({ data: { id: p.p_id, reference: 'SP-1001' } }); }) });
    const first = b.send(); await b.send(); assert.equal(b.calls.length, 1);
    finish(); await first;
});
test('guests cannot submit, invalid phones cannot submit', async () => {
    const guest = await setup({ guest: true }); await guest.send(); assert.equal(guest.calls.length, 0);
    assert.equal(guest.el('contactFields').disabled, true);
    const b = await setup(); b.el('phone').value = 'not a phone'; await b.send(); assert.equal(b.calls.length, 0);
});
test('rate limits and missing confirmation never display success', async () => {
    for (const response of [{ error: new Error('support_rate_limit') }, { data: null }]) {
        const b = await setup({ rpc: async () => response }); await b.send();
        assert.equal(b.el('contactStatus').className, 'alert alert-danger');
        assert.equal(b.el('contactForm').resets, undefined);
    }
});

test('signed-in account panel and navigation match the session, including sign-out', async () => {
    const b = await setup();
    assert.match(b.el('accountAccessStatus').textContent, /Signed in as user@example.org/);
    assert.equal(b.el('guestAccountHelp').hidden, true);
    assert.equal(b.el('contactLogin').hidden, true);
    assert.equal(b.el('contactLogout').hidden, false);
    b.authCallback('SIGNED_OUT', null);
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(b.el('contactFields').disabled, true);
    assert.equal(b.el('contactLogin').hidden, false);
    assert.equal(b.el('guestAccountHelp').hidden, false);
    assert.match(b.el('accountAccessStatus').textContent, /not signed in/);
});

test('guest page responds to sign-in without a reload', async () => {
    const b = await setup({ guest: true });
    b.authCallback('SIGNED_IN', { user: { id: 'new-owner', email: 'new@example.org' } });
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(b.el('contactFields').disabled, false);
    assert.equal(b.el('guestAccountHelp').hidden, true);
    assert.match(b.el('accountAccessStatus').textContent, /new@example.org/);
});
