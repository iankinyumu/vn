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
