/* Served instead of production auth.js ONLY by sandbox/server.mjs. */
(() => {
    const listeners = new Set();
    async function request(path, payload) {
        const response = await fetch(`/sandbox-api/${path}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {})
        });
        return response.json();
    }
    async function notify() {
        const result = await request('session');
        for (const listener of listeners) listener(result.data.session ? 'SIGNED_IN' : 'SIGNED_OUT', result.data.session);
    }
    const client = {
        rpc: (name, payload) => request('rpc', { name, payload }),
        auth: {
            getSession: () => request('session'),
            onAuthStateChange(callback) { listeners.add(callback); return { data: { subscription: { unsubscribe: () => listeners.delete(callback) } } }; },
            async signOut() { const result = await request('signout'); await notify(); return result; },
            mfa: {
                listFactors: () => request('factors'),
                enroll: () => request('enroll'),
                async challengeAndVerify(payload) { const result = await request('verify', payload); if (!result.error) await notify(); return result; }
            }
        }
    };
    window.getSupabaseClient = async () => client;
    window.logout = async () => { await client.auth.signOut(); window.location.assign('/sandbox/'); };
    document.addEventListener('DOMContentLoaded', () => {
        const banner = document.createElement('aside');
        banner.className = 'sandbox-banner';
        banner.textContent = 'LOCAL SANDBOX — synthetic data only. Test MFA code: 123456. ';
        const link = document.createElement('a'); link.href = '/sandbox/'; link.textContent = 'Switch test account';
        banner.append(link); document.body.prepend(banner);
        for (const link of document.querySelectorAll('a[href*="login.html"], a[href="dashboard.html"]')) link.href = '/sandbox/';
    });
})();
