/* Tailoring: the one place that turns the customer's welcome answers into how the site presents
   itself. Pages read these settings, never the raw answers. Tailoring changes order and emphasis
   only; every page, contract and section stays reachable whatever the answers are.

     guidance        'full' | 'light' | 'minimal' | null   from experience (new, some, experienced)
     dashboardLead   'guides' | 'indices' | 'results' | 'breakdown' | null   from goal
     contracts       the contract families chosen, in a fixed order

   No answer gives today's site: no guidance level (the tour still runs once), the usual dashboard
   order, no preferred contract. The settings are set on <html> as data-guidance and
   data-dashboard-lead, and kept for the tab with the onboarding answers (cleared on logout) so they
   apply before the answers are read. Explanations marked data-guidance-open (a <details>) start
   open at full guidance and closed otherwise; the customer can still open or close them. */
(function () {
    'use strict';

    const KEY = 'smartprofit:onboarding:tailoring';
    const GUIDANCE = { new: 'full', some: 'light', experienced: 'minimal' };
    const LEAD = { learn: 'guides', short_term: 'indices', grow: 'results', strategy: 'breakdown' };
    const CONTRACTS = ['evenodd', 'matches', 'overunder'];
    const DEFAULTS = Object.freeze({ guidance: null, dashboardLead: null, contracts: Object.freeze([]) });

    function derive(answers = {}) {
        const chosen = Array.isArray(answers?.interests) ? answers.interests : [];
        return Object.freeze({
            guidance: GUIDANCE[answers?.experience] || null,
            dashboardLead: LEAD[answers?.goal] || null,
            contracts: Object.freeze(CONTRACTS.filter((key) => chosen.includes(key))),
        });
    }

    function remembered() {
        try {
            const saved = JSON.parse(sessionStorage.getItem(KEY));
            if (saved && typeof saved === 'object') return derive(saved);
        } catch (_) { /* Defaults until the answers are read. */ }
        return DEFAULTS;
    }

    let current = remembered();
    const listeners = new Set();

    function apply(settings) {
        const root = document.documentElement;
        if (settings.guidance) root.dataset.guidance = settings.guidance;
        else delete root.dataset.guidance;
        document.querySelectorAll('details[data-guidance-open]').forEach((node) => { node.open = settings.guidance === 'full'; });
        if (settings.dashboardLead) root.dataset.dashboardLead = settings.dashboardLead;
        else delete root.dataset.dashboardLead;
    }

    function update(answers) {
        const next = derive(answers);
        try { sessionStorage.setItem(KEY, JSON.stringify(answers || {})); } catch (_) { /* this page only */ }
        const changed = JSON.stringify(next) !== JSON.stringify(current);
        current = next;
        apply(current);
        if (changed) listeners.forEach((listener) => { try { listener(current); } catch (error) { console.error('[smartprofit] tailoring listener', error); } });
        return current;
    }

    apply(current);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => apply(current), { once: true });

    const fresh = () => (window.smartProfitOnboarding?.answers?.() || Promise.resolve({}))
        .then(update, () => current);
    let ready = fresh();

    // The onboarding and profile pages announce new answers; follow them at once.
    document.addEventListener('smartprofit:onboarding-changed', (event) => { ready = Promise.resolve(update(event.detail?.data || {})); });

    window.smartProfitTailoring = Object.freeze({
        derive,
        // The settings now (remembered for the tab, or the defaults), without waiting.
        current: () => current,
        // The settings once the answers are read.
        settings: () => ready,
        // Called with the new settings whenever they change; returns a function that stops it.
        onChange: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    });
})();
