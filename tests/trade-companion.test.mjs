import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

// A stand-in for the trade page's hooks; trade.js itself is not loaded, the companion only reads these.
const PAGE = `<!doctype html><body><form data-trade-form>
  <div data-families><label><input type="radio" name="family" value="evenodd" checked></label><label><input type="radio" name="family" value="overunder"></label></div>
  <span data-feed-state data-state="live">Live</span>
  <section class="trade-ticket">
    <input id="trade-stake" type="number" min="1" max="500" step="0.01" value="1.00" required>
    <div data-tick-chips><label><input type="radio" name="ticks" value="5" checked></label></div>
    <strong data-session-net>$0.00</strong><small data-session-count>0W · 0L</small>
    <p data-v3-gate hidden></p>
    <p data-session-guard hidden><span data-session-guard-text></span></p>
    <p data-trade-status></p>
  </section></form></body>`;

async function open({ store = { toured: true }, avatar = 'peach-whistle' } = {}) {
    const dom = new JSDOM(PAGE, { runScripts: 'outside-only', url: 'https://example.test/pages/trade.html' });
    const { window } = dom;
    window.localStorage.setItem('smartprofit:companion', JSON.stringify(store));
    window.getAuthenticatedUser = async () => ({ id: 'user-1', user_metadata: { avatar } });
    window.eval(fs.readFileSync('assets/js/avatars.js', 'utf8'));
    window.eval(fs.readFileSync('assets/js/trade-companion.js', 'utf8'));
    window.dispatchEvent(new window.Event('DOMContentLoaded'));
    const $ = (selector) => window.document.querySelector(selector);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
    await settle(); await settle();
    return { window, $, settle, bubble: () => ($('[data-companion-bubble]').hidden ? '' : $('[data-companion-text]').textContent), close: () => dom.window.close() };
}

test('the companion is the character picked on the profile, under the order ticket, awake while the feed is live', async () => {
    const page = await open();
    try {
        assert.ok(page.$('.trade-ticket [data-companion]'), 'mounted inside the ticket, in the page flow');
        assert.equal(page.$('[data-companion-img]').getAttribute('src'), 'https://example.test/assets/img/characters/peach-whistle.svg');
        assert.equal(page.$('[data-companion]').dataset.pose, 'awake');
        assert.equal(page.bubble(), '', 'quiet when nothing is blocked');
    } finally { page.close(); }
});

test('it sleeps when the feed is not live and explains why buying is blocked', async () => {
    const page = await open();
    try {
        page.$('[data-feed-state]').dataset.state = 'stale';
        await page.settle();
        assert.equal(page.$('[data-companion]').dataset.pose, 'asleep');
        assert.match(page.$('[data-companion-img]').getAttribute('src'), /peach-whistle-asleep\.svg$/);
        assert.match(page.bubble(), /reconnecting, so buying is paused/);
        page.$('[data-feed-state]').dataset.state = 'live';
        await page.settle();
        assert.equal(page.$('[data-companion]').dataset.pose, 'awake');
        assert.equal(page.bubble(), '');
        page.$('#trade-stake').value = '0.10';
        page.$('#trade-stake').dispatchEvent(new page.window.Event('input', { bubbles: true }));
        await page.settle();
        assert.match(page.bubble(), /between \$1\.00 and \$500\.00/);
    } finally { page.close(); }
});

test('it keeps the session limits and announces them, but never reacts to a purchase or a result', async () => {
    const page = await open();
    try {
        page.$('[data-trade-status]').textContent = 'Even bought · exit tick #1005';
        page.$('[data-session-net]').textContent = '+$9.30';
        page.$('[data-session-count]').textContent = '3W · 0L';
        await page.settle();
        assert.equal(page.bubble(), '', 'no comment on a purchase, a win streak or the session result');
        page.$('[data-session-guard-text]').textContent = 'Take profit reached for this session.';
        page.$('[data-session-guard]').hidden = false;
        await page.settle();
        assert.match(page.bubble(), /^Take profit reached for this session\. Your session has stopped here\./);
        assert.match(page.$('[data-companion-live]').textContent, /Take profit reached/);
    } finally { page.close(); }
});

test('it suggests a break after 25 contracts in a session', async () => {
    const page = await open();
    try {
        page.$('[data-session-count]').textContent = '12W · 13L';
        await page.settle();
        assert.match(page.bubble(), /placed 25 contracts this session\. This is a good moment for a break\./);
    } finally { page.close(); }
});

test('tapping it explains the selected contract type; the first visit gets a tour; hiding is remembered', async () => {
    const first = await open({ store: {} });
    try {
        assert.match(first.bubble(), /^1 of 3\./);
        [...first.window.document.querySelectorAll('.companion-action')].find((button) => button.textContent === 'Skip').click();
        assert.equal(first.bubble(), '');
        first.$('[data-companion-toggle]').click();
        assert.match(first.bubble(), /^Even \/ Odd: .* You've chosen 5 ticks: the contract settles on the 5th tick after you buy\.$/);
        assert.equal(JSON.parse(first.window.localStorage.getItem('smartprofit:companion')).toured, true, 'skipping counts as seen');
        first.$('[data-companion-hide]').click();
        assert.equal(first.$('[data-companion]').hidden, true);
        assert.equal(JSON.parse(first.window.localStorage.getItem('smartprofit:companion')).hidden, true);
        assert.equal(first.$('[data-companion-show]').hidden, false);
    } finally { first.close(); }
});
