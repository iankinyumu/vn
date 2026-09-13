/* Authoritative Supabase Auth client for the static frontend. */
(function () {
    const authScriptUrl = document.currentScript && document.currentScript.src;
    let clientPromise;

    function loadScript(url) {
        return new Promise((resolve, reject) => {
            const existing = Array.from(document.scripts).find((script) => script.src === url);
            if (existing) {
                if (window.supabase || window.SMARTPROFIT_SUPABASE_CONFIG) resolve();
                else existing.addEventListener('load', resolve, { once: true });
                return;
            }
            const script = document.createElement('script');
            script.src = url;
            script.onload = resolve;
            script.onerror = () => reject(new Error('Unable to load an authentication dependency.'));
            document.head.appendChild(script);
        });
    }

    async function getSupabaseClient() {
        if (!clientPromise) {
            clientPromise = (async () => {
                const assetBase = new URL('.', authScriptUrl || window.location.href);
                await loadScript(new URL('supabase-config.js', assetBase).href);
                await loadScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js');
                const config = window.SMARTPROFIT_SUPABASE_CONFIG;
                if (!config || !config.url || !config.publishableKey) throw new Error('Supabase browser configuration is missing.');
                return window.supabase.createClient(config.url, config.publishableKey, {
                    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
                });
            })();
        }
        return clientPromise;
    }

    async function getSession() {
        const client = await getSupabaseClient();
        const { data, error } = await client.auth.getSession();
        if (error) throw error;
        return data.session;
    }

    window.getSupabaseClient = getSupabaseClient;
    window.getAuthenticatedUser = async () => (await getSession())?.user || null;
    window.isAuthenticated = async () => Boolean(await getSession());
    window.requireAuth = async function requireAuth() {
        try {
            if (!await window.isAuthenticated()) {
                const currentPath = window.location.pathname.split('/').pop() || 'dashboard.html';
                window.location.replace(`login.html?redirect=${encodeURIComponent(currentPath)}`);
            }
        } catch (_) { window.location.replace('login.html?error=auth_unavailable'); }
    };
    window.redirectIfAuthenticated = async function redirectIfAuthenticated() {
        try { if (await window.isAuthenticated()) window.location.replace('dashboard.html'); } catch (_) { /* Keep form available. */ }
    };
    window.logout = async function logout() {
        try { await (await getSupabaseClient()).auth.signOut(); }
        finally { window.location.replace('index.html'); }
    };

    // Erase the insecure session format created by earlier mock-only builds.
    localStorage.removeItem('smartprofit_user');
})();
