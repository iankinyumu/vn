/* Profile: the customer's trading preferences, which are their onboarding answers. Changing them
   here changes how the site guides them (the trade companion tour, the contract the trade page
   opens on). Saved with save_my_onboarding; the tab's cached answers are refreshed straight away. */
(function () {
    'use strict';

    async function boot() {
        const form = document.querySelector('[data-prefs-form]');
        if (!form) return;
        const status = form.querySelector('[data-prefs-status]');
        const button = form.querySelector('[type="submit"]');
        let client;
        try {
            client = await window.getSupabaseClient();
            const { data, error } = await client.rpc('get_my_onboarding');
            if (error) throw error;
            const answers = data?.data || {};
            form.querySelectorAll('[name="experience"]').forEach((input) => { input.checked = input.value === answers.experience; });
            form.querySelectorAll('[name="interests"]').forEach((input) => { input.checked = (answers.interests || []).includes(input.value); });
        } catch (_) {
            status.textContent = 'Your preferences could not be loaded. Reload the page to try again.';
        }

        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            if (!client || button.disabled) return;
            const experience = form.querySelector('[name="experience"]:checked')?.value ?? null;
            const interests = [...form.querySelectorAll('[name="interests"]:checked')].map((input) => input.value);
            button.disabled = true;
            button.setAttribute('aria-busy', 'true');
            status.textContent = 'Saving…';
            try {
                const { data, error } = await client.rpc('save_my_onboarding', { p_data: { experience, interests }, p_finish: true });
                if (error) throw error;
                await window.markOnboardingComplete?.(data);
                status.textContent = 'Saved. The trade page will follow your new preferences.';
            } catch (_) {
                status.textContent = 'Your preferences could not be saved. Check your connection and try again.';
            } finally {
                button.disabled = false;
                button.removeAttribute('aria-busy');
            }
        });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
    else boot();
})();
