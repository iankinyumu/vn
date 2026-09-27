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
            if (name === 'get_account_summary') return { data: { available: balances[args.p_account_id] ?? 0, currency: 'USD' }, error: null };
            if (name === 'engine_quote_contract') return { data: { payout: '19.30', profit: '9.30', win_probability: 0.5 }, error: null };
            if (name === 'engine_buy_contract') { balances[args.p_account_id] -= args.p_stake; return { data: { id: 'contract-1' }, error: null }; }
            return { data: null, error: null };
        }
    };
    const balances = { 'practice-id': 10000, 'second-id': 2500 };
    return { client, calls, channels, ticks, add, balances, tickChannel: () => channels.filter((channel) => channel.topic.startsWith('ticks:')).at(-1) };
}

const defaultConfig = () => ({ indices: [{ code: 'SPI10', display_name: 'SmartProfit Index 10', interval_ms: INTERVAL, decimals: 3 }, { code: 'SPI25', display_name: 'SmartProfit Index 25', interval_ms: INTERVAL, decimals: 3 }], enabled_contract_types: ['EVEN', 'ODD'] });

async function openTradePage(server, query = '', { config = defaultConfig(), refreshedConfig = null, account = { accountId: 'practice-id', mode: 'DEMO', currency: 'USD' } } = {}) {
    const html = fs.readFileSync('pages/trade.html', 'utf8');
    const dom = new JSDOM(html, { runScripts: 'outside-only', url: `https://example.test/pages/trade.html${query}` });
    Object.defineProperty(dom.window, 'crypto', { value: webcrypto });
    const drawn = [];
    const chartOptions = [];
    dom.window.drawIndexChart = (_canvas, ticks, options) => { drawn.push(ticks.map((tick) => tick.tick_no)); chartOptions.push(options); };
    dom.window.refreshRestrictionBanner = async () => {};
    let active = account;
    dom.window.smartProfitAccount = { get: () => ({ ...active }) };
    dom.window.initAccountSwitcher = async () => ({ client: server.client, config });
    dom.window.loadEngineConfig = async () => ({ client: server.client, config: refreshedConfig || config });
    dom.window.smartProfitTradeOptions = { configRetryMs: 30 };
    const document = dom.window.document;
    // Browsers expose form controls by name on the form, including controls
    // associated through a form="" attribute (the index picker). jsdom does not.
    const form = document.querySelector('[data-trade-form]');
    for (const control of form.elements) if (control.name && !(control.name in form)) Object.defineProperty(form, control.name, { get: () => form.elements.namedItem(control.name) });
    assert.equal(document.readyState, 'loading', 'trade.js must be installed before jsdom fires DOMContentLoaded');
    let balanceReads = 0;
    document.addEventListener('smartprofit:balance-changed', () => balanceReads++);
    dom.window.eval(fs.readFileSync('assets/js/shell.js', 'utf8'));
    dom.window.eval(fs.readFileSync('assets/js/trade.js', 'utf8'));
    return {
        dom, drawn, chartOptions, document,
        held: () => drawn.at(-1) || [],
        // The first side of the selected contract family (Even, Matches or Over).
        buy: () => document.querySelector('[data-side="a"]'),
        side: (type) => document.querySelector(`[data-side][data-type="${type}"]`),
        feedState: () => document.querySelector('[data-feed-state]').textContent,
        broadcast: (tick) => server.tickChannel().handlers.find((item) => item.type === 'broadcast').handler({ payload: tick }),
        status: () => document.querySelector('[data-trade-status]').textContent,
        balanceReads: () => balanceReads,
        highlighted: () => [...document.querySelectorAll('[data-digits] .current')].map((node) => node.dataset.digit),
        switchAccount(next) { active = next; document.dispatchEvent(new dom.window.Event('smartprofit:clear-trade-state')); document.dispatchEvent(new dom.window.CustomEvent('smartprofit:account-changed')); },
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

async function goLive(server, page) {
    await waitFor(() => server.tickChannel(), 'no tick channel was opened');
    server.tickChannel().status('SUBSCRIBED');
    await waitFor(() => page.feedState() === 'Live', 'the feed never went live');
}
// The quote debounce can outlast this test feed's stale window, so a fresh tick is delivered before buying.
async function freshTick(server, page) {
    server.add(server.ticks.length + 1);
    page.broadcast(server.ticks.at(-1));
    await waitFor(() => page.feedState() === 'Live', 'the feed did not return to live');
}
const setStake = (page, value) => { const stake = page.document.querySelector('input[name="stake"]'); stake.value = value; stake.dispatchEvent(new page.dom.window.Event('input', { bubbles: true })); };
const choose = (page, name, value) => { const input = page.document.querySelector(`input[name="${name}"][value="${value}"]`); input.checked = true; input.dispatchEvent(new page.dom.window.Event('change', { bubbles: true })); };
const allTypes = () => ({ ...defaultConfig(), enabled_contract_types: ['EVEN', 'ODD', 'MATCH', 'DIFFER', 'OVER', 'UNDER'] });

test('contract families come from the enabled types, each side shows its own payout, and a side buys its own type', async () => {
    const server = fakeServer(20);
    const page = await openTradePage(server);
    try {
        await goLive(server, page);
        const { document } = page;
        assert.deepEqual([...document.querySelectorAll('.family-tab')].map((tab) => tab.textContent), ['Even / Odd'], 'only families with an enabled type are offered');
        assert.deepEqual([...document.querySelectorAll('[data-side]')].map((side) => side.querySelector('[data-side-label]').textContent), ['Even', 'Odd']);
        assert.equal(document.querySelector('[data-families]').hidden, true, 'a single family is shown without tabs');
        assert.equal(document.querySelector('[data-barrier-row]').hidden, true, 'Even / Odd needs no digit');
        assert.equal(document.querySelector('select[name="type"], [data-quote]'), null, 'the old single contract selector is gone');
        setStake(page, '10');
        await waitFor(() => ['EVEN', 'ODD'].every((type) => server.calls.some((call) => call.name === 'engine_quote_contract' && call.args.p_type === type && call.args.p_stake === 10)), 'both sides were not quoted');
        await waitFor(() => page.side('ODD').querySelector('[data-side-payout]').textContent === '$19.30', 'the payout was not shown on the side');
        await freshTick(server, page);
        const before = page.balanceReads();
        page.side('ODD').click();
        await waitFor(() => server.calls.some((call) => call.name === 'engine_buy_contract'), 'no purchase was sent');
        const bought = server.calls.find((call) => call.name === 'engine_buy_contract').args;
        assert.equal(bought.p_type, 'ODD');
        assert.equal(bought.p_barrier, null);
        assert.equal(bought.p_stake, 10);
        assert.equal(bought.p_tick_count, 1);
        await waitFor(() => page.balanceReads() > before, 'the purchase did not ask for the balance to be re-read');
        await waitFor(() => /^Odd bought · exit tick #/.test(page.status()), 'the purchase was not confirmed');
        // A completed purchase retires its idempotency key, so the same contract can be bought again.
        await freshTick(server, page);
        page.side('ODD').click();
        await waitFor(() => server.calls.filter((call) => call.name === 'engine_buy_contract').length === 2, 'the second purchase was not sent');
        const keys = server.calls.filter((call) => call.name === 'engine_buy_contract').map((call) => call.args.p_idempotency_key);
        assert.notEqual(keys[0], keys[1]);
        await waitFor(() => page.document.querySelector('[data-side][data-busy]') === null && page.balanceReads() > before + 1, 'the second purchase did not finish');
    } finally { page.dom.window.close(); }
});

test('barrier families pick a digit, colour the digits around it, and never offer a barrier that cannot win', async () => {
    const server = fakeServer(20);
    const page = await openTradePage(server, '', { config: allTypes() });
    try {
        await goLive(server, page);
        const { document } = page;
        assert.deepEqual([...document.querySelectorAll('.family-tab')].map((tab) => tab.textContent), ['Even / Odd', 'Matches / Differs', 'Over / Under']);
        assert.equal(document.querySelector('[data-families]').hidden, false);
        choose(page, 'family', 'overunder');
        assert.equal(document.querySelector('[data-barrier-row]').hidden, false);
        assert.deepEqual([...document.querySelectorAll('[data-side]')].map((side) => side.dataset.type), ['OVER', 'UNDER']);
        choose(page, 'barrier', 9);
        const zones = () => [...document.querySelectorAll('[data-digits] .digit')].map((node) => node.dataset.zone || '');
        assert.deepEqual(zones(), ['below', 'below', 'below', 'below', 'below', 'below', 'below', 'below', 'below', 'barrier']);
        await freshTick(server, page);
        assert.equal(page.side('OVER').disabled, true, 'Over 9 cannot win');
        assert.equal(page.side('UNDER').disabled, false);
        page.side('UNDER').click();
        await waitFor(() => server.calls.some((call) => call.name === 'engine_buy_contract'), 'no purchase was sent');
        assert.equal(server.calls.find((call) => call.name === 'engine_buy_contract').args.p_type, 'UNDER');
        assert.equal(server.calls.find((call) => call.name === 'engine_buy_contract').args.p_barrier, 9);
        await waitFor(() => /^Under 9 bought/.test(page.status()), 'the purchase did not finish');
        choose(page, 'family', 'matchdiffer');
        choose(page, 'barrier', 4);
        assert.deepEqual(zones(), ['', '', '', '', 'barrier', '', '', '', '', '']);
        choose(page, 'family', 'evenodd');
        assert.deepEqual(zones(), Array(10).fill(''));
    } finally { page.dom.window.close(); }
});

test('the stake steps by the account minimum within its limits, and tick chips set the duration', async () => {
    const server = fakeServer(20);
    const config = { ...defaultConfig(), accounts: [{ id: 'practice-id', limits: { min_stake: 0.35, max_stake: 1 } }] };
    const page = await openTradePage(server, '', { config });
    try {
        await goLive(server, page);
        const stake = page.document.querySelector('input[name="stake"]');
        assert.equal(stake.min, '0.35');
        assert.equal(stake.max, '1');
        const step = (direction) => page.document.querySelector(`[data-stake-step="${direction}"]`).click();
        setStake(page, '0.35');
        step(1); assert.equal(stake.value, '0.70');
        step(1); step(1); assert.equal(stake.value, '1.00', 'the stake passed the maximum');
        step(-1); step(-1); step(-1); step(-1); assert.equal(stake.value, '0.35', 'the stake went below the minimum');
        choose(page, 'ticks', 7);
        await freshTick(server, page);
        page.buy().click();
        await waitFor(() => server.calls.some((call) => call.name === 'engine_buy_contract'), 'no purchase was sent');
        assert.equal(server.calls.find((call) => call.name === 'engine_buy_contract').args.p_tick_count, 7);
        assert.equal(server.calls.find((call) => call.name === 'engine_buy_contract').args.p_stake, 0.35);
        await waitFor(() => /bought/.test(page.status()), 'the purchase did not finish');
    } finally { page.dom.window.close(); }
});

test('with no enabled contract types the page says so and nothing is buyable even on a live feed', async () => {
    const server = fakeServer(20);
    const page = await openTradePage(server, '', { config: { ...defaultConfig(), enabled_contract_types: [] } });
    try {
        await goLive(server, page);
        assert.equal(page.document.querySelector('[data-families]').hidden, true);
        assert.match(page.status(), /No contract types are enabled right now/);
        assert.ok([...page.document.querySelectorAll('[data-side]')].every((side) => side.disabled));
        page.buy().click();
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(server.calls.some((call) => call.name === 'engine_buy_contract'), false);
    } finally { page.dom.window.close(); }
});

test('an empty index configuration is reported as unavailable and recovers when indices return', async () => {
    const server = fakeServer(20);
    const page = await openTradePage(server, '', { config: { indices: [], enabled_contract_types: ['EVEN', 'ODD'] }, refreshedConfig: defaultConfig() });
    try {
        await waitFor(() => page.feedState() === 'Unavailable', 'an empty configuration was not reported');
        assert.match(page.status(), /No indices are open for trading right now/);
        assert.equal(page.buy().disabled, true);
        const index = page.document.querySelector('select[name="index"]');
        assert.ok([...index.options].every((option) => option.value === ''), 'no index is invented');
        assert.equal(index.disabled, true);
        assert.equal(server.calls.some((call) => call.name === 'get_recent_ticks'), false);
        await waitFor(() => server.tickChannel()?.topic === 'ticks:demo:SPI10', 'the page did not recover when indices returned');
        assert.equal(page.status(), '');
        await goLive(server, page);
        assert.equal(page.buy().disabled, false);
    } finally { page.dom.window.close(); }
});

test('an index with no published ticks says so, keeps Buy disabled, and goes live when ticks arrive', async () => {
    const server = fakeServer(0);
    const page = await openTradePage(server);
    try {
        await waitFor(() => page.feedState() === 'No ticks yet', 'the empty feed was not reported');
        assert.equal(page.document.querySelector('[data-live-price]').textContent, 'No ticks yet');
        assert.equal(page.buy().disabled, true);
        server.tickChannel().status('CHANNEL_ERROR');
        assert.equal(page.feedState(), 'No ticks yet', 'an empty feed is not presented as reconnecting');
        server.add(5);
        await waitFor(() => page.held().at(-1) === 5, 'polling never picked up the first ticks');
        await waitFor(() => page.feedState() === 'Live · polling' && !page.buy().disabled, 'the feed did not recover');
    } finally { page.dom.window.close(); }
});

test('the balance lives in the top bar: purchases and settlements ask it to be re-read, and the page shows none of its own', async () => {
    const server = fakeServer(20);
    const page = await openTradePage(server);
    try {
        assert.equal(page.document.querySelector('[data-trade-balance], .trade-balance'), null);
        assert.ok(page.document.querySelector('.app-topbar [data-account-switcher]'), 'the top bar mode switch was not mounted');
        await goLive(server, page);
        const contractChannel = () => server.channels.filter((channel) => channel.topic === 'contracts:practice-id').at(-1);
        await waitFor(() => contractChannel(), 'the contract change channel was never opened');
        const beforeSettlement = page.balanceReads();
        contractChannel().handlers.find((item) => item.type === 'postgres_changes').handler({ eventType: 'UPDATE' });
        await waitFor(() => page.balanceReads() > beforeSettlement, 'a settlement did not ask for the balance to be re-read');
    } finally { page.dom.window.close(); }
});

test('settlements show one dismissible win or loss popup and a readable net result in history', async () => {
    const server = fakeServer(20);
    const rpc = server.client.rpc.bind(server.client);
    let rows = [];
    server.client.rpc = async (name, args) => name === 'list_my_contracts' ? { data: args.p_account_id === 'practice-id' ? rows : [], error: null } : rpc(name, args);
    const page = await openTradePage(server);
    try {
        await goLive(server, page);
        const text = (selector) => page.document.querySelector(selector).textContent;
        const contractChannel = () => server.channels.filter((channel) => channel.topic === 'contracts:practice-id').at(-1);
        await waitFor(() => contractChannel(), 'the contract channel was not opened');
        const update = () => contractChannel().handlers.find((item) => item.type === 'postgres_changes').handler({ eventType: 'UPDATE' });
        const first = { id: 'won-1', index_code: 'SPI10', contract_type: 'EVEN', barrier: null, stake: '10', payout: '19.30', entry_tick_no: 21, settle_tick_no: 25, state: 'OPEN', exit_digit: null };
        rows = [first]; update();
        await waitFor(() => text('[data-open-contracts]').includes('$19.30'), 'the open trade was not tracked');
        assert.match(text('[data-open-contracts]'), /SPI10 · Even/);
        assert.equal(text('[data-open-count]'), '1');
        assert.match(text('[data-active-trade]'), /^Even · 5 ticks left$/);
        assert.equal(page.document.querySelectorAll('.trade-toast').length, 0, 'an open trade was announced as a result');
        rows = [{ ...first, state: 'WON', exit_digit: 2 }]; update();
        await waitFor(() => page.document.querySelector('.trade-toast-won'), 'the win popup was not shown');
        assert.match(text('.trade-toast-won'), /^Won \+\$9\.30SPI10 · Even · digit 2/);
        assert.match(text('[data-settled-contracts]'), /\+\$9\.30Won · digit 2/);
        assert.equal(page.document.querySelector('[data-active-trade]').hidden, true, 'a settled trade stayed active on the chart');
        update(); await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(page.document.querySelectorAll('.trade-toast').length, 1, 'the same settlement was announced twice');

        const second = { ...first, id: 'lost-2', contract_type: 'ODD', stake: '7', payout: '13.51', state: 'OPEN' };
        rows = [second, ...rows]; update();
        await waitFor(() => text('[data-open-contracts]').includes('$7.00'), 'the second trade was not tracked');
        assert.match(text('[data-active-trade]'), /^Odd/);
        rows = [{ ...second, state: 'LOST', exit_digit: 4 }, ...rows.slice(1)]; update();
        await waitFor(() => page.document.querySelector('.trade-toast-lost'), 'the loss popup was not shown');
        assert.match(text('.trade-toast-lost'), /^Lost −\$7\.00/);
        assert.match(text('[data-settled-contracts]'), /−\$7\.00Lost · digit 4/);
        assert.equal(page.document.querySelector('[data-active-trade]').hidden, true, 'a lost trade stayed active on the chart');
        page.document.querySelector('.trade-toast-lost button').click();
        assert.equal(page.document.querySelector('.trade-toast-lost'), null, 'the popup could not be dismissed');
        page.switchAccount({ accountId: 'second-id', mode: 'DEMO', currency: 'USD' });
        assert.equal(page.document.querySelectorAll('.trade-toast').length, 0, 'the old account notification remained visible');
        assert.equal(page.document.querySelector('[data-active-trade]').hidden, true, 'the old account trade remained on the chart');
        await waitFor(() => text('[data-settled-contracts]').includes('No settled trades yet'), 'old account results remained visible');
        await waitFor(() => server.channels.some((channel) => channel.topic === 'contracts:second-id'), 'the new account subscription did not finish');
    } finally { page.dom.window.close(); }
});

test('the session take profit and stop loss only stop the customer buying, and a new session resumes', async () => {
    const server = fakeServer(20);
    const rpc = server.client.rpc.bind(server.client);
    let rows = [];
    server.client.rpc = async (name, args) => {
        if (name === 'engine_buy_contract') { const id = `c-${rows.length}`; rows = [{ id, index_code: 'SPI10', contract_type: args.p_type, barrier: null, stake: String(args.p_stake), payout: '19.30', entry_tick_no: 21, settle_tick_no: 22, state: 'OPEN', exit_digit: null }, ...rows]; return { data: { id, settle_tick_no: 22 }, error: null }; }
        if (name === 'list_my_contracts') return { data: rows, error: null };
        return rpc(name, args);
    };
    const page = await openTradePage(server);
    try {
        await goLive(server, page);
        const text = (selector) => page.document.querySelector(selector).textContent;
        const guard = page.document.querySelector('[data-session-guard]');
        const takeProfit = page.document.querySelector('[data-take-profit]');
        takeProfit.value = '5';
        takeProfit.dispatchEvent(new page.dom.window.Event('input', { bubbles: true }));
        setStake(page, '10');
        await freshTick(server, page);
        page.buy().click();
        await waitFor(() => rows.length === 1, 'no purchase was sent');
        assert.equal(guard.hidden, true, 'an open trade tripped the guard');
        rows = rows.map((row) => ({ ...row, state: 'WON', exit_digit: 2 }));
        const contractChannel = () => server.channels.filter((channel) => channel.topic === 'contracts:practice-id').at(-1);
        contractChannel().handlers.find((item) => item.type === 'postgres_changes').handler({ eventType: 'UPDATE' });
        await waitFor(() => !guard.hidden, 'the take profit was not reached');
        assert.equal(text('[data-session-net]'), '+$9.30');
        assert.equal(text('[data-session-count]'), '1W · 0L');
        assert.equal(text('[data-session-guard-text]'), 'Take profit reached at +$9.30.');
        await freshTick(server, page);
        assert.ok([...page.document.querySelectorAll('[data-side]')].every((side) => side.disabled), 'buying stayed open after the take profit');
        assert.equal(server.calls.filter((call) => call.name === 'engine_buy_contract').length, 0, 'the guard placed a trade');
        page.document.querySelector('[data-session-resume]').click();
        assert.equal(guard.hidden, true);
        assert.equal(text('[data-session-net]'), '$0.00');
        assert.equal(page.buy().disabled, false, 'a new session did not reopen buying');
    } finally { page.dom.window.close(); }
});

// Text a sighted customer sees: everything except visually hidden and hidden elements.
function visibleText(document) {
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll('.visually-hidden, [hidden], script').forEach((node) => node.remove());
    return clone.textContent;
}

test('the trade page carries no ribbon or explanatory copy, and keeps the feed state and restriction notice', async () => {
    const server = fakeServer(20);
    const page = await openTradePage(server);
    try {
        await goLive(server, page);
        const { document } = page;
        assert.equal(document.querySelector('.practice-ribbon, [data-practice-ribbon]'), null);
        assert.doesNotMatch(document.documentElement.outerHTML, /Trade digit contracts|Order ticket|Set up your contract|Live results|equally likely|Choose contract details/);
        assert.doesNotMatch(visibleText(document), /Practice · virtual funds|Practice mode/);
        assert.ok(document.querySelector('[data-restriction-banner]'), 'the restriction notice mount was removed');
        assert.equal(page.feedState(), 'Live');
    } finally { page.dom.window.close(); }
});

test('the digit strip shows 0 through 9 once with frequencies, marks only the latest digit and is not a live region', async () => {
    const server = fakeServer(23);
    const page = await openTradePage(server);
    try {
        const { document } = page;
        const row = document.querySelector('[data-digits]');
        const digits = () => [...row.querySelectorAll('.digit')].map((node) => node.dataset.digit);
        assert.deepEqual(digits(), ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
        assert.equal(row.getAttribute('role'), 'group');
        assert.equal(row.getAttribute('aria-label'), 'Last digit');
        assert.deepEqual(page.highlighted(), []);

        await waitFor(() => page.held().at(-1) === 23, 'initial ticks did not load');
        await waitFor(() => page.highlighted().length === 1, 'the latest digit was not highlighted');
        assert.deepEqual(page.highlighted(), ['3']);
        assert.equal(row.querySelector('[aria-current="true"]').dataset.digit, '3');
        assert.equal(row.querySelectorAll('[aria-current]').length, 1);
        assert.equal(row.querySelector('[data-digit-pointer]').hidden, false, 'the pointer was not shown');
        // Ticks 1-23: digits 1, 2 and 3 appear three times, the rest twice.
        const pct = (digit) => row.querySelector(`[data-digit="${digit}"] .digit-pct`).textContent;
        assert.equal(pct(3), '13%');
        assert.equal(pct(0), '9%');
        assert.deepEqual([...row.querySelectorAll('.digit.hot')].map((node) => node.dataset.digit), ['1', '2', '3']);
        assert.equal(row.querySelectorAll('.digit.cold').length, 7);
        const description = document.getElementById(row.getAttribute('aria-describedby'));
        assert.equal(description.textContent, 'Latest digit: 3');
        assert.equal(description.closest('[aria-live]:not([aria-live="off"])'), null, 'the current digit must not be a live region');
        assert.equal(row.closest('[aria-live]:not([aria-live="off"])'), null, 'the digit row must not be a live region');

        await goLive(server, page);
        server.add(24);
        page.broadcast(server.ticks[23]);
        await waitFor(() => page.highlighted()[0] === '4', 'the highlight did not follow the latest tick');
        assert.deepEqual(digits(), ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'], 'the row must stay stable');
        assert.equal(page.highlighted().length, 1);
        assert.equal(row.querySelector('[data-digit-pointer]').dataset.direction, 'up');
        assert.equal(description.textContent, 'Latest digit: 4');
    } finally { page.dom.window.close(); }
});

test('bursts of ticks are drawn in coalesced frames that always end on the latest tick, with a bounded chart window', async () => {
    const server = fakeServer(40);
    const page = await openTradePage(server);
    try {
        await waitFor(() => page.held().at(-1) === 40, 'initial ticks did not load');
        await goLive(server, page);
        const drawsBefore = page.drawn.length;
        server.add(90);
        for (let tick = 41; tick <= 90; tick++) page.broadcast(server.ticks[tick - 1]);
        await waitFor(() => page.held().at(-1) === 90, 'the latest tick was not drawn');
        await new Promise((resolve) => setTimeout(resolve, 40));
        const draws = page.drawn.length - drawsBefore;
        assert.ok(draws >= 1 && draws < 50, `50 ticks produced ${draws} redraws`);
        assert.equal(page.held().at(-1), 90);
        assert.ok(contiguous(page.held()), 'the drawn buffer has a gap');
        assert.equal(page.held().length, 90, 'the chart must receive the full buffer so the window is applied from the latest tick');
        // The options object comes from the jsdom realm; copy it so deepEqual compares values, not prototypes.
        assert.deepEqual({ ...page.chartOptions.at(-1) }, { window: 300, markLatest: true, decimals: 3, pointer: null, directionColors: true });
        assert.equal(page.document.querySelector('[data-live-price]').textContent, '1000.090');
        assert.equal(page.document.querySelector('[data-live-price] .price-last').textContent, '0');
        assert.equal(page.document.querySelector('[data-price-direction]').dataset.direction, 'up');
        assert.equal(page.document.querySelector('[data-price-direction]').textContent, '▲ 0.001');
        assert.deepEqual(page.highlighted(), ['0']);
        server.add(91);
        server.ticks[90].price = '999.000';
        page.broadcast(server.ticks[90]);
        await waitFor(() => page.document.querySelector('[data-price-direction]').dataset.direction === 'down', 'a falling price was not labelled');
        assert.equal(page.document.querySelector('[data-price-direction]').textContent, '▼ 1.090');
    } finally { page.dom.window.close(); }
});

test('switching index clears the old chart and never draws a pending frame from the previous index', async () => {
    const server = fakeServer(30);
    const page = await openTradePage(server);
    try {
        await waitFor(() => page.held().at(-1) === 30, 'initial ticks did not load');
        await goLive(server, page);
        // Note how many draws had happened when the new index's first tick read completed.
        let drawsWhenNewIndexLoaded = null;
        const rpc = server.client.rpc.bind(server.client);
        server.client.rpc = async (name, args) => { const result = await rpc(name, args); if (name === 'get_ticks_since' && args.p_index === 'SPI25' && drawsWhenNewIndexLoaded === null) drawsWhenNewIndexLoaded = page.drawn.length; return result; };
        server.add(31);
        // Deliver a tick and let the feed accept it, so a frame is pending for the old index when it switches.
        page.broadcast(server.ticks[30]);
        await new Promise((resolve) => setTimeout(resolve, 0));
        const index = page.document.querySelector('select[name="index"]');
        index.value = 'SPI25';
        index.dispatchEvent(new page.dom.window.Event('change', { bubbles: true }));
        const switchedAt = page.drawn.length;
        // The drawn array comes from the jsdom realm; copy it so deepEqual compares values, not prototypes.
        assert.deepEqual([...page.drawn.at(-1)], [], 'the old chart was not cleared on switch');
        assert.deepEqual(page.highlighted(), [], 'the old digit stayed highlighted after the switch');
        await waitFor(() => page.drawn.length > switchedAt, 'the new index was never drawn');
        assert.ok(drawsWhenNewIndexLoaded !== null && drawsWhenNewIndexLoaded === switchedAt, 'a frame from the previous index was drawn after the switch');
        assert.equal(page.held().at(-1), 31);
        assert.deepEqual(page.highlighted(), ['1']);
    } finally { page.dom.window.close(); }
});

test('the chart crosshair follows the pointer with chart-only redraws and clears when the pointer leaves', async () => {
    const server = fakeServer(20);
    const page = await openTradePage(server);
    try {
        await waitFor(() => page.held().at(-1) === 20, 'initial ticks did not load');
        await goLive(server, page);
        const canvas = page.document.querySelector('[data-index-chart]');
        const label = page.document.querySelector('[data-live-price]').firstChild;
        const drawsBefore = page.drawn.length;
        for (let x = 10; x <= 50; x += 10) canvas.dispatchEvent(new page.dom.window.MouseEvent('pointermove', { clientX: x, clientY: 40 }));
        await waitFor(() => page.chartOptions.at(-1).pointer?.x === 50, 'the crosshair did not follow the pointer');
        assert.deepEqual({ ...page.chartOptions.at(-1).pointer }, { x: 50, y: 40 });
        assert.ok(page.drawn.length - drawsBefore < 5, 'pointer moves were not coalesced into frames');
        assert.equal(page.document.querySelector('[data-live-price]').firstChild, label, 'a pointer move re-rendered the market');
        assert.equal(page.held().at(-1), 20, 'the crosshair redraw lost the latest tick');
        canvas.dispatchEvent(new page.dom.window.MouseEvent('pointerleave'));
        await waitFor(() => page.chartOptions.at(-1).pointer === null, 'the crosshair stayed after the pointer left');
    } finally { page.dom.window.close(); }
});

test('a startup failure is explained on the trade page and leaves nothing buyable', async () => {
    const dom = new JSDOM(fs.readFileSync('pages/trade.html', 'utf8'), { runScripts: 'outside-only', url: 'https://example.test/pages/trade.html' });
    Object.defineProperty(dom.window, 'crypto', { value: webcrypto });
    dom.window.console.error = () => {};
    const responses = { get_engine_config: { data: defaultConfig() }, enroll_practice_account: { data: null, error: { code: '42501', message: 'permission denied for function enroll_practice_account' }, status: 403 } };
    dom.window.getSupabaseClient = async () => ({ rpc: async (name) => ({ data: null, error: null, ...(responses[name] || {}) }) });
    const document = dom.window.document;
    for (const file of ['shell.js', 'account-context.js', 'account-keys.js', 'account-switcher.js', 'trade.js']) dom.window.eval(fs.readFileSync(`assets/js/${file}`, 'utf8'));
    try {
        await waitFor(() => document.querySelector('[data-feed-state]').textContent === 'Unavailable', 'the startup failure was not shown');
        assert.equal(document.querySelector('[data-trade-status]').textContent, 'Your Practice account could not be opened. Reload the page; if this continues, contact support.');
        assert.ok([...document.querySelectorAll('[data-side]')].every((side) => side.disabled));
        assert.equal(document.querySelector('select[name="index"]').disabled, true);
        assert.equal(document.querySelector('.mode-switch-toggle').disabled, true);
        assert.doesNotMatch(document.body.textContent, /permission denied|42501|Reference:/);
    } finally { dom.window.close(); }
});

test('an announced price model change is shown for the selected index until it takes effect', async () => {
    const future = new Date(Date.UTC(2099, 0, 2)).toISOString();
    const config = defaultConfig();
    config.indices[0].v2_starts_at = future;
    config.indices[1].v2_starts_at = new Date(Date.UTC(2020, 0, 2)).toISOString();
    const server = fakeServer(5);
    const page = await openTradePage(server, '', { config });
    try {
        const note = () => page.document.querySelector('[data-price-model-note]');
        await waitFor(() => note() && !note().hidden, 'the scheduled change was not announced');
        assert.equal(note().textContent, 'From Fri, 02 Jan 2099 00:00:00 UTC, SmartProfit Index 10 moves to price model version 2.');
        const index = page.document.querySelector('select[name="index"]');
        index.value = 'SPI25';
        index.dispatchEvent(new page.dom.window.Event('change', { bubbles: true }));
        await waitFor(() => note().hidden, 'a change that already took effect is still announced');
        await waitFor(() => server.calls.some((call) => call.name === 'channel' && call.topic === 'ticks:demo:SPI25'), 'the new index was not subscribed');
    } finally { page.dom.window.close(); }
});
