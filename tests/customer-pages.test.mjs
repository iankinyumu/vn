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
    const readme = fs.readFileSync('README.md', 'utf8');
    assert.doesNotMatch(readme, /astra/i, 'README.md');
    assert.match(readme, /^# SmartProfit\b/);
    // Every repository path the README names must exist, so the document stays accurate as files move.
    for (const [, reference] of readme.matchAll(/`((?:pages|assets|docs|supabase|scripts|tests|modules)\/[^`*<]+|[A-Z_]+\.md)`/g)) {
        assert.ok(fs.existsSync(reference.replace(/\/$/, '')), `README.md names missing path ${reference}`);
    }
});

test('every customer navigation surface links to the fairness verifier', () => {
    // Pages that mount the shared shell get their navigation from shell.js, whose public and app menus both list Fairness.
    const shell = fs.readFileSync('assets/js/shell.js', 'utf8');
    for (const menu of ['PUBLIC_LINKS', 'APP_LINKS']) assert.match(shell.match(new RegExp(`${menu} = Object\\.freeze\\(\\[([\\s\\S]*?)\\]\\)`))[1], /href: 'fairness\.html'/, menu);
    for (const file of pages.filter((name) => !['404.html', 'forgot-password.html', 'staff-login.html', 'support.html', 'admin.html'].includes(name))) {
        const source = fs.readFileSync(path.join('pages', file), 'utf8');
        assert.ok(/fairness\.html/.test(source) || (/data-shell-header/.test(source) && source.includes('assets/js/shell.js')), file);
    }
});

/* The Phase 1 shutdown retired legacy data, not the customer design. Contact,
   dashboard and profile keep the vn10 layout, repurposed for the indices. */
test('contact, dashboard and profile keep their designed layouts on the shared shell', () => {
    const page = (name) => fs.readFileSync(path.join('pages', name), 'utf8');
    const expectations = {
        'contact.html': ['contact.css', 'contact-hero', 'id="contactForm"', 'id="requestHistory"', 'assets/js/contact.js', 'data-shell-surface="public"'],
        'dashboard.html': ['welcome-section', 'balance-card', 'stat-card', 'chart-card', 'data-index-rows', 'data-open-contracts', 'data-latest-ticks', 'assets/js/charts.js', 'data-shell-surface="app"'],
        'profile.html': ['profile.css', 'profile-header-card', 'data-profile-tab="settings"', 'data-profile-tab="accounts"', 'id="profileForm"', 'data-shell-surface="app"'],
    };
    for (const [name, needles] of Object.entries(expectations)) {
        const source = page(name);
        for (const needle of needles) assert.ok(source.includes(needle), `${name} is missing ${needle}`);
        assert.ok(source.includes('assets/js/shell.js'), `${name} must mount the shared shell`);
        assert.doesNotMatch(source, /Order Book|24h Volume|Dominance|Listed Coins|API Keys|KYC|unsplash/i, `${name} still carries retired market content`);
    }
    assert.doesNotMatch(page('contact.html'), /value="(deposit|withdrawal)"/, 'Practice accounts have no funding topics');
});

test('fairness uses the shared app header and keeps the verifier controls', () => {
    const source = fs.readFileSync('pages/fairness.html', 'utf8');
    for (const required of ['data-shell-surface="app"', 'data-shell-active="fairness"', 'data-shell-header', 'data-shell-footer', 'assets/js/shell.js', 'assets/css/fairness.css', 'data-fairness-form', 'data-fairness-result', 'data-fairness-epochs']) {
        assert.ok(source.includes(required), `fairness page is missing ${required}`);
    }
    assert.doesNotMatch(source, /<header class="premium-header"/, 'fairness must not render a separate navbar');
});
