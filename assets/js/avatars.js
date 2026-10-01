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

    window.smartProfitAvatars = Object.freeze({ list: LIST, src, random, fromSeed, valid, forUser, nameOf });
})();
