import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createHash, createHmac, webcrypto } from 'node:crypto';
import { TextEncoder } from 'node:util';
import { JSDOM } from 'jsdom';

const specSeed = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';

function loadVerifier() {
    const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'https://example.test/pages/fairness.html' });
    Object.defineProperty(dom.window, 'crypto', { value: webcrypto });
    dom.window.TextEncoder = TextEncoder;
    const addListener = dom.window.addEventListener;
    dom.window.addEventListener = () => {};
    dom.window.eval(fs.readFileSync('assets/js/fairness.js', 'utf8'));
    dom.window.addEventListener = addListener;
    return dom;
}

test('fairness WebCrypto verifier reproduces the known-answer vectors published in ENGINE_SPEC', async () => {
    const spec = fs.readFileSync('docs/ENGINE_SPEC.md', 'utf8');
    const vectors = [...spec.matchAll(/`(SPI\d+)`, ticks 1-20: `([\d ]+)`/g)].map(([, index, digits]) => ({ index, digits: digits.split(' ').map(Number) }));
    assert.deepEqual(vectors.map((vector) => vector.index), ['SPI10', 'SPI100']);
    const commitment = spec.match(new RegExp(`seed \`${specSeed}\` \\(commitment \`([0-9a-f]{64})\`\\)`))[1];
    const dom = loadVerifier();
    try {
        for (const { index, digits } of vectors) {
            const actual = [];
            for (let tick = 1; tick <= 20; tick++) actual.push(await dom.window.smartProfitFairness.digit(specSeed, 'DEMO', index, tick));
            assert.deepEqual(actual, digits, index);
        }
        assert.equal(await dom.window.smartProfitFairness.digest(Uint8Array.from(specSeed.match(/../g), (pair) => parseInt(pair, 16))), commitment);
    } finally { dom.window.close(); }
});

/* Two consecutive UTC-day epochs with different seeds; ticks 1-20 fall in the
   first and 21-40 in the second. Digits are derived exactly as the engine does. */
const DAY_ONE = Date.parse('2026-09-20T00:00:00Z');
const DAY_TWO = Date.parse('2026-09-21T00:00:00Z');
const seeds = ['11'.repeat(32), '22'.repeat(32)];
const engineDigit = (seed, tick) => { for (let counter = 0; ; counter++) { for (const value of createHmac('sha256', Buffer.from(seed, 'hex')).update(`digit|DEMO|SPI10|${tick}|${counter}`).digest()) if (value < 250) return value % 10; } };
const commit = (seed) => createHash('sha256').update(Buffer.from(seed, 'hex')).digest('hex');

function fixture({ revealSecond = true, tamper = null, purge = [], commitments = seeds.map(commit) } = {}) {
    const ticks = [];
    for (let tick = 1; tick <= 40; tick++) {
        if (purge.includes(tick)) continue;
        const seed = tick <= 20 ? seeds[0] : seeds[1];
        const digit = engineDigit(seed, tick);
        ticks.push({ index_code: 'SPI10', tick_no: tick, scheduled_at: new Date(DAY_TWO + (tick - 21) * 2000).toISOString(), price: '1000.000', digit: tick === tamper ? (digit + 1) % 10 : digit });
    }
    const proofs = [
        { id: 'epoch-two', starts_at: new Date(DAY_TWO).toISOString(), ends_at: new Date(DAY_TWO + 86400000).toISOString(), seed_commitment: commitments[1], revealed_seed: revealSecond ? seeds[1] : null },
        { id: 'epoch-one', starts_at: new Date(DAY_ONE).toISOString(), ends_at: new Date(DAY_TWO).toISOString(), seed_commitment: commitments[0], revealed_seed: seeds[0] },
    ];
    return { ticks, proofs };
}

async function openFairnessPage(data) {
    const dom = new JSDOM(fs.readFileSync('pages/fairness.html', 'utf8'), { runScripts: 'outside-only', url: 'https://example.test/pages/fairness.html' });
    Object.defineProperty(dom.window, 'crypto', { value: webcrypto });
    dom.window.TextEncoder = TextEncoder;
    const calls = [];
    const client = {
        async rpc(name, args) {
            calls.push({ name, args: JSON.parse(JSON.stringify(args)) });
            const limit = Math.min(args.p_limit ?? 100, 500);
            if (name === 'get_recent_ticks') return { data: data.ticks.slice().reverse().slice(0, limit), error: null };
            if (name === 'get_tick_verification_data') return { data: data.ticks.filter((tick) => tick.tick_no > args.p_after_tick_no).slice(0, limit), error: null };
            if (name === 'get_epoch_proofs') return { data: data.proofs, error: null };
            return { data: null, error: { message: 'unexpected' } };
        }
    };
    dom.window.initAccountSwitcher = async () => ({ client, config: { indices: [{ code: 'SPI10', display_name: 'SmartProfit Index 10' }] } });
    dom.window.smartProfitAccount = { get: () => ({ accountId: 'practice-id', mode: 'DEMO', currency: 'USD' }) };
    const document = dom.window.document;
    const form = document.querySelector('[data-fairness-form]');
    // Browsers expose form controls by name on the form element; jsdom does not.
    for (const control of form.elements) if (control.name && !(control.name in form)) Object.defineProperty(form, control.name, { get: () => form.elements.namedItem(control.name) });
    assert.equal(document.readyState, 'loading');
    dom.window.eval(fs.readFileSync('assets/js/fairness.js', 'utf8'));
    await waitFor(() => form.index.options.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    return {
        dom, form, calls,
        async verify(from, to) {
            form.from.value = String(from);
            form.to.value = String(to);
            const output = document.querySelector('[data-fairness-result]');
            output.textContent = '';
            form.dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
            await waitFor(() => output.textContent && output.textContent !== 'Verifying…');
            return { text: output.textContent, epochs: [...document.querySelectorAll('[data-fairness-epochs] li')].map((item) => item.textContent) };
        }
    };
}

async function waitFor(predicate, timeout = 3000) {
    const started = Date.now();
    while (!predicate()) {
        if (Date.now() - started > timeout) assert.fail('condition was not reached');
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

test('the verifier defaults to the latest 20 ticks of the chosen index', async () => {
    const page = await openFairnessPage(fixture());
    try {
        assert.deepEqual(page.calls.find((call) => call.name === 'get_recent_ticks').args, { p_index: 'SPI10', p_limit: 1 });
        assert.equal(page.form.from.value, '21');
        assert.equal(page.form.to.value, '40');
    } finally { page.dom.window.close(); }
});

test('honest ticks spanning two epochs verify against each epoch seed with no mismatches', async () => {
    const page = await openFairnessPage(fixture({ purge: [5] }));
    try {
        const result = await page.verify(1, 40);
        assert.match(result.text, /Ticks 1–40: 39 verified, 0 mismatches/);
        assert.match(result.text, /1 not available/);
        assert.match(result.text, /Commitments: 2 of 2 revealed epochs match/);
        assert.equal(result.epochs.length, 2);
        assert.match(result.epochs[0], /2026-09-20 \(19 ticks\): commitment matches, 19 verified, 0 mismatches/);
        assert.match(result.epochs[1], /2026-09-21 \(20 ticks\): commitment matches, 20 verified, 0 mismatches/);
    } finally { page.dom.window.close(); }
});

test('unified-price ticks verify their price, final digit, and previous-tick continuity', async () => {
    const verifier = loadVerifier();
    let price = '1000.000';
    const ticks = [];
    try {
        for (let tick = 1; tick <= 6; tick++) {
            const generated = await verifier.window.smartProfitFairness.priceV2(seeds[0], 'DEMO', 'SPI10', tick, price, '1000', '.0002', '.003', 3);
            ticks.push({ index_code: 'SPI10', tick_no: tick, scheduled_at: new Date(DAY_ONE + tick * 2000).toISOString(),
                price: generated.price, digit: generated.digit, generation_version: 2, previous_price: price,
                generation_base_price: '1000', generation_sigma: '.0002', generation_kappa: '.003', generation_decimals: 3 });
            price = generated.price;
        }
    } finally { verifier.window.close(); }
    const proofs = [{ id: 'epoch-one', starts_at: new Date(DAY_ONE).toISOString(), ends_at: new Date(DAY_TWO).toISOString(), seed_commitment: commit(seeds[0]), revealed_seed: seeds[0] }];
    const page = await openFairnessPage({ ticks, proofs });
    try {
        assert.match((await page.verify(1, 6)).text, /6 verified, 0 mismatches/);
        ticks[2].price = '1000.999';
        const tampered = await page.verify(1, 6);
        assert.match(tampered.text, /4 verified, 2 mismatches/);
        assert.match(tampered.text, /Mismatched ticks: 3, 4/);
    } finally { page.dom.window.close(); }
});

test('one tampered digit is reported as exactly one mismatch', async () => {
    const page = await openFairnessPage(fixture({ tamper: 12 }));
    try {
        const result = await page.verify(1, 40);
        assert.match(result.text, /39 verified, 1 mismatches/);
        assert.match(result.text, /Mismatched ticks: 12\./);
    } finally { page.dom.window.close(); }
});

test('ticks of an unrevealed epoch are not yet verifiable rather than mismatches', async () => {
    const page = await openFairnessPage(fixture({ revealSecond: false }));
    try {
        const result = await page.verify(11, 30);
        assert.match(result.text, /Ticks 11–30: 10 verified, 0 mismatches; 10 not yet verifiable/);
        assert.match(result.text, /Commitments: 1 of 1 revealed epochs match/);
        assert.match(result.epochs[1], /not revealed yet, not yet verifiable/);
    } finally { page.dom.window.close(); }
});

test('each epoch seed is checked against its own commitment', async () => {
    const page = await openFairnessPage(fixture({ commitments: [commit(seeds[0]), commit(seeds[0])] }));
    try {
        const result = await page.verify(1, 40);
        assert.match(result.text, /Commitments: 1 of 2 revealed epochs match/);
        assert.match(result.epochs[0], /commitment matches/);
        assert.match(result.epochs[1], /commitment does not match/);
    } finally { page.dom.window.close(); }
});
