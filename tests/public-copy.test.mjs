import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const GUIDES = ['guide-settlement.html', 'guide-payouts.html', 'guide-fairness.html'];
const PUBLIC_PAGES = ['index.html', 'about.html', 'faq.html', 'contact.html', '404.html', 'blog.html', ...GUIDES];
const read = (file) => fs.readFileSync(file, 'utf8');
const documentOf = (file) => new JSDOM(read(path.join('pages', file))).window.document;
const text = (file) => documentOf(file).body.textContent.replace(/\s+/g, ' ');

// The version-1 policy row seeded by the engine schema is the source of truth for published figures.
const seed = read('supabase/migrations/20260920210000_digit_engine_schema.sql').match(/insert into public\.engine_policy_versions values \(1, now\(\), ([.\d]+), '\{\}'::jsonb, (\d+), (\d+), (\d+), (\d+), ([.\d]+),/);
const percent = (value) => `${Number((Number(value) * 100).toFixed(2))}%`;
const published = { margin: percent(seed[1]), minTicks: seed[2], maxTicks: seed[3], settlementDelay: seed[4], feedLag: seed[5], minProfit: percent(seed[6]) };

test('the guides listing is in the shared navigation and links to every guide, each with its own title and a way back', () => {
    const shell = read('assets/js/shell.js');
    assert.match(shell, /\{ href: 'blog\.html', label: 'Guides'/);
    const listing = documentOf('blog.html');
    assert.deepEqual([...listing.querySelectorAll('.guide-list a')].map((link) => link.getAttribute('href')), GUIDES);
    const titles = new Set([listing.title]);
    for (const guide of GUIDES) {
        const page = documentOf(guide);
        assert.ok(page.title.endsWith('SmartProfit Guides') && !titles.has(page.title), `${guide} title`);
        titles.add(page.title);
        assert.ok(page.querySelector('meta[name="description"]')?.content.length > 40, `${guide} description`);
        assert.equal(page.querySelector('h1')?.textContent.length > 0 && page.querySelectorAll('h1').length, 1, `${guide} has one heading`);
        assert.ok(page.querySelector('.guide-nav a[href="blog.html"], .guides-kicker a[href="blog.html"]'), `${guide} links back to the listing`);
        assert.ok(page.querySelector('[data-shell-header]') && page.querySelector('[data-shell-footer]') && page.querySelector('script[src$="assets/js/shell.js"]'), `${guide} mounts the shared shell`);
        assert.equal(page.body.dataset.shellActive, 'blog', `${guide} highlights Guides`);
    }
});

test('the guides and FAQ state the published margin and policy values from the version-1 seed', () => {
    const payouts = text('guide-payouts.html');
    assert.ok(payouts.includes(`Policy version 1, the version the platform ships with, sets a house margin of ${published.margin}`));
    assert.match(payouts, /between 0\.5% and 15%/, 'configurable bounds are distinguished from the published value');
    assert.ok(payouts.includes(`less than ${published.minProfit} of the stake`));
    const settlement = text('guide-settlement.html');
    assert.ok(settlement.includes(`${published.minTicks} to ${published.maxTicks} ticks`));
    assert.ok(settlement.includes(`more than ${published.settlementDelay} seconds after its scheduled time`));
    assert.ok(settlement.includes(`more than ${published.feedLag} seconds old`));
    // Worked examples must follow the engine's cent-floor formula exactly.
    const payout = (stake, winning) => Math.floor(Math.round(stake * 100) * (1000 - Math.round(Number(seed[1]) * 1000)) * 10 / winning / 1000) / 100;
    for (const [stake, winning, expected] of [[100, 5, '193.00'], [37, 5, '71.41'], [100, 3, '321.66'], [100, 1, '965.00'], [10, 9, '10.72']]) {
        assert.equal(payout(stake, winning).toFixed(2), expected);
        assert.ok(payouts.includes(expected), `payout example ${expected}`);
    }
});

test('the FAQ states the margin, independent outcomes and that practice funds are virtual and cannot be withdrawn', () => {
    const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'https://example.test/pages/faq.html' });
    dom.window.eval(read('assets/js/faq.js'));
    const answers = Object.fromEntries(dom.window.SMARTPROFIT_FAQS.map((faq) => [faq.id, faq.answer]));
    assert.ok(answers.margin.includes(`house margin of ${published.margin}`) && /between 0\.5% and 15%/.test(answers.margin) && /new purchases only/.test(answers.margin));
    assert.match(answers.rounding, /floored to the cent, never rounded up/);
    assert.match(answers.independence, /Outcomes are independent/);
    assert.match(answers.funds, /virtual/);
    assert.match(answers.funds, /cannot be withdrawn/);
    assert.match(answers.real, /^Not yet\./);
});

test('a link to a FAQ entry shows every question and opens that answer, even after filtering', async () => {
    const dom = new JSDOM(read('pages/faq.html'), { runScripts: 'outside-only', url: 'https://example.test/pages/faq.html#faq-funds' });
    const { window } = dom;
    window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};
    window.eval(read('assets/js/faq.js'));
    if (window.document.readyState === 'loading') await new Promise((resolve) => window.document.addEventListener('DOMContentLoaded', resolve, { once: true }));
    const answerOf = (id) => window.document.querySelector(`#faq-${id} .faq-answer`);
    assert.equal(answerOf('funds').hidden, false);
    assert.equal(window.document.querySelector('#faq-funds .faq-question').getAttribute('aria-expanded'), 'true');

    window.document.querySelector('.faq-cat-btn[data-category="fairness"]').click();
    assert.equal(answerOf('margin'), null);
    window.location.hash = '#faq-margin';
    window.dispatchEvent(new window.HashChangeEvent('hashchange'));
    assert.equal(answerOf('margin').hidden, false);
    assert.ok(window.document.querySelector('.faq-cat-btn[data-category="all"]').classList.contains('active'));
});

test('public pages make no promotional, predictive or funding claims and use no blocking dialogs', () => {
    const banned = [/testimonial/i, /guaranteed (?:profit|return|win|income|payout)/i, /\bearn(?:ing|ings)? (?:money|income|up to)/i, /passive income/i, /risk[- ]free/i, /you (?:can|will) (?:win|predict)/i, /(?:deposit|fund) (?:your|now)/i, /withdraw your (?:winnings|profits?)/i, /\b(?:bitcoin|crypto|usdt|btc)\b/i];
    for (const file of PUBLIC_PAGES) {
        const copy = `${documentOf(file).title} ${documentOf(file).querySelector('meta[name="description"]')?.content || ''} ${text(file)}`;
        for (const pattern of banned) assert.doesNotMatch(copy, pattern, `${file}: ${pattern}`);
    }
    for (const file of fs.readdirSync('assets/js').filter((name) => name.endsWith('.js'))) {
        assert.doesNotMatch(read(path.join('assets/js', file)), /\b(?:window\.)?(?:alert|prompt|confirm)\(/, file);
    }
});
