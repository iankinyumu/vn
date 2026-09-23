(function () {
    async function start() {
        const user = await window.getAuthenticatedUser();
        if (!user) return;
        const name = user.user_metadata?.display_name || user.user_metadata?.full_name || user.email;
        document.querySelector('[data-profile-name]').textContent = name;
        document.querySelector('[data-profile-email]').textContent = user.email;
    }
    window.addEventListener('DOMContentLoaded', () => start().catch((error) => { console.error(error); document.querySelector('[data-profile-status]').textContent = 'Identity details are temporarily unavailable.'; }));
})();
