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

test('a character picked on another device is pushed to this page over realtime, with one catch-up read and no polling', async () => {
    const window = load();
    let rowAvatar = 'violet-bow', reads = 0, refreshes = 0, channels = 0, push = null, connect = null;
    const query = { select() { return this; }, eq() { return this; }, maybeSingle: async () => { reads += 1; return { data: { avatar: rowAvatar }, error: null }; } };
    const channel = {
        on(type, filter, handler) { assert.equal(type, 'postgres_changes'); assert.equal(JSON.stringify(filter), JSON.stringify({ event: 'UPDATE', schema: 'public', table: 'profiles', filter: 'id=eq.user-1' })); push = handler; return this; },
        subscribe(callback) { connect = callback; return this; },
    };
    window.getAuthenticatedUser = async () => ({ id: 'user-1', user_metadata: { avatar: 'blue-star' } });
    window.getSupabaseClient = async () => ({ from: () => query, channel: () => { channels += 1; return channel; }, auth: { refreshSession: async () => { refreshes += 1; } } });
    const heard = [];
    window.document.addEventListener('smartprofit:avatar-changed', (event) => heard.push(event.detail.avatar));
    const avatars = window.smartProfitAvatars;
    avatars.markShown('blue-star');                         // the page drew the cached, stale character
    await Promise.all([avatars.listen(), avatars.listen()]);
    assert.equal(channels, 1, 'one channel per page');
    connect('SUBSCRIBED');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(heard, ['violet-bow'], 'the catch-up read wins over the cached copy');
    assert.equal(refreshes, 1, 'the stored session is refreshed');
    push({ new: { avatar: 'violet-bow' } });
    assert.deepEqual(heard, ['violet-bow'], 'no repeat when nothing changed');
    push({ new: { avatar: 'rose-pearls' } });
    push({ new: { avatar: 'not-a-character' } });
    assert.deepEqual(heard, ['violet-bow', 'rose-pearls'], 'pushed changes arrive; unknown ids are ignored');
    window.dispatchEvent(new window.Event('focus'));
    window.document.dispatchEvent(new window.Event('visibilitychange'));
    assert.equal(reads, 1, 'focus and tab switches cause no reads');
    window.close();
});

test('a late catch-up read cannot put the previous character back over a pick just made on this page', async () => {
    const window = load();
    let release = null, connect = null;
    // The catch-up read is slow: it starts before the pick and answers after it, with the old character.
    const query = { select() { return this; }, eq() { return this; }, maybeSingle: () => new Promise((resolve) => { release = () => resolve({ data: { avatar: 'orange-clover' }, error: null }); }) };
    const channel = { on() { return this; }, subscribe(callback) { connect = callback; return this; } };
    window.getAuthenticatedUser = async () => ({ id: 'user-1', user_metadata: { avatar: 'orange-clover' } });
    window.getSupabaseClient = async () => ({ from: () => query, channel: () => channel, auth: { refreshSession: async () => {} } });
    const heard = [];
    window.document.addEventListener('smartprofit:avatar-changed', (event) => heard.push(event.detail.avatar));
    const avatars = window.smartProfitAvatars;
    avatars.markShown('violet-bow');
    await avatars.listen();
    connect('SUBSCRIBED');                     // the catch-up read starts now
    await new Promise((resolve) => setTimeout(resolve, 5));
    avatars.markSaving('violet-bow');           // the customer picks while it is in flight
    release();
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(heard, [], 'the stale read is dropped');
    window.close();
});
