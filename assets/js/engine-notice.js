/* Announcements for scheduled price-engine changes (ADR 0001 §5.5, §5.6): a move to
   the new engine at a UTC midnight, or a rescale of one index. Informational only:
   one quiet banner under the top bar, dismissible, and shown again only when the
   schedule changes. Nothing here blocks trading; the database gates purchases. */
(function () {
    'use strict';

    const KEY = 'smartprofit:engine-notice-dismissed';
    const indexName = (code) => `SP Index ${String(code).replace(/^SPI/, '')}`;
    const list = (names) => (names.length < 2 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);
    const utcDay = (ms) => new Date(Number(ms)).toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

    // Returns [{ id, text }] for every change still ahead.
    function announcements(status, rescales, now) {
        const out = [];
        const byCutover = new Map();
        for (const row of status || []) {
            if (row.execution_mode !== 'DEMO' || row.engine_generation !== 2 || !row.cutover_ms || Number(row.cutover_ms) <= now) continue;
            const key = String(row.cutover_ms);
            byCutover.set(key, [...(byCutover.get(key) || []), indexName(row.index_code)]);
        }
        for (const [ms, names] of byCutover) {
            out.push({
                id: `cutover:${ms}:${names.join(',')}`,
                text: `${list(names)} ${names.length > 1 ? 'move' : 'moves'} to the new price engine at 00:00 UTC on ${utcDay(ms)}. Prices restart from 10,000.000 and move freely, with no pull toward a fixed level. Contracts that would end after the switch cannot be bought just before it.`,
            });
        }
        for (const r of rescales || []) {
            if (r.mode !== 'DEMO') continue;
            const resumeMs = new Date(r.resume_at).getTime();
            if (!(resumeMs > now)) continue;
            const pauseTime = new Date(r.pause_from).toLocaleTimeString('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit' });
            const change = r.factor === '10' ? 'multiplied by 10' : r.factor === '1/10' ? 'divided by 10' : 'unchanged';
            out.push({
                id: `rescale:${r.index}:${resumeMs}:${r.factor}`,
                text: r.kind === 'rescale'
                    ? `${indexName(r.index)} is rescaled at 00:00 UTC on ${utcDay(resumeMs)}: its price is ${change}. It pauses from ${pauseTime} UTC the evening before. Past results and open contracts are unaffected.`
                    : `${indexName(r.index)} resumes at 00:00 UTC on ${utcDay(resumeMs)}, with its price ${change}.`,
            });
        }
        return out;
    }

    function dismissed() { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (_) { return []; } }
    function dismiss(ids) { try { localStorage.setItem(KEY, JSON.stringify(ids)); } catch (_) { /* A convenience only. */ } }

    function render(mount, items) {
        const hidden = new Set(dismissed());
        const visible = items.filter((item) => !hidden.has(item.id));
        mount.replaceChildren();
        mount.hidden = visible.length === 0;
        if (!visible.length) return;
        const icon = document.createElement('i');
        icon.className = 'fas fa-circle-info engine-notice-icon';
        icon.setAttribute('aria-hidden', 'true');
        const body = document.createElement('div');
        body.className = 'engine-notice-body';
        for (const item of visible) {
            const p = document.createElement('p');
            p.textContent = item.text;
            body.append(p);
        }
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'engine-notice-close';
        close.setAttribute('aria-label', 'Dismiss this notice');
        close.append(Object.assign(document.createElement('i'), { className: 'fas fa-xmark' }));
        close.firstChild.setAttribute('aria-hidden', 'true');
        close.addEventListener('click', () => { dismiss(items.map((item) => item.id)); mount.hidden = true; });
        mount.append(icon, body, close);
    }

    async function refresh() {
        const mount = document.querySelector('[data-engine-notice]');
        if (!mount || typeof window.getSupabaseClient !== 'function') return;
        const client = await window.getSupabaseClient();
        const [status, rescales] = await Promise.all([
            client.rpc('get_engine_v3_status', {}).then(({ data }) => data || []).catch(() => []),
            // Present once migration 20260928100000 is applied; absent is simply no rescales.
            client.rpc('get_engine_v3_rescales', {}).then(({ data, error }) => (error ? [] : data || [])).catch(() => []),
        ]);
        render(mount, announcements(status, rescales, Date.now()));
    }

    window.smartProfitEngineNotice = Object.freeze({ refresh, announcements });
    const start = () => { refresh().catch(() => { /* Announcements are informational; the page works without them. */ }); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
})();
