import test from 'node:test';
import assert from 'node:assert/strict';
import { startSandbox } from '../sandbox/server.mjs';

test('sandbox HTTP boundary is local, synthetic and protected by the real SQL permissions', { timeout: 45000 }, async () => {
    const server = await startSandbox({ port: 0 });
    let cookie = '';
    const post = async (route, payload = {}) => {
        const response = await fetch(`${server.url}/sandbox-api/${route}`, { signal: AbortSignal.timeout(5000), method: 'POST', headers: { Origin: server.url, 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(payload) });
        if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
        return response.json();
    };
    try {
        for (const route of ['/.env.local', '/assets/js/supabase-config.js', '/supabase/README.md']) assert.equal((await fetch(server.url + route)).status, 404);
        const auth = await (await fetch(server.url + '/assets/js/auth.js')).text();
        assert.match(auth, /SYNTHETIC|synthetic/);
        assert.doesNotMatch(auth, /supabase\.co|cdn\.jsdelivr/);
        assert.equal((await fetch(server.url + '/sandbox-api/signin', { method: 'POST' })).status, 403);
        await post('signin', { identity: 'owner' });
        let ctx = await post('rpc', { name: 'get_staff_context' });
        assert.equal(ctx.data.required_step, 'mfa');
        assert.equal((await post('rpc', { name: 'list_admin_audit' })).error.message, 'mfa_required');
        assert.equal((await post('verify', { code: '000000', factorId: 'sandbox-factor' })).error.message, 'validation_failed');
        await post('verify', { code: '123456', factorId: 'sandbox-factor' });
        ctx = await post('rpc', { name: 'get_staff_context' });
        assert.ok(ctx.data.capabilities.includes('staff.enter'));
        assert.ok((await post('rpc', { name: 'list_admin_audit' })).data.length > 0);
        await post('signin', { identity: 'customer' });
        assert.equal((await post('rpc', { name: 'get_staff_context' })).error.message, 'forbidden');
        assert.equal((await post('rpc', { name: 'raw_sql', payload: { sql: 'select 1' } })).error.message, 'not_found');
        await post('signout');
        assert.equal((await post('rpc', { name: 'get_staff_context' })).error.message, 'unauthenticated');
    } finally { await server.close(); }
});
