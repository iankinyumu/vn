import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { webcrypto } from 'node:crypto';
import { JSDOM } from 'jsdom';

const INTERVAL = 25;

/* A server-shaped fake: get_recent_ticks is newest-first, get_ticks_since is
   oldest-first after a tick number, and both return at most 500 rows. */
function fakeServer(count) {
    const ticks = [];
    const add = (upTo) => { for (let n = ticks.length + 1; n <= upTo; n++) ticks.push({ index_code: 'SPI10', tick_no: n, scheduled_at: new Date(n * 2000).toISOString(), price: (1000 + n / 1000).toFixed(3), digit: n % 10 }); };
    add(count);
    const calls = [];
    const channels = [];
    const client = {
        realtime: { setAuth: async () => { calls.push({ name: 'setAuth' }); } },
        channel(topic, options) {
            const channel = { topic, options, handlers: [], status: null, on(type, filter, handler) { this.handlers.push({ type, filter, handler }); return this; }, subscribe(callback) { this.status = callback; return this; } };
            calls.push({ name: 'channel', topic, options: JSON.parse(JSON.stringify(options ?? null)) });
            channels.push(channel);
            return channel;
        },
        removeChannel: async (channel) => { calls.push({ name: 'removeChannel', topic: channel.topic }); return 'ok'; },
        async rpc(name, args) {
            calls.push({ name, args: JSON.parse(JSON.stringify(args ?? null)) });
            const limit = Math.min(Math.max(args?.p_limit ?? 100, 1), 500);
            if (name === 'get_recent_ticks') return { data: ticks.slice().reverse().slice(0, limit), error: null };
            if (name === 'get_ticks_since') return { data: ticks.filter((tick) => tick.tick_no > (args.p_after_tick_no ?? 0)).slice(0, limit), error: null };
            if (name === 'list_my_contracts') return { data: [], error: null };
            return { data: null, error: null };
        }
    };
    return { client, calls, channels, ticks, add, tickChannel: () => channels.filter((channel) => channel.topic.startsWith('ticks:')).at(-1) };
}

async function openTradePage(server, query = '') {
    const html = fs.readFileSync('pages/trade.html', 'utf8');
    const dom = new JSDOM(html, { runScripts: 'outside-only', url: `https://example.test/pages/trade.html${query}` });
    Object.defineProperty(dom.window, 'crypto', { value: webcrypto });
    const drawn = [];
    dom.window.drawIndexChart = (_canvas, ticks) => drawn.push(ticks.map((tick) => tick.tick_no));
    dom.window.refreshRestrictionBanner = async () => {};
    dom.window.smartProfitAccount = { get: () => ({ accountId: 'practice-id', mode: 'DEMO', currency: 'USD' }) };
    dom.window.initAccountSwitcher = async () => ({ client: server.client, config: { indices: [{ code: 'SPI10', display_name: 'SmartProfit Index 10', interval_ms: INTERVAL, decimals: 3 }, { code: 'SPI25', display_name: 'SmartProfit Index 25', interval_ms: INTERVAL, decimals: 3 }], enabled_contract_types: ['EVEN', 'ODD'] } });
    const document = dom.window.document;
    // Browsers expose form controls by name on the form, including controls
    // associated through a form="" attribute (the index picker). jsdom does not.
    const form = document.querySelector('[data-trade-form]');
    for (const control of form.elements) if (control.name && !(control.name in form)) Object.defineProperty(form, control.name, { get: () => form.elements.namedItem(control.name) });
    assert.equal(document.readyState, 'loading', 'trade.js must be installed before jsdom fires DOMContentLoaded');
    dom.window.eval(fs.readFileSync('assets/js/trade.js', 'utf8'));
    return {
        dom, drawn, document,
        held: () => drawn.at(-1) || [],
        buy: () => document.querySelector('[data-trade-form] [type="submit"]'),
        feedState: () => document.querySelector('[data-feed-state]').textContent,
        broadcast: (tick) => server.tickChannel().handlers.find((item) => item.type === 'broadcast').handler({ payload: tick }),
    };
}

async function waitFor(predicate, message, timeout = 2000) {
    const started = Date.now();
    while (!predicate()) {
        if (Date.now() - started > timeout) assert.fail(message);
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

const contiguous = (numbers) => numbers.every((value, position) => position === 0 || value === numbers[position - 1] + 1);

test('a dashboard link opens the trade page on the requested index, and an unknown index keeps the first', async () => {
    for (const [query, expected] of [['?index=SPI25', 'SPI25'], ['?index=NOPE', 'SPI10']]) {
        const server = fakeServer(5);
        const page = await openTradePage(server, query);
        try {
            await waitFor(() => server.tickChannel(), 'no tick channel was opened');
            assert.equal(page.document.querySelector('select[name="index"]').value, expected);
            assert.equal(server.tickChannel().topic, `ticks:demo:${expected}`);
        } finally { page.dom.window.close(); }
    }
});

test('tick channel is private, authorised before joining, and removed when the index changes', async () => {
    const server = fakeServer(30);
    const page = await openTradePage(server);
    try {
        await waitFor(() => server.tickChannel(), 'no tick channel was opened');
        const auth = server.calls.findIndex((call) => call.name === 'setAuth');
        const join = server.calls.findIndex((call) => call.name === 'channel' && call.topic === 'ticks:demo:SPI10');
        assert.ok(auth >= 0, 'client.realtime.setAuth() was never called');
        assert.ok(auth < join, 'setAuth must run before the private channel is created');
        assert.deepEqual(server.calls[join].options, { config: { private: true } });
        assert.ok(server.tickChannel().handlers.some((item) => item.type === 'broadcast' && item.filter.event === 'tick'));

        const index = page.document.querySelector('select[name="index"]');
        index.value = 'SPI25';
        index.dispatchEvent(new page.dom.window.Event('change'));
        await waitFor(() => server.calls.some((call) => call.name === 'channel' && call.topic === 'ticks:demo:SPI25'), 'the new index was not subscribed');
        assert.ok(server.calls.some((call) => call.name === 'removeChannel' && call.topic === 'ticks:demo:SPI10'), 'the old tick channel was not removed');
    } finally { page.dom.window.close(); }
});

test('initial load pages the newest 1000 ticks instead of the oldest 500', async () => {
    const server = fakeServer(2600);
    const page = await openTradePage(server);
    try {
        await waitFor(() => page.held().at(-1) === 2600, 'the chart never reached the newest tick');
        const held = page.held();
        assert.equal(held.length, 1000);
        assert.equal(held[0], 1601);
        assert.ok(contiguous(held));
        const reads = server.calls.filter((call) => call.name === 'get_recent_ticks' || call.name === 'get_ticks_since');
        assert.deepEqual(reads[0], { name: 'get_recent_ticks', args: { p_index: 'SPI10', p_limit: 1 } });
        assert.deepEqual(reads.slice(1, 4).map((call) => call.args.p_after_tick_no), [1600, 2100, 2600]);
        assert.ok(reads.every((call) => call.args.p_limit <= 500));
    } finally { page.dom.window.close(); }
});

test('broadcast ticks append in order, gaps reconcile page by page, and repeats are ignored', async () => {
    const server = fakeServer(40);
    const page = await openTradePage(server);
    try {
        await waitFor(() => page.held().at(-1) === 40 && server.tickChannel(), 'initial ticks did not load');
        server.tickChannel().status('SUBSCRIBED');
        server.add(41);
        page.broadcast(server.ticks[40]);
        await waitFor(() => page.held().at(-1) === 41, 'the next tick was not appended');
        const drawsBefore = page.drawn.length;
        page.broadcast(server.ticks[40]);
        page.broadcast(server.ticks[20]);
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(page.drawn.length, drawsBefore, 'a repeated or old tick changed the feed');

        server.add(741);
        page.broadcast(server.ticks[740]);
        await waitFor(() => page.held().at(-1) === 741, 'a jump was not reconciled');
        const held = page.held();
        assert.equal(held.length, 741);
        assert.equal(new Set(held).size, held.length, 'duplicate ticks were kept');
        assert.ok(contiguous(held), 'the reconciled feed has a gap');
        const reconcile = server.calls.filter((call) => call.name === 'get_ticks_since' && call.args.p_after_tick_no >= 41).map((call) => call.args.p_after_tick_no);
        assert.deepEqual(reconcile.slice(0, 2), [41, 541]);
    } finally { page.dom.window.close(); }
});

test('a feed that is not subscribed goes stale, then polling recovers the chart and the Buy button', async () => {
    const server = fakeServer(10);
    const page = await openTradePage(server);
    try {
        await waitFor(() => server.tickChannel(), 'no tick channel was opened');
        server.tickChannel().status('CHANNEL_ERROR');
        await waitFor(() => page.buy().disabled && page.feedState() === 'Reconnecting', 'Buy was not locked after three silent intervals');
        server.add(15);
        await waitFor(() => page.held().at(-1) === 15, 'polling never fetched the missed ticks');
        await waitFor(() => !page.buy().disabled, 'Buy did not recover after polling delivered ticks');
        assert.notEqual(page.feedState(), 'Reconnecting');
        assert.ok(contiguous(page.held()));

        server.tickChannel().status('SUBSCRIBED');
        await waitFor(() => page.feedState() === 'Live', 'the feed did not report Live once subscribed');
        const polls = server.calls.filter((call) => call.name === 'get_ticks_since').length;
        await new Promise((resolve) => setTimeout(resolve, INTERVAL * 2));
        assert.ok(server.calls.filter((call) => call.name === 'get_ticks_since').length <= polls + 1, 'polling continued while subscribed and fresh');
    } finally { page.dom.window.close(); }
});
