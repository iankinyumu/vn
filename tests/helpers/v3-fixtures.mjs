// Builds genuine package_version 2 proofs from the reference generator: signed
// commitments and checkpoints (Ed25519), RFC 3161 receipts from the test TSA,
// configuration rotation, anchors. Used by the proof, CLI and browser tests.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as g from '../../engine/v3/generator.mjs';
import { Ed25519Signer } from '../../engine/v3/service/signer.mjs';
import { TEST_TSA_ROOT, issueTestToken } from './test-tsa.mjs';

export const DAY = 86_400_000n;
export const BOUNDARY = 1_790_380_800_000n; // 2026-09-26T00:00:00Z, after the test TSA certificate was issued
const text = (value) => (Buffer.isBuffer(value) ? value.toString('hex') : typeof value === 'bigint' ? value.toString() : value);
const plain = (object) => Object.fromEntries(Object.entries(object).map(([k, v]) => [k, text(v)]));
const seed = (start) => g.seedHash(Buffer.from(String(start).padStart(64, '0').slice(-64), 'hex')); // deterministic 32 bytes per epoch

/**
 * @param {object} o
 * @param {bigint} o.t0               schedule origin
 * @param {Array<[bigint, object]>} o.rotations  [epochStartMs, configOverrides] applied from that epoch on
 * @param {number} o.ticks            ticks per index
 * @param {string[]} o.indices
 * @param {number} o.checkpointEvery
 * @param {bigint} o.genesis          genesis tick number
 */
export function buildFixture({ t0 = BOUNDARY - 41_000n, rotations = [], ticks = 40, indices = ['SPI10'], checkpointEvery = 10, genesis = 0n, witnessDelayMs = 60_000n,
    signer = Ed25519Signer.generate('fixture-key-1'), providers = ['digicert', 'sectigo'], reveal = true } = {}) {
    const base = g.defaultConfig({ env: 'test', mode: 'DEMO', t0Ms: t0, genesisTickNo: genesis });
    const configs = [[0n, base], ...rotations.map(([start, change]) => [start, { ...base, indices: base.indices.map((e) => ({ ...e, ...(change[e.index] || change['*'] || {}) })) }])];
    const configForEpoch = (start) => configs.filter(([from]) => from <= start).at(-1)[1];
    const ledger = g.createEpochLedger({ config: base, configForEpoch, seedForEpoch: seed });
    const all = [];
    for (const index of indices) {
        const series = g.createSeries({ ledger, index, generatedMs: (scheduled) => scheduled + 150n });
        for (let i = 0; i < ticks; i++) all.push(series.next().tick);
    }
    const receipt = (subject, genTimeMs) => providers.map((provider) => ({ provider, token: Buffer.from(issueTestToken(subject, Number(genTimeMs))).toString('base64') }));
    const epochs = [...ledger.epochs.values()].sort((a, b) => (a.epoch_start_ms < b.epoch_start_ms ? -1 : 1));
    const checkpoints = all.filter((t) => (t.tick_no - genesis) % BigInt(checkpointEvery) === 0n).map((t) => {
        const createdMs = t.scheduled_ms + 500n;
        const hash = g.checkpointHash({ env: 'test', mode: 'DEMO', index: t.index, tickNo: t.tick_no, tickHash: t.tick_hash, createdMs });
        return { index: t.index, tick_no: String(t.tick_no), tick_hash: t.tick_hash.toString('hex'), created_ms: String(createdMs), checkpoint_hash: hash.toString('hex'),
            signing_key_id: signer.keyId, signature: signer.sign('checkpoint', hash).toString('hex'), witness: receipt(hash, createdMs + 1000n) };
    });
    const exit = all.find((t) => t.tick_no === genesis + 6n && t.index === indices[0]);
    const pkg = {
        format: 'smartprofit-proof/v3', package_version: 2, env: 'test', mode: 'DEMO',
        configs: Object.fromEntries([...new Set(epochs.map((e) => e.config))].map((cfg) => [ledger.hashOf(cfg).toString('hex'), { indices: cfg.indices.map(plain) }])),
        signing_keys: [{ key_id: signer.keyId, algorithm: 'Ed25519', public_key: signer.publicKey.toString('hex') }],
        epochs: epochs.map((e) => {
            const deadline = g.witnessDeadline(e.config, e.epoch_start_ms);
            return { ...plain({ epoch_start_ms: e.epoch_start_ms, epoch_end_ms: e.epoch_end_ms, seed_hash: e.seed_hash, config_hash: e.config_hash, prev_commitment: e.prev_commitment, commitment: e.commitment }),
                signing_key_id: signer.keyId, signature: signer.sign('epoch-commitment', e.commitment).toString('hex'),
                revealed_seed: reveal ? e.seed.toString('hex') : null, witness_deadline_ms: String(deadline), witness: receipt(e.commitment, deadline - witnessDelayMs) };
        }),
        anchors: {},
        ticks: all.map((t) => plain(Object.fromEntries(Object.entries(t).filter(([k]) => !['env', 'mode'].includes(k))))),
        checkpoints,
        contracts: exit ? [{ id: 'c1', index: exit.index, contract_type: 'EVEN', barrier: null, entry_tick_no: String(exit.tick_no - 2n), settle_tick_no: String(exit.tick_no), result: exit.digit % 2 === 0 ? 'WON' : 'LOST', exit_digit: exit.digit }] : [],
    };
    const trust = { trustedKeys: { [signer.keyId]: signer.publicKey.toString('hex') }, tsaRoots: Object.fromEntries(providers.map((p) => [p, [new Uint8Array(TEST_TSA_ROOT)]])), requiredWitnesses: providers };
    return { pkg, trust, signer, ledger, all, receipt };
}

/** Restricts a package to ticks after `anchorTickNo`, anchored by that tick's checkpoint. */
export function anchorAt(pkg, index, anchorTickNo) {
    const out = structuredClone(pkg);
    const anchorTick = out.ticks.find((t) => t.index === index && t.tick_no === String(anchorTickNo));
    const checkpoint = out.checkpoints.find((c) => c.index === index && c.tick_no === String(anchorTickNo));
    out.anchors = { [index]: { tick: anchorTick, checkpoint } };
    out.ticks = out.ticks.filter((t) => t.index !== index || BigInt(t.tick_no) > BigInt(anchorTickNo));
    out.checkpoints = out.checkpoints.filter((c) => BigInt(c.tick_no) > BigInt(anchorTickNo));
    out.contracts = out.contracts.filter((c) => BigInt(c.settle_tick_no) > BigInt(anchorTickNo)); // as the export does
    return out;
}

/** Writes a test trust bundle directory (for the CLI --trust-dir override). */
export function writeTrustBundle(dir, fixture) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'trusted-keys.json'), JSON.stringify({ note: 'TEST ONLY', keys: fixture.trust.trustedKeys }));
    writeFileSync(join(dir, 'tsa-roots.json'), JSON.stringify({ label: 'TEST ONLY', required: fixture.trust.requiredWitnesses,
        providers: Object.fromEntries(fixture.trust.requiredWitnesses.map((p) => [p, { certificates: [Buffer.from(TEST_TSA_ROOT).toString('base64')] }])) }));
}

export function rehashTick(pkg, tick) {
    tick.tick_hash = g.tickHash({ ...tick, env: pkg.env, mode: pkg.mode }).toString('hex');
}
