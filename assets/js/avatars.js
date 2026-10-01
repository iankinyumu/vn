// Plush character avatars (assets/img/avatars). A new account gets a random one at sign-up,
// stored in the auth user metadata as `avatar`; the profile page lets the person change it.
// Accounts created before avatars existed get a stable pick derived from their user id.
(function () {
    const LIST = Object.freeze([
        ['blue-star', 'Blue star'], ['burgundy-cube', 'Burgundy cube'], ['cloud-pencil', 'Pencil cloud'],
        ['coral-sunglasses', 'Coral fluff'], ['forest-headphones', 'Forest green'], ['golden-diamond', 'Golden reader'],
        ['green-cloud-beret', 'Green cloud'], ['ivory-heart', 'Ivory heart'], ['lavender-beret', 'Lavender beret'],
        ['lilac-pear', 'Lilac pear'], ['orange-clover', 'Orange clover'], ['peach-bucket-hat', 'Peach heart'],
        ['peach-daisy', 'Peach daisy'], ['peach-whistle', 'Peach whistle'], ['rose-belt', 'Rose belt'],
        ['rose-pearls', 'Rose pearls'], ['sage-camera', 'Sage camera'], ['turquoise-bandana', 'Turquoise triangle'],
        ['violet-binoculars', 'Violet binoculars'], ['violet-bow', 'Violet bow'],
    ].map(([id, name]) => Object.freeze({ id, name })));
    const IDS = new Set(LIST.map((item) => item.id));

    // Resolves relative to this script, so pages at any depth find the images.
    const script = document.currentScript?.src;
    const base = script ? new URL('../img/avatars/', script).href : new URL('../assets/img/avatars/', window.location.href).href;
    const src = (id) => `${base}${id}.webp`;
    const random = () => LIST[Math.floor(Math.random() * LIST.length)].id;
    const fromSeed = (seed) => {
        let hash = 0;
        for (const char of String(seed || '')) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
        return LIST[hash % LIST.length].id;
    };
    const valid = (id) => IDS.has(id);
    const forUser = (user) => (valid(user?.user_metadata?.avatar) ? user.user_metadata.avatar : fromSeed(user?.id || user?.email));
    const nameOf = (id) => LIST.find((item) => item.id === id)?.name || 'Character';

    // Cross-device sync. The cached session holds a copy of the user that only refreshes with the
    // session (up to an hour), so a character picked on another device would look stale. sync()
    // asks the server for the current account and, when the character differs from what this page
    // shows, announces it with `smartprofit:avatar-changed`. It runs on load and whenever the
    // person comes back to the tab, at most every 15 seconds.
    let shown = null;
    let lastCheck = 0;
    let syncing = null;
    const announce = (id) => {
        if (!valid(id) || id === shown) return;
        shown = id;
        document.dispatchEvent(new CustomEvent('smartprofit:avatar-changed', { detail: { avatar: id } }));
    };
    // Records what a page has just drawn (from the cached user), so sync() only announces real changes.
    const markShown = (id) => { if (valid(id)) shown = id; };
    async function sync(force = false) {
        if (syncing) return syncing;
        if (!force && Date.now() - lastCheck < 15000) return shown;
        lastCheck = Date.now();
        syncing = (async () => {
            try {
                const client = await window.getSupabaseClient?.();
                const { data, error } = (await client?.auth?.getUser?.()) || {};
                if (!error && data?.user) {
                    const current = forUser(data.user);
                    // Refresh the stored session too, so the next page on this device draws the new character first.
                    if (valid(current) && current !== shown) client.auth.refreshSession?.().catch?.(() => {});
                    announce(current);
                }
            } catch (_) { /* Offline or signed out: keep what is shown. */ }
            return shown;
        })().finally(() => { syncing = null; });
        return syncing;
    }
    // Another page on this device saved a new character: follow it without waiting for the server.
    document.addEventListener('smartprofit:avatar-changed', (event) => { if (valid(event.detail?.avatar)) shown = event.detail.avatar; });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });
    window.addEventListener('focus', () => sync());

    window.smartProfitAvatars = Object.freeze({ list: LIST, src, random, fromSeed, valid, forUser, nameOf, sync, markShown });
})();
