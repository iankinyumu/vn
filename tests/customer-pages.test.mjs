import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const pages = fs.readdirSync('pages').filter((file) => file.endsWith('.html'));

test('customer pages have no dead relative HTML links', () => {
    for (const file of pages) {
        const source = fs.readFileSync(path.join('pages', file), 'utf8');
        for (const href of source.matchAll(/href=["']([^"'#?]+\.html)["']/gi)) {
            assert.ok(fs.existsSync(path.join('pages', href[1])), `${file} links to missing ${href[1]}`);
        }
    }
});

test('SmartProfit naming replaces the retired tool name in customer sources', () => {
    for (const root of ['pages', 'assets', 'docs']) {
        const files = fs.readdirSync(root, { recursive: true }).filter((file) => typeof file === 'string');
        for (const file of files) {
            const target = path.join(root, file);
            if (fs.statSync(target).isFile()) assert.doesNotMatch(fs.readFileSync(target, 'utf8'), /astra/i, target);
        }
    }
});

test('every customer navigation surface links to the fairness verifier', () => {
    for (const file of pages.filter((name) => !['404.html', 'forgot-password.html', 'staff-login.html', 'support.html', 'admin.html'].includes(name))) {
        assert.match(fs.readFileSync(path.join('pages', file), 'utf8'), /fairness\.html/, file);
    }
});
