import assert from 'node:assert/strict';
import { hkdfSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as g from '../engine/v3/generator.mjs';
import * as v from '../verifier/v3/verify.mjs';
import { buildVectors } from '../scripts/engine-v3-vectors.mjs';

const vectors = JSON.parse(readFileSync(new URL('../engine/v3/vectors.json', import.meta.url), 'utf8'));
const DAY = 86_400_000n;

test('v3 generator still reproduces the frozen vectors byte for byte', () => {
    assert.deepEqual(buildVectors(), vectors);
});

test('both HKDF implementations match RFC 5869 test case 1', async () => {
    const c = vectors.rfc5869_case1;
    const node = Buffer.from(hkdfSync('sha256', Buffer.from(c.ikm, 'hex'), Buffer.from(c.salt, 'hex'), Buffer.from(c.info, 'hex'), 42)).subarray(0, 32);
    assert.equal(node.toString('hex'), c.okm_first_32);
    assert.equal(v.toHex(await v.hkdf32(v.fromHex(c.salt), v.fromHex(c.ikm), v.fromHex(c.info))), c.okm_first_32);
});

test('canonical encodings cover zero and maximum counters', () => {
    assert.equal(vectors.encoding.tick_msg_zero, '00047469636b' + '00'.repeat(12));
    assert.equal(vectors.encoding.tick_msg_max, '00047469636b' + 'ff'.repeat(12));
    assert.equal(vectors.encoding.label_spi10, '000553504931' + '30');
    assert.throws(() => g.tickMessage(1n << 64n, 0), /engine_v3_integer_out_of_range/);
    assert.throws(() => g.tickMessage(0, 1n << 32n), /engine_v3_integer_out_of_range/);
    assert.throws(() => g.tickMessage(-1n, 0), /engine_v3_integer_out_of_range/);
    for (const bad of ['', 'SPI 10', 'SPI|10', 'Ｓ', 'x'.repeat(65)]) assert.throws(() => g.str(bad), /engine_v3_label_invalid/);
});

test('both implementations derive sigma_e12 from annual volatility identically', () => {
    for (const [index, sigma] of Object.entries(vectors.sigma_e12)) {
        assert.equal(g.sigmaE12(g.ANNUAL_VOL_BP[index], 2000).toString(), sigma);
        assert.equal(v.perTickSigma(g.ANNUAL_VOL_BP[index], 2000).toString(), sigma);
    }
    assert.equal(vectors.sigma_e12.SPI10, '25183245');
    assert.equal(vectors.sigma_e12.SPI100, '251832452');
});

test('the independent verifier recomputes every vector price across the epoch boundary', async () => {
    const config = vectors.config.indices;
    for (const [index, rows] of Object.entries(vectors.series)) {
        const raw = config.find((e) => e.index === index);
        const entry = { anchor: BigInt(raw.anchor_units), sigma: BigInt(raw.sigma_e12), kappa: BigInt(raw.kappa_e12) };
        const epochsSeen = new Set(rows.map((row) => row.epoch_start_ms));
        assert.equal(epochsSeen.size, 2, 'vectors must span a UTC epoch boundary');
        for (const row of rows) {
            const epoch = vectors.epochs.find((e) => e.epoch_start_ms === row.epoch_start_ms);
            const keys = await v.epochKeys(v.fromHex(epoch.seed), 'test', 'DEMO', index, BigInt(row.epoch_start_ms));
            assert.equal((await v.expectedUnits(keys, entry, BigInt(row.tick_no), BigInt(row.prev_units))).toString(), row.price_units, `${index} tick ${row.tick_no}`);
            assert.equal(Number(BigInt(row.price_units) % 10n), row.digit);
        }
    }
});

test('forced rejection: first-byte and whole-block rejection agree in both implementations', async () => {
    const r = vectors.rejection;
    assert.ok(parseInt(r.digit_block_0.slice(0, 2), 16) >= 250);
    assert.deepEqual(v.digitResidue([v.fromHex(r.digit_block_0)]), { residue: BigInt(r.residue), counter: 0n });
    const raw = vectors.config.indices.find((e) => e.index === r.index);
    const epoch = vectors.epochs.find((e) => e.epoch_start_ms === r.epoch_start_ms);
    const keys = await v.epochKeys(v.fromHex(epoch.seed), 'test', 'DEMO', r.index, BigInt(r.epoch_start_ms));
    assert.equal((await v.expectedUnits(keys, { anchor: BigInt(raw.anchor_units), sigma: BigInt(raw.sigma_e12), kappa: BigInt(raw.kappa_e12) }, BigInt(r.tick_no), BigInt(r.prev_units))).toString(), r.price_units);

    const rejected = Buffer.alloc(32, 0xff);
    const second = Buffer.alloc(32, 0xfa); second[5] = 0xf9; // 249 -> residue 9 at counter 1
    assert.deepEqual(g.residue((counter) => [rejected, second][Number(counter)]), { residue: 9n, counter: 1n });
    assert.deepEqual(v.digitResidue([rejected, second]), { residue: 9n, counter: 1n });
    assert.deepEqual(g.residue(() => Buffer.from([250, 251, 252, 253, 254, 255, 0, ...Array(25).fill(255)])), { residue: 0n, counter: 0n });
});

test('digit bijection: every prior state maps the ten residues onto the ten digits', () => {
    for (let prev = 10_000_000n; prev < 10_000_010n; prev++) {
        for (const parity of [0n, 1n]) {
            for (const z of [-786420n, -1n, 0n, 1n, 786420n]) {
                const digits = new Set();
                for (let residue = 0n; residue < 10n; residue++) {
                    digits.add(g.transition({ prevUnits: prev, anchorUnits: 10_000_000n, sigmaE12: 251832452n, kappaE12: g.KAPPA_E12, z, parity, residue }).digit);
                }
                assert.equal(digits.size, 10, `prev=${prev} parity=${parity} z=${z}`);
            }
        }
    }
});

test('transition floors negative moves and stays centred', () => {
    assert.equal(g.floorDiv(-7n, 2n), -4n);
    assert.equal(g.floorDiv(7n, 2n), 3n);
    assert.equal(g.floorDiv(-6n, 2n), -3n);
    const down = g.transition({ prevUnits: 10_000_000n, anchorUnits: 10_000_000n, sigmaE12: 251832452n, kappaE12: 0n, z: -131072n, parity: 0n, residue: 4n });
    const up = g.transition({ prevUnits: 10_000_000n, anchorUnits: 10_000_000n, sigmaE12: 251832452n, kappaE12: 0n, z: 131072n, parity: 0n, residue: 4n });
    assert.equal(down.coarse, -252n); // one sd = 2518.32 units -> 251.8 tens
    assert.equal(up.coarse, 252n);
    assert.equal(up.next - 10_000_000n, 10_000_000n - down.next);
});

test('invalid inputs are rejected rather than normalised', () => {
    assert.throws(() => g.seedHash('00'), /engine_v3_seed_invalid/);
    assert.throws(() => g.seedHash('Z'.repeat(64)), /engine_v3_seed_invalid/);
    assert.throws(() => g.deriveKey(vectors.epochs[0].seed, { purpose: 'price', env: 'test', mode: 'DEMO', index: 'SPI10', epochStartMs: 0n }), /engine_v3_purpose_invalid/);
    assert.throws(() => g.deriveKey(vectors.epochs[0].seed, { purpose: 'price-move', env: 'dev', mode: 'DEMO', index: 'SPI10', epochStartMs: 0n }), /engine_v3_env_invalid/);
    const config = g.defaultConfig();
    config.indices[0].sigma_e12 += 1n;
    assert.throws(() => g.configHash(config), /engine_v3_config_sigma_mismatch/);
    const duplicate = g.defaultConfig();
    duplicate.indices.push({ ...duplicate.indices[0] });
    assert.throws(() => g.configHash(duplicate), /engine_v3_config_duplicate_index/);
});

test('keys are separated by purpose, environment, mode, index and epoch', () => {
    const seed = vectors.epochs[0].seed;
    const base = { purpose: 'price-move', env: 'test', mode: 'DEMO', index: 'SPI10', epochStartMs: 0n };
    const keys = [base, { ...base, purpose: 'price-digit' }, { ...base, env: 'staging' }, { ...base, mode: 'REAL' }, { ...base, index: 'SPI25' }, { ...base, epochStartMs: DAY }]
        .map((input) => g.deriveKey(seed, input).toString('hex'));
    assert.equal(new Set(keys).size, keys.length);
});

test('band breach halts instead of rerolling, and epoch gaps are refused', () => {
    const config = g.defaultConfig();
    for (const entry of config.indices) { entry.min_units = 9_999_999n; entry.max_units = 10_000_001n; }
    const ledger = g.createEpochLedger({ config, seedForEpoch: () => vectors.epochs[0].seed });
    assert.throws(() => g.createSeries({ ledger, index: 'SPI100' }).next(), /engine_v3_price_out_of_band/);
    const gapLedger = g.createEpochLedger({ config: g.defaultConfig(), seedForEpoch: () => vectors.epochs[0].seed });
    gapLedger.epoch(0n);
    assert.throws(() => gapLedger.epoch(2n * DAY), /engine_v3_epoch_gap/);
});

// ---- proof packages ----
const hexOf = (value) => (Buffer.isBuffer(value) ? value.toString('hex') : value);
function samplePackage({ ticks = 40, revealAll = true } = {}) {
    const config = g.defaultConfig({ env: 'test', mode: 'DEMO', t0Ms: 1_790_035_200_000n - 41_000n });
    const ledger = g.createEpochLedger({ config, seedForEpoch: (start) => (start < 1_790_035_200_000n ? vectors.epochs[0].seed : vectors.epochs[1].seed) });
    const all = [];
    for (const index of ['SPI10', 'SPI50']) {
        const s = g.createSeries({ ledger, index });
        for (let n = 0; n < ticks; n++) all.push(s.next().tick);
    }
    const exit = all.find((t) => t.index === 'SPI10' && t.tick_no === 30n);
    const contracts = [
        { id: 'c-even', index: 'SPI10', contract_type: 'EVEN', barrier: null, entry_tick_no: '25', settle_tick_no: '30', result: exit.digit % 2 === 0 ? 'WON' : 'LOST' },
        { id: 'c-over', index: 'SPI10', contract_type: 'OVER', barrier: 4, entry_tick_no: '25', settle_tick_no: '30', result: exit.digit > 4 ? 'WON' : 'LOST' },
    ];
    const revealed = new Set(revealAll ? [...ledger.epochs.keys()] : [...ledger.epochs.keys()].slice(0, 1));
    return g.proofPackage({ ledger, ticks: all, revealed, contracts });
}
function rehash(pkg, tick) {
    tick.tick_hash = hexOf(g.tickHash({ ...tick, env: pkg.env, mode: pkg.mode }));
}
const lastOf = (pkg, index) => pkg.ticks.filter((t) => t.index === index).at(-1);

test('an untampered package verifies and is reported unwitnessed', async () => {
    const result = await v.verifyPackage(samplePackage());
    assert.equal(result.status, 'verified', JSON.stringify(result.issues));
    assert.equal(result.witness, 'unwitnessed');
    assert.deepEqual(result.anchored, { SPI10: true, SPI50: true });
    assert.equal(result.ticks.length, 80);
    assert.ok(result.contracts.every((c) => c.status === 'verified'));
});

test('tampering is reported with a specific state', async () => {
    const cases = {
        price_mismatch: (pkg) => { const t = lastOf(pkg, 'SPI10'); t.price_units = String(BigInt(t.price_units) + 10n); rehash(pkg, t); },
        digit_mismatch: (pkg) => { const t = lastOf(pkg, 'SPI10'); t.digit = String((Number(t.digit) + 1) % 10); rehash(pkg, t); },
        invalid_config: (pkg) => { pkg.config.indices[0].sigma_e12 = String(BigInt(pkg.config.indices[0].sigma_e12) + 1n); },
        invalid_commitment: (pkg) => { pkg.epochs[1].revealed_seed = '11'.repeat(32); },
        broken_continuity: (pkg) => { pkg.ticks.splice(pkg.ticks.findIndex((t) => t.index === 'SPI50' && t.tick_no === '12'), 1); },
        missing_history: (pkg) => { pkg.ticks.splice(pkg.ticks.findIndex((t) => t.index === 'SPI50'), 1); },
        contract_mismatch: (pkg) => { pkg.contracts[0].result = pkg.contracts[0].result === 'WON' ? 'LOST' : 'WON'; },
    };
    for (const [expected, tamper] of Object.entries(cases)) {
        const pkg = samplePackage();
        tamper(pkg);
        const result = await v.verifyPackage(pkg);
        assert.equal(result.status, expected, `${expected}: ${JSON.stringify(result.issues.slice(0, 3))}`);
    }
});

test('forged commitment fields and re-chained tick edits are both caught', async () => {
    const seedHash = samplePackage();
    seedHash.epochs[0].seed_hash = 'ab'.repeat(32);
    assert.ok((await v.verifyPackage(seedHash)).states.includes('invalid_commitment'));

    const chain = samplePackage();
    const t = chain.ticks.find((tick) => tick.index === 'SPI10' && tick.tick_no === '15');
    t.prev_units = String(BigInt(t.prev_units) + 1n);
    rehash(chain, t);
    assert.ok((await v.verifyPackage(chain)).states.includes('broken_continuity'));

    const hashOnly = samplePackage();
    hashOnly.ticks[3].generated_ms = String(BigInt(hashOnly.ticks[3].generated_ms) + 1n);
    assert.equal((await v.verifyPackage(hashOnly)).status, 'broken_continuity');
});

test('unrevealed epochs are pending, not failures', async () => {
    const result = await v.verifyPackage(samplePackage({ revealAll: false }));
    assert.equal(result.status, 'not_yet_revealable');
    assert.ok(result.ticks.some((t) => t.status === 'verified'));
    assert.ok(result.ticks.some((t) => t.status === 'not_yet_revealable'));
});

test('malformed packages fail closed', async () => {
    assert.equal((await v.verifyPackage({ format: 'smartprofit-proof/v2' })).status, 'invalid_config');
    const pkg = samplePackage();
    pkg.ticks[0].price_units = '1e7';
    assert.equal((await v.verifyPackage(pkg)).status, 'invalid_config');
});

test('the verifier does not import the generator', () => {
    const source = readFileSync(new URL('../verifier/v3/verify.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /^\s*import\b|\bimport\s*\(|\brequire\s*\(/m);
    assert.doesNotMatch(source, /['"]node:crypto['"]/);
});
