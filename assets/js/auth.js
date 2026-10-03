/* Authoritative Supabase Auth client for the static frontend. */
(function () {
    const authScriptUrl = document.currentScript && document.currentScript.src;
    let clientPromise;

    // "Remember me" only changes which Web Storage holds the session key. Both
    // storages survive same-tab navigation and reloads, so the visitor stays signed
    // in for the visit either way; localStorage additionally survives closing the
    // browser, sessionStorage does not.
    let preferredStorage = null; // 'local' | 'session' | null (infer from stored session)
    const authStorage = {
        getItem(key) {
            if (preferredStorage === 'local') return window.localStorage.getItem(key);
            if (preferredStorage === 'session') return window.sessionStorage.getItem(key);
            const sessionValue = window.sessionStorage.getItem(key);
            return sessionValue !== null ? sessionValue : window.localStorage.getItem(key);
        },
        setItem(key, value) {
            const target = preferredStorage === null && window.sessionStorage.getItem(key) !== null
                ? 'session'
                : preferredStorage;
            (target === 'session' ? window.sessionStorage : window.localStorage).setItem(key, value);
        },
        removeItem(key) {
            window.sessionStorage.removeItem(key);
            window.localStorage.removeItem(key);
        }
    };

    // supabase-js is pinned to one release and checked with Subresource Integrity, so a new or
    // tampered upload on the CDN cannot run with access to sessions. To upgrade, change both
    // values together (staff-auth.js has the same pair). Browser tests serve a fake client and set
    // window.SMARTPROFIT_TEST_CDN before any page script runs, which skips the hash check.
    const SUPABASE_JS_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/dist/umd/supabase.js';
    const SUPABASE_JS_SRI = 'sha384-Rj26LVGvoeRVR6+mwQmFfcR3QOBEwT+ZmuCWpuiqeTzJpCs0ER4ITAWGb4Hiy3Ok';

    function loadScript(url, integrity) {
        return new Promise((resolve, reject) => {
            const existing = Array.from(document.scripts).find((script) => script.src === url);
            if (existing) {
                if (window.supabase || window.SMARTPROFIT_SUPABASE_CONFIG) resolve();
                else existing.addEventListener('load', resolve, { once: true });
                return;
            }
            const script = document.createElement('script');
            if (integrity && !window.SMARTPROFIT_TEST_CDN) { script.integrity = integrity; script.crossOrigin = 'anonymous'; }
            script.src = url;
            script.onload = resolve;
            script.onerror = () => reject(new Error('Unable to load an authentication dependency.'));
            document.head.appendChild(script);
        });
    }

    // `options.rememberSession` must be read from the "Remember me" control at
    // sign-in time. When it is false the session is written to sessionStorage and is
    // discarded when the browser closes; when true (or absent) it is written to
    // localStorage. An absent option leaves the choice to whichever storage already
    // holds the session, so later page loads keep working without re-passing it.
    async function getSupabaseClient(options = {}) {
        if (typeof options.rememberSession === 'boolean') {
            preferredStorage = options.rememberSession ? 'local' : 'session';
        }
        if (!clientPromise) {
            clientPromise = (async () => {
                const assetBase = new URL('.', authScriptUrl || window.location.href);
                await loadScript(new URL('supabase-config.js', assetBase).href);
                await loadScript(SUPABASE_JS_URL, SUPABASE_JS_SRI);
                const config = window.SMARTPROFIT_SUPABASE_CONFIG;
                if (!config || !config.url || !config.publishableKey) throw new Error('Supabase browser configuration is missing.');
                return window.supabase.createClient(config.url, config.publishableKey, {
                    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storage: authStorage }
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
    /* Onboarding: the welcome answers (goal, experience, interests, where to start).
       - The gate: a signed-in customer who has not answered or skipped them is sent to
         onboarding.html from every signed-in page except that page and help. If the status cannot
         be read the page stays open; it is guidance, not a security control.
       - The answers: pages tailor themselves with window.smartProfitOnboarding.answers() (for
         example the trade page opens on a contract the customer chose). They are kept for the tab
         in essential session storage, so each page does not ask the server again. */
    const ONBOARDING_OPEN_PAGES = new Set(['onboarding.html', 'contact.html', 'faq.html', 'support.html']);
    const onboardingKey = (userId) => `smartprofit:onboarding:${userId}`;
    async function currentUserId(client) {
        const { data: { session } } = await client.auth.getSession();
        return session?.user?.id || null;
    }
    function cacheOnboarding(userId, view) {
        if (!userId || view?.status !== 'completed') return;
        try { sessionStorage.setItem(onboardingKey(userId), JSON.stringify({ status: view.status, data: view.data || {} })); } catch (_) { /* asked again next page */ }
    }
    let onboardingRead = null;
    async function readOnboarding() {
        const client = await getSupabaseClient();
        const userId = await currentUserId(client);
        if (!userId) return null;
        try { const cached = JSON.parse(sessionStorage.getItem(onboardingKey(userId))); if (cached?.status) return cached; } catch (_) { /* ask the server */ }
        onboardingRead ||= client.rpc('get_my_onboarding').then(({ data, error }) => {
            if (error || !data?.status) return null;
            cacheOnboarding(userId, data);
            return data;
        }).finally(() => { onboardingRead = null; });
        return onboardingRead;
    }
    async function onboardingFinished() {
        const view = await readOnboarding();
        return !view || view.status === 'completed';
    }
    // Called after the customer answers, skips or changes their answers (onboarding and profile pages).
    window.markOnboardingComplete = async function markOnboardingComplete(view) {
        try {
            const client = await getSupabaseClient();
            const userId = await currentUserId(client);
            if (!userId) return;
            if (view?.status) cacheOnboarding(userId, view);
            else sessionStorage.setItem(onboardingKey(userId), JSON.stringify({ status: 'completed', data: {} }));
        } catch (_) { /* The next page asks the server instead. */ }
    };
    window.smartProfitOnboarding = Object.freeze({
        // The customer's answers ({ goal, experience, interests, start_with }), or {} if unknown.
        answers: async () => { try { return (await readOnboarding())?.data || {}; } catch (_) { return {}; } }
    });

    window.requireAuth = async function requireAuth() {
        const currentPath = window.location.pathname.split('/').pop() || 'dashboard.html';
        try {
            if (!await window.isAuthenticated()) {
                window.location.replace(`login.html?redirect=${encodeURIComponent(currentPath)}`);
                return;
            }
        } catch (_) { window.location.replace('login.html?error=auth_unavailable'); return; }
        if (ONBOARDING_OPEN_PAGES.has(currentPath)) return;
        try {
            if (!await onboardingFinished()) window.location.replace('onboarding.html');
        } catch (_) { /* Status unknown: leave the page open. */ }
    };
    window.redirectIfAuthenticated = async function redirectIfAuthenticated() {
        try { if (await window.isAuthenticated()) window.location.replace('dashboard.html'); } catch (_) { /* Keep form available. */ }
    };
    window.logout = async function logout() {
        window.smartProfitCache?.clear();
        // Public pages do not load account-cache.js but must still clear its data.
        try {
            Object.keys(sessionStorage).filter((key) => key.startsWith('smartprofit:account:') || key.startsWith('smartprofit:onboarding:')).forEach((key) => sessionStorage.removeItem(key));
            // The next person to sign in on this device starts on Practice.
            localStorage.removeItem('smartprofit:account:active');
        } catch (_) { /* Storage may be disabled. */ }
        try { await (await getSupabaseClient()).auth.signOut(); }
        finally { window.location.replace('index.html'); }
    };

    // Erase the insecure session format created by earlier mock-only builds.
    localStorage.removeItem('smartprofit_user');
})();
