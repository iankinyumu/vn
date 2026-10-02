import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ICON_FONT_URL, ICON_NAMES } from '../scripts/icon-map.mjs';

/* Icons are Google Material Symbols requested per page with only the names in use (icon_names).
   A name missing from that request renders as its letters, so every name the pages and scripts use
   must be in scripts/icon-map.mjs, and every page must request the current set. */

const pages = fs.readdirSync('pages').filter((name) => name.endsWith('.html')).map((name) => [`pages/${name}`, fs.readFileSync(`pages/${name}`, 'utf8')]);
const scripts = fs.readdirSync('assets/js').filter((name) => name.endsWith('.js')).map((name) => [`assets/js/${name}`, fs.readFileSync(`assets/js/${name}`, 'utf8')]);
const link = `<link href="${ICON_FONT_URL.replaceAll('&', '&amp;')}" rel="stylesheet">`;

test('no Font Awesome remains in pages, scripts or styles', () => {
    const css = fs.readdirSync('assets/css').map((name) => [`assets/css/${name}`, fs.readFileSync(`assets/css/${name}`, 'utf8')]);
    for (const [path, source] of [...pages, ...scripts, ...css]) {
        assert.doesNotMatch(source, /font-awesome|\bfa-[a-z]|\bfa[srb] /, `${path} still uses Font Awesome`);
    }
});

test('every page that shows icons requests the current Material Symbols set once', () => {
    for (const [path, source] of pages) {
        const usesIcons = source.includes('data-icon=') || /shell\.js|notifications\.js|deposit-sheet\.js|faq\.js|engine-notice\.js/.test(source);
        if (!usesIcons) continue;
        assert.equal(source.split('Material+Symbols+Outlined').length - 1, 1, `${path} must request the icon font exactly once`);
        assert.ok(source.includes(link), `${path} requests an out-of-date icon set; copy the link built from scripts/icon-map.mjs`);
    }
});

test('every icon name used is in the requested set', () => {
    const used = new Set();
    for (const [, source] of [...pages, ...scripts]) {
        for (const match of source.matchAll(/data-icon="([a-z0-9_]+)"/g)) used.add(match[1]);
        for (const match of source.matchAll(/(?:\bicon\(|\bicon: |dataset\.icon = |'data-icon': )'([a-z0-9_]+)'/g)) used.add(match[1]);
        // Names chosen in code: lookup tables and ternaries that feed an icon.
        for (const line of source.split('\n').filter((text) => /SIDE_ICONS = |\bicon\(tone|card\('/.test(text))) {
            for (const match of line.matchAll(/'([a-z][a-z0-9_]*)(?: text-[a-z]+)?'/g)) if (/_|^(tag|equal|difference|circle|bolt|group|inbox)$/.test(match[1]) || ICON_NAMES.includes(match[1])) used.add(match[1]);
        }
    }
    assert.ok(used.size > 40, `only ${used.size} icon names found; the scan is broken`);
    const missing = [...used].filter((name) => !ICON_NAMES.includes(name));
    assert.deepEqual(missing, [], 'icon names used but not requested from Google');
});
