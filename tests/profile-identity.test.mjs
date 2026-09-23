import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

test('profile identity renders the authenticated person without account data', async () => {
    const dom = new JSDOM('<!doctype html><body><span data-profile-name></span><span data-profile-email></span><p data-profile-status></p></body>', { runScripts: 'outside-only' });
    dom.window.getAuthenticatedUser = async () => ({ email: 'person@example.test', user_metadata: { display_name: 'Person' } });
    const listeners = [];
    dom.window.addEventListener = (_, listener) => listeners.push(listener);
    dom.window.eval(fs.readFileSync('assets/js/profile-identity.js', 'utf8'));
    await listeners[0]();
    assert.equal(dom.window.document.querySelector('[data-profile-name]').textContent, 'Person');
    assert.equal(dom.window.document.querySelector('[data-profile-email]').textContent, 'person@example.test');
    dom.window.close();
});
