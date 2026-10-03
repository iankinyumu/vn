// Proof export format v2 and the shared verifier: configuration rotation,
// cutover genesis, checkpoint anchors, epoch boundaries, missing history, a
// one-field mutation matrix, the CLI trust policy and exit codes, and
// CLI/in-process verdict parity (production fix brief §3).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as g from '../engine/v3/generator.mjs';
import { trustFromDocuments } from '../verifier/v3/trust.mjs';
import { summarize, verifyPackage, witnessDeadline as verifierDeadline } from '../verifier/v3/verify.mjs';
import { issueTestToken } from './helpers/test-tsa.mjs';
import { BOUNDARY, DAY, anchorAt, buildFixture, rehashTick, writeTrustBundle } from './helpers/v3-fixtures.mjs';

const verify = (fixture, pkg = fixture.pkg, trust = fixture.trust) => verifyPackage(pkg, trust);
const rotation = () => buildFixture({ rotations: [[BOUNDARY, { '*': { kappa_e12: 400000n } }]], ticks: 40 });

test('a range crossing a UTC epoch boundary and a configuration change verifies fully in one package', async () => {
    const fixture = rotation();
    assert.equal(Object.keys(fixture.pkg.configs).length, 2);
    assert.equal(new Set(fixture.pkg.ticks.map((t) => t.epoch_start_ms)).size, 2);
    const result = await verify(fixture);
    assert.equal(result.verdict, 'fully_verified', JSON.stringify(result.issues.slice(0, 3)));
    assert.deepEqual(result.components, { price_continuity: 'verified', signatures: 'valid', witness: 'witnessed', checkpoints: 'witnessed', reveal: 'revealed', contracts: 'verified' });
});

test('cutover: a series whose genesis is the last tick before the boundary verifies from genesis + 1', async () => {
    const genesis = (BOUNDARY - 1n - (BOUNDARY - 41_000n)) / 2000n; // last tick before the boundary
    const fixture = buildFixture({ genesis, ticks: 20 });
    assert.equal(fixture.pkg.ticks[0].tick_no, String(genesis + 1n));
    const cutoverEpoch = fixture.pkg.epochs.find((e) => e.epoch_start_ms === String(BOUNDARY));
    assert.equal(cutoverEpoch.witness_deadline_ms, String(BOUNDARY + 1000n), 'deadline is the first v3 tick after genesis');
    assert.equal((await verify(fixture)).verdict, 'fully_verified');
});

test('the witness deadline agrees between the generator and the independent verifier', () => {
    for (const genesis of [0n, 20n, 5000n]) {
        const config = g.defaultConfig({ t0Ms: BOUNDARY - 41_000n, genesisTickNo: genesis });
        const entries = config.indices.map((e) => ({ t0: BigInt(e.t0_ms), interval: BigInt(e.tick_interval_ms), genesisTick: BigInt(e.genesis_tick_no) }));
        for (const start of [BOUNDARY - DAY, BOUNDARY, BOUNDARY + DAY]) assert.equal(verifierDeadline(entries, start), g.witnessDeadline(config, start), `genesis ${genesis} epoch ${start}`);
    }
});

test('a range starting at a signed, witnessed checkpoint is anchored; an unwitnessed or unsigned anchor is not', async () => {
    const fixture = rotation();
    const anchored = anchorAt(fixture.pkg, 'SPI10', 20);
    const good = await verify(fixture, anchored);
    assert.equal(good.verdict, 'fully_verified', JSON.stringify(good.issues.slice(0, 3)));
    assert.equal(good.anchored.SPI10, true);
    const unwitnessed = structuredClone(anchored); unwitnessed.anchors.SPI10.checkpoint.witness = [];
    const r1 = await verify(fixture, unwitnessed);
    assert.equal(r1.verdict, 'partial'); assert.equal(r1.anchored.SPI10, false); assert.equal(r1.components.price_continuity, 'unanchored');
    const unsigned = structuredClone(anchored); delete unsigned.anchors.SPI10.checkpoint.signature;
    assert.equal((await verify(fixture, unsigned)).components.price_continuity, 'unanchored');
});

test('missing predecessor history is partial, never verified', async () => {
    const fixture = rotation();
    const cut = structuredClone(fixture.pkg); cut.ticks = cut.ticks.slice(5);
    const result = await verify(fixture, cut);
    assert.equal(result.verdict, 'partial');
    assert.equal(result.components.price_continuity, 'unanchored');
    assert.ok(result.states.includes('missing_history'));
});

test('one-field mutations each produce a specific failing state', async () => {
    const fixture = rotation();
    const last = (p) => p.ticks.at(-1);
    const cases = {
        price: [(p) => { const t = last(p); t.price_units = String(BigInt(t.price_units) + 10n); rehashTick(p, t); }, 'price_mismatch'],
        digit: [(p) => { const t = last(p); t.digit = String((Number(t.digit) + 1) % 10); rehashTick(p, t); }, 'digit_mismatch'],
        config: [(p) => { const [k] = Object.keys(p.configs); p.configs[k].indices[0].sigma_e12 = String(BigInt(p.configs[k].indices[0].sigma_e12) + 1n); }, 'invalid_config'],
        signature: [(p) => { const e = p.epochs[0]; e.signature = (parseInt(e.signature.slice(0, 2), 16) ^ 1).toString(16).padStart(2, '0') + e.signature.slice(2); }, 'invalid_signature'],
        token: [(p) => { const w = p.epochs[1].witness[0]; const b = Buffer.from(w.token, 'base64'); b[b.length - 20] ^= 1; w.token = b.toString('base64'); }, 'invalid_witness'],
        timestamp: [(p) => { const t = p.ticks[10]; t.scheduled_ms = String(BigInt(t.scheduled_ms) + 2000n); rehashTick(p, t); }, 'invalid_config'],
        anchor: [(p) => { Object.assign(p, anchorAt(p, 'SPI10', 20)); p.anchors.SPI10.tick.price_units = String(BigInt(p.anchors.SPI10.tick.price_units) + 10n); }, 'broken_continuity'],
        sequence: [(p) => { p.ticks.splice(12, 1); }, 'broken_continuity'],
        'contract linkage': [(p) => { p.contracts[0].exit_digit = (p.contracts[0].exit_digit + 1) % 10; }, 'contract_mismatch'],
        commitment: [(p) => { p.epochs[1].prev_commitment = '00'.repeat(32); }, 'invalid_commitment'],
    };
    for (const [name, [mutate, state]] of Object.entries(cases)) {
        const pkg = structuredClone(fixture.pkg);
        mutate(pkg);
        const result = await verify(fixture, pkg);
        assert.ok(result.states.includes(state), `${name}: expected ${state}, got ${result.states.join(',')}`);
        assert.equal(result.verdict, 'invalid', `${name} must be invalid`);
    }
});

test('late, missing and unpinned evidence is partial and says which component is incomplete', async () => {
    const fixture = rotation();
    const late = structuredClone(fixture.pkg);
    const e = late.epochs[1];
    e.witness = e.witness.map((w) => ({ ...w, token: Buffer.from(issueTestToken(Buffer.from(e.commitment, 'hex'), Number(BigInt(e.witness_deadline_ms) + 1000n))).toString('base64') }));
    const r1 = await verify(fixture, late);
    assert.equal(r1.components.witness, 'late'); assert.equal(r1.verdict, 'partial');
    const missing = structuredClone(fixture.pkg); missing.epochs[1].witness = missing.epochs[1].witness.filter((w) => w.provider !== 'sectigo');
    assert.equal((await verify(fixture, missing)).components.witness, 'missing');
    assert.equal((await verify(fixture, fixture.pkg, { ...fixture.trust, trustedKeys: null })).components.signatures, 'unpinned');
    assert.equal((await verify(fixture, fixture.pkg, { ...fixture.trust, tsaRoots: {} })).components.witness, 'unwitnessed');
    const hidden = structuredClone(fixture.pkg); for (const epoch of hidden.epochs) epoch.revealed_seed = null;
    const r2 = await verify(fixture, hidden);
    assert.equal(r2.components.reveal, 'not_yet_revealable'); assert.equal(r2.verdict, 'partial');
    assert.equal(summarize(r2), 'partial');
});

test('the CLI loads the published trust by default, labels test trust, and exits 0/2/1/64', async () => {
    const fixture = rotation();
    const dir = mkdtempSync(join(tmpdir(), 'v3-cli-'));
    const good = join(dir, 'good.json'), bad = join(dir, 'bad.json'), trustDir = join(dir, 'trust');
    writeFileSync(good, JSON.stringify(fixture.pkg));
    const tampered = structuredClone(fixture.pkg); tampered.ticks.splice(3, 1); writeFileSync(bad, JSON.stringify(tampered));
    writeTrustBundle(trustDir, fixture);
    const cli = (...args) => spawnSync(process.execPath, ['verifier/v3/cli.mjs', ...args], { encoding: 'utf8' });
    const published = cli(good, '--json');
    // Published trust: the fixture key is not pinned (unpinned) and test-TSA tokens do not chain to the pinned roots (invalid).
    assert.equal(published.status, 1, 'untrusted receipts are invalid, never verified');
    const publishedResult = JSON.parse(published.stdout);
    assert.equal(publishedResult.trust, 'published');
    assert.equal(publishedResult.components.signatures, 'unpinned');
    assert.equal(publishedResult.components.witness, 'invalid');
    const withTest = cli(good, '--trust-dir', trustDir, '--allow-test-trust');
    assert.equal(withTest.status, 0, withTest.stdout);
    assert.match(withTest.stdout, /TEST TRUST BUNDLE/);
    assert.match(withTest.stdout, /FULLY VERIFIED/);
    assert.equal(cli(bad, '--trust-dir', trustDir, '--allow-test-trust').status, 1);
    assert.equal(cli(good, '--trust-dir', trustDir).status, 64, 'override requires --allow-test-trust');
    const prod = join(dir, 'prod.json'); writeFileSync(prod, JSON.stringify({ ...fixture.pkg, env: 'production' }));
    assert.equal(cli(prod, '--trust-dir', trustDir, '--allow-test-trust').status, 64, 'no test trust for production packages');
    assert.equal(cli().status, 64);

    // Same package + same trust documents => identical normalised verdict in-process (the browser path) and via the CLI.
    const docs = { keys: JSON.parse(readFileSync(join(trustDir, 'trusted-keys.json'), 'utf8')), roots: JSON.parse(readFileSync(join(trustDir, 'tsa-roots.json'), 'utf8')) };
    for (const file of [good, bad]) {
        const inProcess = await verifyPackage(JSON.parse(readFileSync(file, 'utf8')), trustFromDocuments(docs.keys, docs.roots));
        const viaCli = JSON.parse(cli(file, '--json', '--trust-dir', trustDir, '--allow-test-trust').stdout);
        assert.deepEqual({ verdict: viaCli.verdict, components: viaCli.components, states: viaCli.states }, { verdict: inProcess.verdict, components: inProcess.components, states: inProcess.states });
    }
});
