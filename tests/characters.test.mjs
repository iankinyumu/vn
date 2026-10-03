import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const dir = 'assets/img/characters';
const ids = () => {
    const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'https://example.test/pages/profile.html' });
    dom.window.eval(fs.readFileSync('assets/js/avatars.js', 'utf8'));
    return dom.window.smartProfitAvatars.list.map((item) => item.id);
};

test('every character has an animated and a still 2D SVG, plus the trio', () => {
    for (const id of ids()) {
        const animated = fs.readFileSync(`${dir}/${id}.svg`, 'utf8');
        const still = fs.readFileSync(`${dir}/${id}-still.svg`, 'utf8');
        assert.match(animated, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 200 200"/, `${id} is a 200x200 SVG`);
        assert.match(animated, /@keyframes blink|@keyframes breathe/, `${id} animates`);
        assert.match(animated, /prefers-reduced-motion:reduce/, `${id} stops under reduced motion where supported`);
        assert.doesNotMatch(still, /<style|@keyframes/, `${id}-still has no animation`);
        assert.doesNotMatch(animated + still, /<script|href=|xlink:/, `${id} is self-contained and script-free`);
    }
    assert.match(fs.readFileSync(`${dir}/trio.svg`, 'utf8'), /viewBox="0 0 620 200"/);
});

test('pages reach the 2D characters only through the trade companion, and avatars keep their current images', () => {
    for (const page of fs.readdirSync('pages').filter((name) => name.endsWith('.html'))) {
        assert.doesNotMatch(fs.readFileSync(`pages/${page}`, 'utf8'), /img\/characters\//, page);
    }
    assert.match(fs.readFileSync('assets/js/avatars.js', 'utf8'), /img\/avatars\//);
    assert.match(fs.readFileSync('assets/js/trade-companion.js', 'utf8'), /img\/characters\//);
    for (const id of ['blue-star', 'violet-bow']) assert.ok(fs.existsSync(`${dir}/${id}-asleep.svg`), `${id}-asleep.svg`);
});
