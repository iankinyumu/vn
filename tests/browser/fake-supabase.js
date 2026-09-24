// Test double served IN PLACE OF the supabase-js CDN bundle during real-browser
// checks. It answers RPCs from window.__FAKE__ (set by the test before any page
// script runs) and never contacts a real backend.
(function () {
    const fake = () => window.__FAKE__ || {};
    const user = { id: '00000000-0000-4000-8000-000000000006', email: 'customer@example.test' };
    const chain = () => {
        const q = { select: () => q, eq: () => q, order: () => q, limit: () => q, in: () => q, gte: () => q, lte: () => q, range: () => q,
            maybeSingle: async () => ({ data: null, error: null }), single: async () => ({ data: null, error: null }),
            then: (resolve, reject) => Promise.resolve({ data: [], error: null }).then(resolve, reject) };
        return q;
    };
    async function rpc(name, args) {
        (window.__RPC_LOG__ ||= []).push({ name, args });
        const handler = (fake().rpc || {})[name];
        const delay = (fake().delay || {})[name] || 0;
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        if (handler === undefined) return { data: null, error: null };
        // A live 2-second tick stream: tick numbers advance with the clock.
        if (handler && handler.__liveTicks) {
            const now = Math.floor(Date.now() / 2000), origin = handler.__liveTicks.origin;
            const tick = (n) => ({ index_code: args.p_index, tick_no: origin + n, scheduled_at: new Date(n * 2000).toISOString(), price: (10000 + (n % 50) / 10).toFixed(3), digit: n % 10 });
            const latest = now;
            if (name === 'get_ticks_since') {
                const after = Number(args.p_after_tick_no) - origin;
                return { data: Array.from({ length: Math.max(0, Math.min(latest - after, 500)) }, (_, i) => tick(after + 1 + i)), error: null };
            }
            return { data: Array.from({ length: Math.min(Number(args.p_limit) || 1, 300) }, (_, i) => tick(latest - i)), error: null };
        }
        try {
            const value = typeof handler === 'function' ? handler(args) : handler;
            if (value && value.__error) return { data: null, error: { message: value.__error, code: value.__error } };
            return { data: value === undefined ? null : JSON.parse(JSON.stringify(value)), error: null };
        } catch (error) { return { data: null, error: { message: String(error.message) } }; }
    }
    window.supabase = {
        createClient() {
            return {
                auth: {
                    getSession: async () => ({ data: { session: { access_token: 'test', user } }, error: null }),
                    getUser: async () => ({ data: { user }, error: null }),
                    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
                    signOut: async () => ({ error: null }),
                },
                rpc,
                realtime: { setAuth: async () => {} },
                from: () => chain(),
                // Private tick channels broadcast the live stream every 2 s, like realtime.send does.
                channel: (topic) => {
                    let onTick = null, timer = null;
                    const ch = {
                        on: (type, filter, callback) => { if (type === 'broadcast' && filter?.event === 'tick') onTick = callback; return ch; },
                        subscribe: (cb) => {
                            if (cb) setTimeout(() => cb('SUBSCRIBED'), 0);
                            const live = (fake().rpc || {}).get_ticks_since?.__liveTicks;
                            const index = String(topic).split(':').pop();
                            if (onTick && live) timer = setInterval(() => { const n = Math.floor(Date.now() / 2000); onTick({ payload: { index_code: index, tick_no: live.origin + n, scheduled_at: new Date(n * 2000).toISOString(), price: (10000 + (n % 50) / 10).toFixed(3), digit: n % 10 } }); }, 2000);
                            return ch;
                        },
                        unsubscribe: async () => { clearInterval(timer); },
                    };
                    return ch;
                },
                removeChannel: async () => {},
            };
        },
    };
})();
