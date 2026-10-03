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

    // Cross-device sync, pushed rather than polled. A trigger (migration 20261001100000) copies the
    // saved character into public.profiles.avatar, and listen() subscribes this page to its own row
    // over Supabase Realtime (RLS limits it to the signed-in user). A change made on any device or tab
    // arrives as one message and is announced with `smartprofit:avatar-changed`. The only read is one
    // catch-up query each time the channel connects, for changes made while this device was asleep
    // or offline. One channel per page, however many components call listen().
    let shown = null;
    let listening = null;
    const announce = (id) => {
        if (!valid(id) || id === shown) return;
        shown = id;
        document.dispatchEvent(new CustomEvent('smartprofit:avatar-changed', { detail: { avatar: id } }));
    };
    // Records what a page has just drawn (from the cached user), so only real changes are announced.
    const markShown = (id) => { if (valid(id)) shown = id; };
    function listen() {
        if (listening) return listening;
        listening = (async () => {
            try {
                const client = await window.getSupabaseClient?.();
                const user = await window.getAuthenticatedUser?.();
                if (!client?.channel || !user?.id) return;
                const receive = (id) => {
                    if (!valid(id) || id === shown) return;
                    // The stored session still carries the old metadata: refresh it so the next page draws the new character first.
                    client.auth?.refreshSession?.()?.catch?.(() => {});
                    announce(id);
                };
                const catchUp = () => client.from('profiles').select('avatar').eq('id', user.id).maybeSingle()
                    .then(({ data }) => receive(data?.avatar), () => {});
                client.channel(`avatar:${user.id}`)
                    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'profiles', filter: `id=eq.${user.id}` }, (payload) => receive(payload.new?.avatar))
                    .subscribe((status) => { if (status === 'SUBSCRIBED') catchUp(); });
            } catch (_) { /* Offline or signed out: keep what is shown. */ }
        })();
        return listening;
    }
    // Another component on this page saved a new character: keep the record in step.
    document.addEventListener('smartprofit:avatar-changed', (event) => { if (valid(event.detail?.avatar)) shown = event.detail.avatar; });

    window.smartProfitAvatars = Object.freeze({ list: LIST, src, random, fromSeed, valid, forUser, nameOf, listen, markShown });
})();
