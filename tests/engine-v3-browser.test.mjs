// Real-browser checks (production fix brief §4) of the built static site in
// Microsoft Edge via playwright-core. The only substitute is the supabase-js
// bundle, replaced by tests/browser/fake-supabase.js, so no test touches a real
// backend. Set BROWSER_EVIDENCE=1 to write screenshots and a run log to
// docs/browser-checks/.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import { anchorAt, buildFixture, rehashTick, writeTrustBundle } from './helpers/v3-fixtures.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist');
const EVIDENCE = process.env.BROWSER_EVIDENCE === '1' ? join(ROOT, 'docs', 'browser-checks') : null;
const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const log = [];

let server, base, browser, fixture, trustDir;
const account = { id: '11111111-1111-4111-8111-111111111111', execution_mode: 'DEMO', status: 'ACTIVE', currency: 'USD' };
const indices = [{ code: 'SPI50', display_name: 'SmartProfit Index 50', interval_ms: 2000, decimals: 3 }];
const recentTicks = (count = 30) => Array.from({ length: count }, (_, i) => ({ index_code: 'SPI50', tick_no: 1000 - i, scheduled_at: new Date(Date.now() - i * 2000).toISOString(), price: (10000 + i / 10).toFixed(3), digit: i % 10 }));
const v3Status = (overrides = {}) => [{ index_code: 'SPI50', execution_mode: 'DEMO', engine_generation: 3, shadow: false, halted: false, v2_final_tick_no: 900, purchase_block: null,
    volatility_1d: { window_ticks: 1800, target_annual: 0.5, observed_annual: 0.4987, relative_error: -0.0026, status: 'insufficient_data' }, ...overrides }];
function fakeRpc(overrides = {}) {
    return {
        get_engine_config: { ledger_asset: 'USD', real_enabled: false, indices, enabled_contract_types: ['EVEN', 'ODD'], accounts: [{ ...account, limits: { min_stake: 1, max_stake: 1000 } }] },
        enroll_practice_account: account.id, list_my_accounts: [account], get_my_active_restrictions: [],
        get_account_summary: { currency: 'USD', available: 9990, reserved: 10 }, get_account_stats: { wins: 1, losses: 0, voids: 0, open: 1, net_result: 9.3, currency: 'USD' },
        get_recent_ticks: recentTicks(), get_ticks_since: [], get_epoch_proofs: [], get_tick_verification_data: [],
        list_my_contracts: [
            { id: 'c-open', index_code: 'SPI50', contract_type: 'EVEN', barrier: null, stake: 10, payout: 19.3, state: 'OPEN', entry_tick_no: 1001, settle_tick_no: 1003, created_at: new Date().toISOString() },
            { id: 'c-v2', index_code: 'SPI50', contract_type: 'ODD', barrier: null, stake: 10, payout: 19.3, state: 'WON', entry_tick_no: 880, settle_tick_no: 882, exit_digit: 7, created_at: new Date(Date.now() - 86400000).toISOString() },
        ],
        engine_quote_contract: { payout: 19.3, profit: 9.3, win_probability: 0.5 },
        get_engine_v3_status: v3Status(), get_v3_proof_package: fixture.pkg, ...overrides,
    };
}

async function openPage(path, { rpc = fakeRpc(), testTrust = true, viewport = { width: 1280, height: 900 }, init = null, offline = false } = {}) {
    const context = await browser.newContext({ viewport, acceptDownloads: true });
    const errors = [], failed = [];
    await context.route('**/@supabase/supabase-js@2/dist/umd/supabase.js', (route) => route.fulfill({ contentType: 'text/javascript', body: readFileSync(join(ROOT, 'tests/browser/fake-supabase.js'), 'utf8') }));
    await context.route(/^https:\/\/(cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)\//, async (route) => { try { await route.fulfill({ response: await route.fetch() }); } catch { await route.fulfill({ status: 200, body: '' }); } });
    if (testTrust) {
        await context.route('**/verifier/v3/trusted-keys.json', (route) => route.fulfill({ contentType: 'application/json', body: readFileSync(join(trustDir, 'trusted-keys.json')) }));
        await context.route('**/verifier/v3/tsa-roots.json', (route) => route.fulfill({ contentType: 'application/json', body: readFileSync(join(trustDir, 'tsa-roots.json')) }));
    }
    await context.addInitScript({ content: `window.__FAKE__ = { rpc: ${JSON.stringify(rpc)} };` });
    if (init) await context.addInitScript({ content: init });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
    page.on('requestfailed', (request) => { if (request.url().startsWith(base)) failed.push(request.url()); });
    await page.goto(`${base}/${path}`);
    if (offline) await context.setOffline(true);
    return { page, context, errors, failed };
}
const shot = async (page, name) => { if (EVIDENCE) await page.screenshot({ path: join(EVIDENCE, `${name}.png`), fullPage: true }); };
const record = (name, detail) => log.push({ name, ...detail });
const verifyNow = async (page) => {
    await page.locator('[data-fairness-v3] button[type="submit"]').click();
    await page.waitForFunction(() => !document.querySelector('[data-fairness-v3]').hasAttribute('aria-busy') && !/Checking the proof/.test(document.querySelector('[data-fairness-v3-result]').textContent));
    return page.locator('[data-fairness-v3-result]').textContent();
};
const cli = (file, ...args) => spawnSync(process.execPath, ['verifier/v3/cli.mjs', file, '--json', ...args], { cwd: ROOT, encoding: 'utf8' });

before(async () => {
    assert.ok(EDGE, 'Microsoft Edge is required for the real-browser checks');
    execFileSync(process.execPath, ['scripts/build-static.mjs'], { cwd: ROOT });
    fixture = buildFixture({ rotations: [[1_790_380_800_000n, { '*': { kappa_e12: 400000n } }]], ticks: 40, indices: ['SPI50'] });
    trustDir = mkdtempSync(join(tmpdir(), 'v3-browser-trust-'));
    writeTrustBundle(trustDir, fixture);
    server = createServer((req, res) => {
        const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^[/\\]+/, '');
        const file = join(DIST, path || 'index.html');
        if (!file.startsWith(DIST) || !existsSync(file)) { res.writeHead(404).end(); return; }
        res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' }).end(readFileSync(file));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ executablePath: EDGE, headless: true });
    if (EVIDENCE) mkdirSync(EVIDENCE, { recursive: true });
});
after(async () => {
    if (EVIDENCE) writeFileSync(join(EVIDENCE, 'browser-check-log.json'), `${JSON.stringify({ browser: `Microsoft Edge ${browser.version()}`, generated_at: new Date().toISOString(),
        commit: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim(), served: 'dist/ over http://127.0.0.1', backend: 'tests/browser/fake-supabase.js', checks: log }, null, 2)}\n`);
    await browser?.close();
    server?.close();
});

test('fairness: a valid package verifies fully in the browser, the download is the exact package, and the CLI agrees', async () => {
    const { page, context, errors, failed } = await openPage('fairness.html');
    await page.locator('[data-fairness-v3]').waitFor({ state: 'visible' });
    assert.equal(await page.inputValue('#fairness-v3-to'), '1000', 'range defaults to the latest ticks');
    const text = await verifyNow(page);
    assert.match(text, /^Fully verified:/);
    assert.equal(await page.getAttribute('[data-fairness-v3]', 'data-verdict'), 'fully_verified');
    const details = await page.locator('[data-fairness-v3-details] li').allTextContents();
    assert.ok(details.some((d) => /2 model configurations/.test(d)) && details.some((d) => /digicert, sectigo/.test(d)) && details.some((d) => /fixture-key-1/.test(d)) && details.some((d) => /genesis/.test(d)));
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('[data-fairness-v3-download]').click()]);
    const saved = join(trustDir, 'downloaded.json');
    await download.saveAs(saved);
    assert.deepEqual(JSON.parse(readFileSync(saved, 'utf8')), fixture.pkg, 'the download is the package that was checked');
    const viaCli = cli(saved, '--trust-dir', trustDir, '--allow-test-trust');
    assert.equal(viaCli.status, 0);
    assert.equal(JSON.parse(viaCli.stdout).verdict, 'fully_verified', 'browser and CLI agree');
    assert.deepEqual(errors, []); assert.deepEqual(failed, []);
    await shot(page, 'fairness-v3-verified-desktop');
    record('fairness verified + download + CLI parity', { ui: 'fully_verified', cli: 'fully_verified', errors: errors.length });
    await context.close();
});

test('fairness: tampered and untrusted packages are invalid in the browser and in the CLI', async () => {
    const tampered = structuredClone(fixture.pkg); const t = tampered.ticks.at(-1); t.price_units = String(BigInt(t.price_units) + 10n); rehashTick(tampered, t);
    const { page, context } = await openPage('fairness.html', { rpc: fakeRpc({ get_v3_proof_package: tampered }) });
    assert.match(await verifyNow(page), /^Invalid:/);
    assert.ok((await page.locator('[data-fairness-v3-lines] li').allTextContents()).some((l) => /Price mismatch/.test(l)));
    await shot(page, 'fairness-v3-invalid');
    const file = join(trustDir, 'tampered.json'); writeFileSync(file, JSON.stringify(tampered));
    assert.equal(cli(file, '--trust-dir', trustDir, '--allow-test-trust').status, 1);
    await context.close();
    // Published trust (no override): test keys are unpinned and test receipts do not chain to DigiCert/Sectigo.
    const published = await openPage('fairness.html', { testTrust: false });
    assert.match(await verifyNow(published.page), /^Invalid:/);
    const good = join(trustDir, 'good.json'); writeFileSync(good, JSON.stringify(fixture.pkg));
    const viaCli = JSON.parse(cli(good).stdout);
    assert.equal(await published.page.getAttribute('[data-fairness-v3]', 'data-verdict'), viaCli.verdict, 'same verdict with the published trust bundle');
    record('fairness tampered/published trust', { ui: 'invalid', cli: viaCli.verdict });
    await published.context.close();
});

test('fairness: every non-verdict state has its own message', async () => {
    const cases = [
        ['no data', { rpc: fakeRpc({ get_v3_proof_package: { __error: 'not_found' } }) }, /No version 3 ticks/],
        ['network', { rpc: fakeRpc({ get_v3_proof_package: { __error: 'Failed to fetch' } }) }, /could not be downloaded/],
        ['unsupported', { init: `const real = crypto.subtle.importKey.bind(crypto.subtle); crypto.subtle.importKey = (f, k, a, ...r) => (a && a.name === 'Ed25519') ? Promise.reject(new Error('NotSupportedError')) : real(f, k, a, ...r);` }, /lacks Ed25519 signature support/],
        ['stale feed', { rpc: fakeRpc({ get_engine_v3_status: v3Status({ purchase_block: 'feed_stale' }) }) }, null],
        ['missing history', { rpc: fakeRpc({ get_v3_proof_package: { ...fixture.pkg, ticks: fixture.pkg.ticks.slice(5), contracts: [] } }) }, /^Partial:/],
    ];
    for (const [name, options, expected] of cases) {
        const { page, context, errors } = await openPage('fairness.html', options);
        await page.locator('[data-fairness-v3]').waitFor({ state: 'visible' });
        if (name === 'unsupported') assert.match(await page.locator('[data-fairness-v3-result]').textContent(), expected);
        else if (name === 'stale feed') assert.match(await page.locator('[data-fairness-v3-note]').textContent(), /Live prices are delayed/);
        else assert.match(await verifyNow(page), expected, name);
        if (name === 'missing history') assert.ok((await page.locator('[data-fairness-v3-lines] li').allTextContents()).some((l) => /not anchored/.test(l)));
        assert.ok(!errors.some((e) => e.startsWith('pageerror')), `${name}: ${errors.join(' | ')}`);
        record(`fairness state: ${name}`, { ok: true });
        await context.close();
    }
    const { page, context } = await openPage('fairness.html');
    await page.locator('[data-fairness-v3]').waitFor({ state: 'visible' });
    await page.fill('#fairness-v3-from', '1'); await page.fill('#fairness-v3-to', '9000');
    assert.match(await verifyNow(page), /at most 5,000 ticks/);
    await page.fill('#fairness-v3-from', '50'); await page.fill('#fairness-v3-to', '10');
    assert.match(await verifyNow(page), /first tick of at least 1/);
    await page.fill('#fairness-v3-to', '60');
    await context.setOffline(true);
    assert.match(await verifyNow(page), /appear to be offline/);
    await context.setOffline(false);
    await page.evaluate(() => { URL.createObjectURL = () => { throw new Error('blocked'); }; });
    await verifyNow(page);
    await page.locator('[data-fairness-v3-download]').click();
    assert.match(await page.locator('[data-fairness-v3-result]').textContent(), /could not be saved/);
    record('fairness states: too large, bad range, offline, download failure', { ok: true });
    await context.close();
});

test('fairness: keyboard-only use, live announcements, and no horizontal scroll on a phone', async () => {
    const { page, context } = await openPage('fairness.html', { viewport: { width: 390, height: 844 } });
    await page.locator('[data-fairness-v3]').waitFor({ state: 'visible' });
    await page.focus('#fairness-v3-index');
    const order = [];
    for (let i = 0; i < 3; i++) { await page.keyboard.press('Tab'); order.push(await page.evaluate(() => document.activeElement.id || document.activeElement.textContent.trim())); }
    assert.deepEqual(order, ['fairness-v3-from', 'fairness-v3-to', 'Verify range']);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => /^Fully verified:/.test(document.querySelector('[data-fairness-v3-result]').textContent));
    assert.equal(await page.getAttribute('[data-fairness-v3-result]', 'aria-live'), 'polite');
    for (const id of ['fairness-v3-index', 'fairness-v3-from', 'fairness-v3-to']) assert.equal(await page.locator(`label[for="${id}"]`).count(), 1, `${id} has a label`);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no horizontal scroll at 390 px');
    await shot(page, 'fairness-v3-verified-mobile');
    record('fairness keyboard + mobile', { tabOrder: order });
    await context.close();
});

test('fairness: the v3 panel stays hidden while no index is on version 3', async () => {
    const { page, context } = await openPage('fairness.html', { rpc: fakeRpc({ get_engine_v3_status: v3Status({ engine_generation: 2 }) }) });
    await page.waitForTimeout(1500);
    assert.equal(await page.locator('[data-fairness-v3]').isVisible(), false);
    await context.close();
});

test('trade: a closed v3 gate disables Buy with an explanation; contracts show generation and fixed ticks', async () => {
    const live = { __liveTicks: { origin: 1000 - Math.floor(Date.now() / 2000) } };
    const { page, context, errors } = await openPage('trade.html', { rpc: fakeRpc({ get_engine_v3_status: v3Status({ purchase_block: 'engine_unwitnessed' }), get_recent_ticks: live, get_ticks_since: live }) });
    const note = page.locator('[data-v3-gate]');
    await note.waitFor({ state: 'visible' });
    assert.match(await note.textContent(), /independently timestamped/);
    assert.equal(await page.locator('[data-trade-form] button[type="submit"], form button[type="submit"]').first().isDisabled(), true);
    await page.waitForFunction(() => document.querySelectorAll('.contract-ticks').length >= 2); // contracts load after the gate
    const rows = await page.locator('.contract-ticks').allTextContents();
    assert.ok(rows.includes('v3 · ticks #1001 → #1003') && rows.includes('v2 · ticks #880 → #882'), rows.join(' | '));
    await shot(page, 'trade-v3-gate-closed');
    // Gate opens: Buy becomes available; a server-side refusal is reported and nothing is shown as bought.
    await page.evaluate((status) => { window.__FAKE__.rpc.get_engine_v3_status = status; window.__FAKE__.rpc.engine_buy_contract = { __error: 'engine_unwitnessed' }; }, v3Status());
    await page.waitForFunction(() => document.querySelector('[data-v3-gate]').hidden, null, { timeout: 15000 });
    const buy = page.locator('form button[type="submit"]').first();
    await page.waitForFunction(() => !document.querySelector('form button[type="submit"]').disabled, null, { timeout: 10000 });
    await page.fill('#trade-form [name="stake"]', '10'); // the form requires a stake, as for a customer
    await buy.click();
    await page.waitForFunction(() => /independently timestamped/.test(document.querySelector('[data-trade-status]').textContent));
    assert.doesNotMatch(await page.locator('[data-trade-status]').textContent(), /purchased/i);
    assert.ok(!errors.some((e) => e.startsWith('pageerror')), errors.join(' | '));
    record('trade gate + contract ticks', { closedReason: 'engine_unwitnessed', rows });
    await context.close();
});

test('dashboard: observed volatility names its window, sample size and target, and is not a forecast', async () => {
    const { page, context, errors } = await openPage('dashboard.html');
    const panel = page.locator('[data-v3-volatility]');
    await panel.waitFor({ state: 'visible', timeout: 15000 });
    const text = await panel.textContent();
    assert.match(text, /SPI50: 49\.87% a year, observed over the last 1,800 ticks \(about 1\.0 h\); target 50\.00%/);
    assert.match(text, /not future prices or digits/);
    assert.doesNotMatch(text, /guarantee|will be|predict/i);
    assert.ok(!errors.some((e) => e.startsWith('pageerror')), errors.join(' | '));
    await shot(page, 'dashboard-v3-volatility');
    record('dashboard volatility labels', { text: text.replace(/\s+/g, ' ').trim() });
    await context.close();
});

test('the anchored package from a checkpoint verifies in the browser too', async () => {
    const anchored = anchorAt(fixture.pkg, 'SPI50', 20);
    const { page, context } = await openPage('fairness.html', { rpc: fakeRpc({ get_v3_proof_package: anchored }) });
    assert.match(await verifyNow(page), /^Fully verified:/);
    assert.ok((await page.locator('[data-fairness-v3-details] li').allTextContents()).some((d) => /Starts from signed checkpoint at tick #20/.test(d)));
    await context.close();
});
