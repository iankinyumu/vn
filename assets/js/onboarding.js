/* Welcome questions for new customers (pages/onboarding.html): why they are here, how familiar they
   are with trading, which contracts interest them, and where to start. Everything is optional and
   "Skip for now" ends it at once; it is shown until answered or skipped, then never again. Answers
   are saved as each step is left, so nothing is lost if the page closes. */
(function () {
    'use strict';

    const TOTAL = 3;
    const NAMES = ['Your goal', 'Your experience', 'Where to start'];
    const START_PAGES = { trade: 'trade.html', guides: 'guide-settlement.html', dashboard: 'dashboard.html' };

    const $ = (selector, root = document) => root.querySelector(selector);
    const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

    let client = null;
    let busy = false;

    // The account the customer last chose on this device (account-switcher.js keeps it), shown as text.
    function showMode() {
        let mode = 'practice';
        try { if (window.localStorage.getItem('smartprofit:account:active') === 'real') mode = 'real'; } catch (_) { /* Practice */ }
        $('[data-ob-mode]').textContent = mode.toUpperCase();
    }

    const status = (text) => { $('[data-ob-status]').textContent = text; };

    function show(step, { focus = true } = {}) {
        $$('.ob-step').forEach((node) => { node.hidden = node.dataset.step !== String(step); });
        $('[data-ob-progress-text]').textContent = `${step} of ${TOTAL} · ${NAMES[step - 1]}`;
        $('[data-ob-progress-bar]').style.width = `${Math.round(((step - 1) / TOTAL) * 100)}%`;
        if (focus) $(`[data-step="${step}"] h1`)?.focus();
    }

    function answers(step) {
        const form = $(`[data-step="${step}"]`);
        const radio = (name) => form.querySelector(`[name="${name}"]:checked`)?.value ?? null;
        if (step === 1) return { goal: radio('goal') };
        if (step === 2) return { experience: radio('experience'), interests: $$('[name="interests"]:checked', form).map((box) => box.value) };
        return { start_with: radio('start_with') };
    }

    function fill(data = {}) {
        for (const [name, value] of Object.entries(data)) {
            for (const input of $$(`[name="${name}"]`)) input.checked = Array.isArray(value) ? value.includes(input.value) : input.value === value;
        }
    }


    async function save(data, { finish = false, skip = false } = {}) {
        const { data: view, error } = await client.rpc('save_my_onboarding', { p_data: data, p_finish: finish, p_skip: skip });
        if (error) throw error;
        return view;
    }

    async function leave(view) {
        await window.markOnboardingComplete?.(view);
        window.location.replace(START_PAGES[view?.data?.start_with] || 'dashboard.html');
    }

    async function run(task, button) {
        if (busy) return;
        busy = true;
        if (button) { button.disabled = true; button.setAttribute('aria-busy', 'true'); }
        try { await task(); }
        catch (_) { status('We could not save that. Check your connection and try again.'); }
        finally {
            busy = false;
            if (button) { button.disabled = false; button.removeAttribute('aria-busy'); }
        }
    }

    async function boot() {
        showMode();
        for (let step = 1; step <= TOTAL; step += 1) {
            const form = $(`[data-step="${step}"]`);
            form.addEventListener('submit', (event) => {
                event.preventDefault();
                run(async () => {
                    status('');
                    const view = await save(answers(step), { finish: step === TOTAL });
                    if (step === TOTAL) await leave(view); else show(step + 1);
                }, form.querySelector('[type="submit"]'));
            });
        }
        $$('[data-ob-back]').forEach((button) => button.addEventListener('click', () => show(Number(button.closest('[data-step]').dataset.step) - 1)));
        // "Skip" on step 1 moves on; "Skip for now" in the header ends it, keeping anything already chosen.
        $('[data-ob-skip]').addEventListener('click', () => show(2));
        $('[data-ob-skip-all]').addEventListener('click', (event) => run(async () => leave(await save({}, { skip: true })), event.currentTarget));

        try { client = await window.getSupabaseClient(); } catch (_) { status('Sign-in is unavailable. Reload the page to try again.'); return; }
        try {
            const { data: view, error } = await client.rpc('get_my_onboarding');
            if (error) throw error;
            // Already done: this page is not shown again.
            if (view?.status === 'completed') { await window.markOnboardingComplete?.(view); window.location.replace('dashboard.html'); return; }
            fill(view?.data);
        } catch (_) { /* Start fresh; saving reports any problem. */ }
        show(1, { focus: false });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
    else boot();
})();
