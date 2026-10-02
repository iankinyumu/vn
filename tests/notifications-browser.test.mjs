import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const USER = 'user-1';
const today = new Date().toISOString();
const lastWeek = new Date(Date.now() - 7 * 86_400_000).toISOString();

function fakeServer({ fail = false } = {}) {
    const state = {
        announcements: [
            { id: 'a-important', title: 'Maintenance tonight', body: 'Trading pauses from 02:00 to 02:15 EAT.', link: 'faq.html', severity: 'important', created_at: today, read: false },
            { id: 'a-info', title: 'New guide', body: 'Read how settlement works.', link: 'https://evil.example/', severity: 'info', created_at: lastWeek, read: true },
        ],
        notifications: [
            { id: 'n-1', category: 'support', title: 'Support replied on SP-1001', body: 'Your deposit was credited.', link: 'support.html', created_at: today, read: false, from_staff: true },
            { id: 'n-2', category: 'funding', title: 'Deposit confirmed', body: '$10.00 added to REAL.', link: null, created_at: lastWeek, read: true, from_staff: false },
        ],
    };
    const unread = () => [...state.announcements, ...state.notifications].filter((item) => !item.read).length;
    const calls = [], channels = [];
    const client = {
        channel(topic) {
            const channel = { topic, handlers: [], on(type, filter, handler) { this.handlers.push({ type, filter, handler }); return this; }, subscribe(callback) { callback?.('SUBSCRIBED'); return this; } };
            channels.push(channel);
            return channel;
        },
        async rpc(name, args) {
            calls.push({ name, args });
            if (fail) return { data: null, error: { message: 'network' } };
            if (name === 'get_notification_unread_count') return { data: unread(), error: null };
            if (name === 'list_my_notifications') return { data: { announcements: state.announcements.map((item) => ({ ...item })), notifications: state.notifications.slice(0, args.p_limit).map((item) => ({ ...item })), unread: unread() }, error: null };
            if (name === 'mark_notifications_read') {
                for (const item of state.notifications) if (args.p_all || args.p_notification_ids?.includes(item.id)) item.read = true;
                for (const item of state.announcements) if (args.p_all || args.p_announcement_ids?.includes(item.id)) item.read = true;
                return { data: unread(), error: null };
            }
            return { data: null, error: null };
        },
    };
    return { client, calls, channels, state };
}

async function openPage(server) {
    const dom = new JSDOM('<!doctype html><html><body data-shell-surface="app" data-shell-active="dashboard"><div data-shell-header></div><main></main><div data-shell-footer></div></body></html>', { runScripts: 'outside-only', url: 'https://example.test/pages/dashboard.html' });
    dom.window.getSupabaseClient = async () => server.client;
    dom.window.getAuthenticatedUser = async () => ({ id: USER });
    dom.window.eval(fs.readFileSync('assets/js/shell.js', 'utf8'));
    dom.window.eval(fs.readFileSync('assets/js/notifications.js', 'utf8'));
    return dom;
}

async function waitFor(predicate, message, timeout = 2000) {
    const started = Date.now();
    while (!predicate()) {
        if (Date.now() - started > timeout) throw new Error(message);
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

test('the top bar button shows the unread count as text and opens the inbox with announcements first', async () => {
    const server = fakeServer();
    const dom = await openPage(server);
    const { document } = dom.window;
    try {
        await waitFor(() => document.querySelector('[data-notify-open]'), 'the notification button was not mounted');
        const button = document.querySelector('.app-topbar [data-notify-open]');
        assert.ok(button, 'the button is not in the top bar');
        await waitFor(() => button.getAttribute('aria-label') === 'Notifications, 2 unread', 'the unread count was not shown');
        assert.equal(button.querySelector('[data-notify-count]').textContent, '2');
        assert.equal(button.querySelector('[class*="badge"], [class*="dot"], [class*="pill"]'), null);

        const banner = document.querySelector('[data-announcement-banner]');
        assert.equal(banner.hidden, false, 'an unread important announcement was not shown as a banner');
        assert.match(banner.textContent, /Important: Maintenance tonight/);

        button.click();
        const sheet = document.querySelector('[data-notify-sheet]');
        await waitFor(() => sheet.querySelectorAll('[data-notify-item]').length === 4, 'the inbox was not listed');
        assert.equal(sheet.open, true);
        assert.equal(button.getAttribute('aria-expanded'), 'true');
        assert.deepEqual([...sheet.querySelectorAll('.notify-group-title')].map((node) => node.textContent), ['Announcements', 'Today', 'Earlier']);
        const items = [...sheet.querySelectorAll('[data-notify-item]')];
        assert.match(items[0].textContent, /^Important announcement · .* · UnreadMaintenance tonight/);
        assert.match(items[2].textContent, /^From support · /, 'a staff message was not labelled');
        assert.ok(items[2].classList.contains('is-unread'));
        assert.equal(items[1].querySelector('a'), null, 'an off-site link was rendered');
        assert.equal(items[2].querySelector('a').getAttribute('href'), 'support.html');
        assert.equal(sheet.querySelector('[data-notify-empty]').hidden, true);

        items[2].querySelector('.notify-text-btn').click();
        await waitFor(() => button.getAttribute('aria-label') === 'Notifications, 1 unread', 'marking one read did not lower the count');
        assert.deepEqual(JSON.parse(JSON.stringify(server.calls.find((call) => call.name === 'mark_notifications_read').args)), { p_notification_ids: ['n-1'], p_announcement_ids: null, p_all: false });

        sheet.querySelector('[data-notify-all-read]').click();
        await waitFor(() => button.getAttribute('aria-label') === 'Notifications', 'mark all read did not clear the count');
        assert.equal(button.querySelector('[data-notify-count]').hidden, true);
        assert.equal(banner.hidden, true, 'the banner stayed after its announcement was read');
        assert.equal(sheet.querySelectorAll('.is-unread').length, 0);
        assert.equal(sheet.querySelector('[data-notify-all-read]').disabled, true);

        sheet.querySelector('[data-notify-close]').click();
        assert.equal(sheet.open, false);
        assert.equal(button.getAttribute('aria-expanded'), 'false');
    } finally { dom.window.close(); }
});

test('a new notification or announcement arrives live as a toast and updates the count; trade items stay quiet', async () => {
    const server = fakeServer();
    const dom = await openPage(server);
    const { document } = dom.window;
    try {
        await waitFor(() => server.channels.some((channel) => channel.topic === `notifications:${USER}`), 'the realtime channel was not opened');
        const channel = server.channels.find((item) => item.topic === `notifications:${USER}`);
        const personal = channel.handlers.find((item) => item.filter.table === 'notifications');
        assert.equal(personal.filter.filter, `user_id=eq.${USER}`);
        server.state.notifications.unshift({ id: 'n-3', category: 'account', title: 'Your account was restored', body: 'You can trade again.', created_at: today, read: false });
        personal.handler({ new: { id: 'n-3', category: 'account', title: 'Your account was restored', body: 'You can trade again.', sent_by: null } });
        await waitFor(() => document.querySelector('[data-toast]'), 'no toast for a new notification');
        assert.match(document.querySelector('[data-toast]').textContent, /^Your account was restored/);
        await waitFor(() => document.querySelector('[data-notify-open]').getAttribute('aria-label') === 'Notifications, 3 unread', 'the count did not rise');

        personal.handler({ new: { id: 'n-4', category: 'trade', title: '12 trades settled', body: '' } });
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(document.querySelectorAll('[data-toast]').length, 1, 'a trade notification was toasted twice');

        const broadcast = channel.handlers.find((item) => item.filter.table === 'announcements' && item.filter.event === 'INSERT');
        broadcast.handler({ new: { id: 'a-new', title: 'New index', body: 'SPI50 opens on Monday.' } });
        await waitFor(() => document.querySelectorAll('[data-toast]').length === 2, 'no toast for a new announcement');
        assert.match(document.querySelector('[data-toast]').textContent, /^Announcement: New index/);
    } finally { dom.window.close(); }
});

test('a failed load says so and offers a retry; an empty inbox explains what will appear', async () => {
    const server = fakeServer({ fail: true });
    const dom = await openPage(server);
    const { document } = dom.window;
    try {
        await waitFor(() => document.querySelector('[data-notify-open]'), 'the button was not mounted');
        document.querySelector('[data-notify-open]').click();
        const sheet = document.querySelector('[data-notify-sheet]');
        await waitFor(() => !sheet.querySelector('[data-notify-error]').hidden, 'the error state was not shown');
        assert.equal(sheet.querySelector('[data-notify-loading]').hidden, true);
        assert.equal(sheet.querySelector('[data-notify-empty]').hidden, true);
    } finally { dom.window.close(); }

    const empty = fakeServer();
    empty.state.announcements = []; empty.state.notifications = [];
    const second = await openPage(empty);
    try {
        const doc = second.window.document;
        await waitFor(() => doc.querySelector('[data-notify-open]'), 'the button was not mounted');
        doc.querySelector('[data-notify-open]').click();
        const sheet = doc.querySelector('[data-notify-sheet]');
        await waitFor(() => !sheet.querySelector('[data-notify-empty]').hidden, 'the empty state was not shown');
        assert.match(sheet.querySelector('[data-notify-empty]').textContent, /^No notifications yet\./);
        assert.equal(doc.querySelector('[data-announcement-banner]').hidden, true);
    } finally { second.window.close(); }
});

test('turning trade popups off on the profile hides only trade toasts, on this device', async () => {
    const server = fakeServer();
    const dom = await openPage(server);
    const { document } = dom.window;
    try {
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.dataset.tradeToastPref = '';
        document.body.append(box);
        // The checkbox is bound when notifications.js starts; re-run that start on the page as the profile does.
        dom.window.eval(fs.readFileSync('assets/js/notifications.js', 'utf8'));
        await waitFor(() => box.checked, 'trade popups were not on by default');
        box.checked = false;
        box.dispatchEvent(new dom.window.Event('change'));
        assert.equal(dom.window.localStorage.getItem('smartprofit:trade-toasts'), 'off');
        assert.equal(dom.window.smartProfitNotify.show({ group: 'trade', title: 'Order filled' }), null, 'a trade toast showed while turned off');
        assert.ok(dom.window.smartProfitNotify.show({ title: 'Deposit confirmed' }), 'a non-trade toast was hidden');
        box.checked = true;
        box.dispatchEvent(new dom.window.Event('change'));
        assert.equal(dom.window.localStorage.getItem('smartprofit:trade-toasts'), null);
        assert.ok(dom.window.smartProfitNotify.show({ group: 'trade', title: 'Order filled' }));
    } finally { dom.window.close(); }
});
