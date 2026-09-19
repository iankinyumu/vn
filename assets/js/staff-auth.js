/* assets/js/staff-auth.js - the staff-only Supabase client.
 *
 * Staff and customers sign in through deliberately separate clients that persist
 * their sessions under different storage keys. supabase-js stores a session
 * under the key given here, so a customer token lives at the default
 * sb-<project-ref>-auth-token while a staff token lives at STAFF_STORAGE_KEY.
 *
 * Consequences that are real and worth stating plainly:
 *   - Code running on a customer page cannot read the staff token, because it
 *     never names that key.
 *   - A staff session is never silently reused as a customer session, and a
 *     customer session never satisfies the staff console.
 *   - An XSS bug on a customer page can steal the customer token; it cannot
 *     promote that token into staff authority.
 *
 * What this is NOT: a separate identity store. Both clients authenticate against
 * the same Supabase project, and staff authority is decided server-side by
 * get_staff_context on every request. A leaked service-role key still reaches
 * everything this isolates.
 */
(function () {
    'use strict';

    var STAFF_STORAGE_KEY = 'smartprofit:staff-auth:v1';
    var SUPABASE_JS_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js';
    var authScriptUrl = document.currentScript && document.currentScript.src;
    var clientPromise;

    function loadScript(url) {
        return new Promise(function (resolve, reject) {
            var existing = Array.from(document.scripts).find(function (script) { return script.src === url; });
            if (existing) {
                if (window.supabase || window.SMARTPROFIT_SUPABASE_CONFIG) resolve();
                else existing.addEventListener('load', resolve, { once: true });
                return;
            }
            var script = document.createElement('script');
            script.src = url;
            script.onload = resolve;
            script.onerror = function () { reject(new Error('Unable to load an authentication dependency.')); };
            document.head.appendChild(script);
        });
    }

    async function getStaffSupabaseClient() {
        if (!clientPromise) {
            clientPromise = (async function () {
                var assetBase = new URL('.', authScriptUrl || window.location.href);
                await loadScript(new URL('supabase-config.js', assetBase).href);
                await loadScript(SUPABASE_JS_URL);
                var config = window.SMARTPROFIT_SUPABASE_CONFIG;
                if (!config || !config.url || !config.publishableKey) throw new Error('Supabase browser configuration is missing.');
                return window.supabase.createClient(config.url, config.publishableKey, {
                    auth: {
                        storageKey: STAFF_STORAGE_KEY,
                        persistSession: true,
                        autoRefreshToken: true,
                        // Staff sessions are established by password only. Nothing in
                        // a URL fragment is allowed to mint console access.
                        detectSessionInUrl: false
                    }
                });
            })();
        }
        return clientPromise;
    }

    async function getStaffSession() {
        var client = await getStaffSupabaseClient();
        var result = await client.auth.getSession();
        if (result.error) throw result.error;
        return result.data.session;
    }

    /* Returns the staff context for the stored session.
     * Throws 'unauthenticated' with no session and 'forbidden' for a signed-in
     * account that holds no staff role. MFA-pending staff return a context whose
     * required_step is 'mfa'; they are staff, they just have not finished yet. */
    async function requireStaffContext() {
        var client = await getStaffSupabaseClient();
        var result = await client.auth.getSession();
        if (result.error) throw result.error;
        if (!result.data.session) throw new Error('unauthenticated');
        var context = await client.rpc('get_staff_context');
        if (context.error) throw context.error;
        if (!context.data || !context.data.role) throw new Error('forbidden');
        return context.data;
    }

    window.staffSignOut = async function staffSignOut() {
        try { await (await getStaffSupabaseClient()).auth.signOut(); }
        catch (_) { /* The caller is navigating away regardless. */ }
    };

    window.redirectIfStaffAuthenticated = async function redirectIfStaffAuthenticated() {
        try {
            var context = await requireStaffContext();
            if (context && context.role) window.location.replace('admin.html');
        } catch (_) { /* Keep the form available; a failed check is not proof of access. */ }
    };

    window.STAFF_AUTH_STORAGE_KEY = STAFF_STORAGE_KEY;
    window.getStaffSupabaseClient = getStaffSupabaseClient;
    window.getStaffSession = getStaffSession;
    window.requireStaffContext = requireStaffContext;
})();
