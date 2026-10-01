(function () {
    const MODE_LABELS = Object.freeze({ DEMO: 'Practice', REAL: 'Real' });
    const find = (selector) => document.querySelector(selector);
    const text = (selector, value) => { const node = find(selector); if (node) node.textContent = value; };
    const avatars = () => window.smartProfitAvatars;
    function showName(name) {
        text('[data-profile-name]', name);
        const input = find('[data-profile-display-name]');
        if (input) input.value = name;
    }

    // The profile picture is a plush character (avatars.js), shown free: no frame or initials.
    function showAvatar(id) {
        const holder = find('[data-profile-avatar]');
        const image = find('[data-profile-avatar-img]');
        if (!holder || !image || !avatars()) return;
        image.src = avatars().src(id);
        image.hidden = false;
        holder.dataset.avatar = id;
        holder.setAttribute('aria-label', `Your character: ${avatars().nameOf(id)}`);
    }

    // A radio group of every character; choosing one saves it to the auth user metadata.
    function renderPicker(current, save) {
        const group = find('[data-avatar-options]');
        if (!group || !avatars()) return;
        group.replaceChildren(...avatars().list.map(({ id, name }) => {
            const option = document.createElement('label');
            option.className = 'avatar-option';
            const input = Object.assign(document.createElement('input'), { type: 'radio', name: 'avatar', value: id, checked: id === current, className: 'visually-hidden' });
            const image = Object.assign(document.createElement('img'), { src: avatars().src(id), alt: '', width: 72, height: 72, loading: 'lazy', decoding: 'async' });
            const label = Object.assign(document.createElement('span'), { className: 'avatar-option-name', textContent: name });
            option.append(input, image, label);
            return option;
        }));
        group.addEventListener('change', (event) => { if (event.target.name === 'avatar') save(event.target.value); });
    }

    function bindTabs() {
        document.querySelectorAll('[data-profile-tab]').forEach((tab) => tab.addEventListener('click', () => {
            document.querySelectorAll('[data-profile-tab]').forEach((item) => { item.classList.toggle('active', item === tab); item.setAttribute('aria-selected', String(item === tab)); });
            document.querySelectorAll('.tab-content').forEach((panel) => panel.classList.toggle('active', panel.id === `tab-${tab.dataset.profileTab}`));
        }));
        find('[data-profile-logout]')?.addEventListener('click', () => window.logout?.());
    }

    // Identity only: the profile shows who is signed in and which account types exist, never balances or history.
    function renderAccounts(accounts, realEnabled) {
        const body = find('[data-profile-accounts]');
        if (!body) return;
        body.replaceChildren(...accounts.map((account) => {
            const row = document.createElement('tr');
            const available = account.execution_mode === 'DEMO' || realEnabled;
            [MODE_LABELS[account.execution_mode] || account.execution_mode, account.currency, available ? account.status : 'Not available yet'].forEach((value) => {
                const cell = document.createElement('td');
                cell.textContent = value;
                row.append(cell);
            });
            return row;
        }));
    }

    async function start() {
        bindTabs();
        const user = await window.getAuthenticatedUser();
        if (!user) return;
        showName(user.user_metadata?.display_name || user.user_metadata?.full_name || user.email);
        let avatar = avatars()?.forUser(user);
        if (avatar) showAvatar(avatar);
        text('[data-profile-email]', user.email);
        const emailInput = find('[data-profile-email-input]');
        if (emailInput) emailInput.value = user.email || '';
        text('[data-profile-verified]', user.email_confirmed_at ? 'Verified' : 'Not verified');
        if (typeof window.getSupabaseClient !== 'function') return;

        const client = await window.getSupabaseClient();
        const { data: profile, error } = await client.from('profiles').select('display_name, created_at').eq('id', user.id).maybeSingle();
        if (error) throw error;
        if (profile?.display_name) showName(profile.display_name);
        if (profile?.created_at) text('[data-profile-created]', new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric' }).format(new Date(profile.created_at)));

        renderPicker(avatar, async (choice) => {
            const status = find('[data-avatar-status]');
            const previous = avatar;
            showAvatar(choice);
            if (status) status.textContent = 'Saving…';
            const { error: avatarError } = await client.auth.updateUser({ data: { avatar: choice } });
            if (avatarError) {
                console.error(avatarError);
                showAvatar(previous);
                const radio = find(`[data-avatar-options] input[value="${previous}"]`);
                if (radio) radio.checked = true;
                if (status) status.textContent = 'Your character could not be saved. Please try again.';
                return;
            }
            avatar = choice;
            document.dispatchEvent(new CustomEvent('smartprofit:avatar-changed', { detail: { avatar: choice } }));
            if (status) status.textContent = `Character saved: ${avatars().nameOf(choice)}.`;
        });

        const form = find('#profileForm');
        if (form) form.addEventListener('submit', async (event) => {
            event.preventDefault();
            const status = find('[data-profile-save-status]');
            const displayName = find('[data-profile-display-name]').value.trim();
            if (!displayName || displayName.length > 120) { status.textContent = 'Enter a display name of 1 to 120 characters.'; return; }
            status.textContent = 'Saving…';
            const { error: saveError } = await client.from('profiles').update({ display_name: displayName }).eq('id', user.id);
            if (saveError) { console.error(saveError); status.textContent = 'Your display name could not be saved. Please try again.'; return; }
            showName(displayName);
            status.textContent = 'Display name saved.';
        });

        if (typeof window.initAccountSwitcher === 'function') {
            const { config, accounts } = await window.initAccountSwitcher();
            renderAccounts(accounts, Boolean(config.real_enabled));
            text('[data-account-mode]', MODE_LABELS[window.smartProfitAccount.get().mode] || '—');
            document.addEventListener('smartprofit:account-changed', () => text('[data-account-mode]', MODE_LABELS[window.smartProfitAccount.get().mode] || '—'));
            await window.refreshRestrictionBanner?.();
        }
    }
    window.addEventListener('DOMContentLoaded', () => start().catch((error) => { console.error(error); text('[data-profile-status]', 'Some profile details are temporarily unavailable.'); }).finally(() => window.smartProfitLoader?.pageReady()));
})();
