import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const load = () => {
    const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'https://example.test/pages/register.html' });
    dom.window.eval(fs.readFileSync('assets/js/avatars.js', 'utf8'));
    return dom.window;
};

test('every character has an image, random picks are valid, and a user id always maps to the same character', () => {
    const { smartProfitAvatars: avatars } = load();
    assert.equal(avatars.list.length, 20);
    for (const { id } of avatars.list) assert.ok(fs.existsSync(`assets/img/avatars/${id}.webp`), `${id}.webp exists`);
    for (let i = 0; i < 50; i += 1) assert.ok(avatars.valid(avatars.random()));
    assert.equal(avatars.fromSeed('user-1'), avatars.fromSeed('user-1'));
    assert.equal(avatars.src('blue-star'), 'https://example.test/assets/img/avatars/blue-star.webp');
});

test('a stored character wins over the id-based pick, and an unknown one falls back', () => {
    const { smartProfitAvatars: avatars } = load();
    assert.equal(avatars.forUser({ id: 'user-1', user_metadata: { avatar: 'violet-bow' } }), 'violet-bow');
    assert.equal(avatars.forUser({ id: 'user-1', user_metadata: { avatar: 'not-a-character' } }), avatars.fromSeed('user-1'));
});

test('sign-up assigns a random character, and both pages load the avatar list first', () => {
    assert.match(fs.readFileSync('assets/js/register.js', 'utf8'), /avatar: window\.smartProfitAvatars\.random\(\)/);
    for (const page of ['register.html', 'profile.html']) {
        const html = fs.readFileSync(`pages/${page}`, 'utf8');
        assert.ok(html.indexOf('assets/js/avatars.js') > 0 && html.indexOf('assets/js/avatars.js') < html.indexOf(page === 'register.html' ? 'assets/js/register.js' : 'assets/js/profile-identity.js'), `${page} loads avatars.js first`);
    }
});

test('the side panel shows the character on the Profile link and follows a new pick', async () => {
    const dom = new JSDOM('<!doctype html><body data-shell-surface="app" data-shell-active="dashboard"><div data-shell-header></div><div data-shell-footer></div></body>', { runScripts: 'outside-only', url: 'https://example.test/pages/dashboard.html' });
    const { window } = dom;
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    window.getAuthenticatedUser = async () => ({ id: 'user-1', user_metadata: { avatar: 'violet-bow' } });
    window.eval(fs.readFileSync('assets/js/avatars.js', 'utf8'));
    window.eval(fs.readFileSync('assets/js/shell.js', 'utf8'));
    const image = () => window.document.querySelector('[data-rail-profile] .app-rail-avatar');
    for (let i = 0; i < 50 && !image(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    try {
        assert.equal(image()?.getAttribute('src'), 'https://example.test/assets/img/avatars/violet-bow.webp');
        assert.equal(window.document.querySelector('[data-rail-profile] i'), null, 'the generic icon is replaced');
        window.document.dispatchEvent(new window.CustomEvent('smartprofit:avatar-changed', { detail: { avatar: 'blue-star' } }));
        assert.equal(image().getAttribute('src'), 'https://example.test/assets/img/avatars/blue-star.webp');
    } finally { window.close(); }
});

test('a character picked on another device reaches this page: sync() asks the server and announces only real changes', async () => {
    const window = load();
    let serverAvatar = 'violet-bow', calls = 0;
    window.getSupabaseClient = async () => ({ auth: { getUser: async () => { calls += 1; return { data: { user: { id: 'user-1', user_metadata: { avatar: serverAvatar } } }, error: null }; } } });
    const heard = [];
    window.document.addEventListener('smartprofit:avatar-changed', (event) => heard.push(event.detail.avatar));
    const avatars = window.smartProfitAvatars;
    avatars.markShown('blue-star');                 // the page drew the cached, stale character
    await avatars.sync(true);
    assert.deepEqual(heard, ['violet-bow'], 'the server copy wins');
    await avatars.sync(true);
    assert.deepEqual(heard, ['violet-bow'], 'no repeat when nothing changed');
    serverAvatar = 'rose-pearls';
    await avatars.sync();                           // within 15 seconds: throttled, no request
    assert.equal(calls, 2);
    await avatars.sync(true);
    assert.deepEqual(heard, ['violet-bow', 'rose-pearls']);
    window.getSupabaseClient = async () => ({ auth: { getUser: async () => ({ data: null, error: new Error('offline') }) } });
    await avatars.sync(true);
    assert.deepEqual(heard, ['violet-bow', 'rose-pearls'], 'offline keeps what is shown');
    window.close();
});
