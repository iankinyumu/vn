// Reference generator for engine generation version 3 (docs/adr/0001-synthetic-engine-v3.md).
// Normative steps use exact integers only. This module is the service-side
// implementation; verifier/v3 is written separately against the same spec and
// must never import from here.
import { createHash, createHmac, createSecretKey, hkdfSync } from 'node:crypto';

export const ENGINE = 'smartprofit-engine';
export const VERSION = 'v3';
export const HKDF_SALT = Buffer.from('smartprofit-engine/v3/hkdf', 'ascii');
export const PURPOSES = Object.freeze(['price-move', 'price-digit']);
export const ENVIRONMENTS = Object.freeze(['production', 'staging', 'test']);
export const MODES = Object.freeze(['DEMO', 'REAL']);
export const INDICES = Object.freeze(['SPI10', 'SPI25', 'SPI50', 'SPI75', 'SPI100']);
export const DAY_MS = 86_400_000n;
export const Z_SCALE = 1n << 17n;
export const E12 = 10n ** 12n;
export const KAPPA_E12 = 534_835n;
export const ANNUAL_VOL_BP = Object.freeze({ SPI10: 1000, SPI25: 2500, SPI50: 5000, SPI75: 7500, SPI100: 10000 });

const U64_MAX = (1n << 64n) - 1n;
const U32_MAX = (1n << 32n) - 1n;
const LABEL = /^[A-Za-z0-9._-]{1,64}$/;

function fail(code) { throw new Error(code); }

export function isqrt(n) {
    if (n < 0n) fail('engine_v3_negative_sqrt');
    if (n < 2n) return n;
    let x = n, y = (x + 1n) / 2n;
    while (y < x) { x = y; y = (x + n / x) / 2n; }
    return x;
}

// Mathematical floor division; BigInt `/` truncates toward zero.
export function floorDiv(a, b) {
    const q = a / b;
    return (a % b !== 0n && (a < 0n) !== (b < 0n)) ? q - 1n : q;
}

export function ticksPerYear(tickIntervalMs) { return 365n * DAY_MS / BigInt(tickIntervalMs); }

export function sigmaE12(annualVolBp, tickIntervalMs) {
    const bp = BigInt(annualVolBp);
    return isqrt(bp * bp * 10n ** 16n / ticksPerYear(tickIntervalMs));
}

// ---- canonical encoding (ADR §4) ----
export function u8(n) { return uint(n, 1, 255n); }
export function u16(n) { return uint(n, 2, 65535n); }
export function u32(n) { return uint(n, 4, U32_MAX); }
export function u64(n) { return uint(n, 8, U64_MAX); }
function uint(n, width, max) {
    const value = BigInt(n);
    if (value < 0n || value > max) fail('engine_v3_integer_out_of_range');
    const out = Buffer.alloc(width);
    let rest = value;
    for (let i = width - 1; i >= 0; i--) { out[i] = Number(rest & 0xffn); rest >>= 8n; }
    return out;
}
export function str(s) {
    if (typeof s !== 'string' || !LABEL.test(s)) fail('engine_v3_label_invalid');
    return Buffer.concat([u16(s.length), Buffer.from(s, 'ascii')]);
}
function h32(value) {
    const out = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'hex');
    if (out.length !== 32 || (!Buffer.isBuffer(value) && !/^[0-9a-f]{64}$/.test(value))) fail('engine_v3_hash_invalid');
    return out;
}
function oneOf(value, allowed, code) { if (!allowed.includes(value)) fail(code); return value; }
export function header(kind) { return Buffer.concat([str(ENGINE), str(VERSION), str(kind)]); }
const sha256 = (...parts) => createHash('sha256').update(Buffer.concat(parts)).digest();

export function seedBytes(seed) {
    const out = Buffer.isBuffer(seed) ? seed : /^[0-9a-f]{64}$/.test(String(seed)) ? Buffer.from(seed, 'hex') : null;
    if (!out || out.length !== 32) fail('engine_v3_seed_invalid');
    return out;
}

export function epochStartMs(scheduledMs) { return BigInt(scheduledMs) / DAY_MS * DAY_MS; }
export function scheduledMs(entry, tickNo) { return BigInt(entry.t0_ms) + BigInt(tickNo) * BigInt(entry.tick_interval_ms); }

// ---- keys (ADR §4.1) ----
export function seedHash(seed) { return sha256(header('seed-hash'), seedBytes(seed)); }

export function deriveKey(seed, { purpose, env, mode, index, epochStartMs: start }) {
    oneOf(purpose, PURPOSES, 'engine_v3_purpose_invalid');
    oneOf(env, ENVIRONMENTS, 'engine_v3_env_invalid');
    oneOf(mode, MODES, 'engine_v3_mode_invalid');
    oneOf(index, INDICES, 'engine_v3_index_invalid');
    const info = Buffer.concat([header('key'), str(purpose), str(env), str(mode), str(index), u64(start)]);
    return Buffer.from(hkdfSync('sha256', seedBytes(seed), HKDF_SALT, info, 32));
}

// ---- tick PRF (ADR §4.2) ----
export function tickMessage(tickNo, counter) { return Buffer.concat([str('tick'), u64(tickNo), u32(counter)]); }
const prf = (key, tickNo, counter) => createHmac('sha256', key).update(tickMessage(tickNo, counter)).digest();

export function innovation(moveBlock) {
    let z = 0n;
    for (let i = 0; i < 12; i++) z += 2n * BigInt(moveBlock.readUInt16BE(2 * i)) - 65535n;
    return { z, parity: BigInt(moveBlock[24] & 1) };
}

// Scans blocks lazily; `nextBlock(counter)` lets tests force the rejection path.
export function residue(nextBlock) {
    for (let counter = 0n; counter <= U32_MAX; counter++) {
        const block = nextBlock(counter);
        for (const byte of block) if (byte < 250) return { residue: BigInt(byte % 10), counter };
    }
    return fail('engine_v3_residue_exhausted');
}

// ---- transition (ADR §5.3/§5.4) ----
export function transition({ prevUnits, anchorUnits, sigmaE12: sigma, kappaE12: kappa, z, parity, residue: r }) {
    const P = BigInt(prevUnits), A = BigInt(anchorUnits);
    const num = P * BigInt(sigma) * z + BigInt(kappa) * (A - P) * Z_SCALE;
    const den = E12 * Z_SCALE;
    const coarse = floorDiv(num + 5n * den, 10n * den);
    const next = P + 10n * coarse + r - 4n - parity;
    return { coarse, next, digit: ((next % 10n) + 10n) % 10n };
}

export function generateTick({ keys, entry, tickNo, prevUnits }) {
    const move = innovation(prf(keys.move, tickNo, 0));
    const digitDraw = residue((counter) => prf(keys.digit, tickNo, counter));
    const result = transition({ prevUnits, anchorUnits: entry.anchor_units, sigmaE12: entry.sigma_e12, kappaE12: entry.kappa_e12, ...move, residue: digitDraw.residue });
    if (result.next < BigInt(entry.min_units) || result.next > BigInt(entry.max_units)) fail('engine_v3_price_out_of_band');
    return { units: result.next, digit: Number(result.digit), coarse: result.coarse, z: move.z, parity: move.parity, residue: digitDraw.residue, digitCounter: digitDraw.counter };
}

// ---- configuration and commitments (ADR §4.3–§4.5) ----
export function defaultConfig({ env = 'test', mode = 'DEMO', t0Ms = 0n, genesisTickNo = 0n } = {}) {
    return {
        env, mode,
        indices: INDICES.map((index) => ({
            index, annual_vol_bp: ANNUAL_VOL_BP[index], tick_interval_ms: 2000, decimals: 3,
            anchor_units: 10_000_000n, sigma_e12: sigmaE12(ANNUAL_VOL_BP[index], 2000), kappa_e12: KAPPA_E12,
            min_units: 500_000n, max_units: 200_000_000n, t0_ms: BigInt(t0Ms),
            genesis_tick_no: BigInt(genesisTickNo), genesis_units: 10_000_000n,
        })),
    };
}

export function configHash(config) {
    oneOf(config.env, ENVIRONMENTS, 'engine_v3_env_invalid');
    oneOf(config.mode, MODES, 'engine_v3_mode_invalid');
    const entries = [...config.indices].sort((a, b) => Buffer.compare(Buffer.from(a.index, 'ascii'), Buffer.from(b.index, 'ascii')));
    const seen = new Set();
    const body = entries.map((e) => {
        oneOf(e.index, INDICES, 'engine_v3_index_invalid');
        if (seen.has(e.index)) fail('engine_v3_config_duplicate_index');
        seen.add(e.index);
        if (BigInt(e.sigma_e12) !== sigmaE12(e.annual_vol_bp, e.tick_interval_ms)) fail('engine_v3_config_sigma_mismatch');
        return Buffer.concat([str(e.index), u32(e.annual_vol_bp), u32(e.tick_interval_ms), u8(e.decimals), u64(e.anchor_units), u64(e.sigma_e12), u64(e.kappa_e12),
            u64(e.min_units), u64(e.max_units), u64(e.t0_ms), u64(e.genesis_tick_no), u64(e.genesis_units)]);
    });
    return sha256(header('model-config'), str(config.env), str(config.mode), u32(entries.length), ...body);
}

export function epochCommitment({ env, mode, epochStartMs: start, seedHash: seedDigest, configHash: config, prevCommitment }) {
    return sha256(header('epoch-commitment'), str(env), str(mode), u64(start), u64(BigInt(start) + DAY_MS), h32(seedDigest), h32(config), prevCommitment ? h32(prevCommitment) : Buffer.alloc(32));
}

export function genesisHash({ env, mode, entry, configHash: config }) {
    return sha256(header('genesis'), str(env), str(mode), str(entry.index), u64(entry.genesis_tick_no), u64(entry.genesis_units), h32(config));
}

export function tickHash(t) {
    return sha256(header('tick'), str(t.env), str(t.mode), str(t.index), u64(t.tick_no), u64(t.scheduled_ms), u64(t.generated_ms), u64(t.epoch_start_ms),
        u64(t.prev_units), u64(t.price_units), u8(t.decimals), u8(t.digit), h32(t.config_hash), h32(t.commitment), h32(t.prev_tick_hash));
}

// ---- series (used by the calibration harness and proof export) ----
// One ledger per (env, mode): `seedForEpoch(epochStartMs)` supplies each epoch's
// 32-byte seed, and commitments chain in contiguous epoch order from zero.
// `configForEpoch(epochStartMs)` rotates configurations between epochs (each
// epoch commits to its own); it defaults to `config` for every epoch.
export function createEpochLedger({ config, seedForEpoch, configForEpoch = () => config }) {
    const cfgHash = configHash(config);
    const hashes = new Map([[config, cfgHash]]);
    const hashOf = (cfg) => { if (!hashes.has(cfg)) hashes.set(cfg, configHash(cfg)); return hashes.get(cfg); };
    const epochs = new Map();
    let lastCommitment = null, lastEpoch = null;
    function epoch(start) {
        let record = epochs.get(start);
        if (record) return record;
        if (lastEpoch !== null && start !== lastEpoch + DAY_MS) fail('engine_v3_epoch_gap');
        const seed = seedBytes(seedForEpoch(start));
        const epochConfig = configForEpoch(start);
        if (epochConfig.env !== config.env || epochConfig.mode !== config.mode) fail('engine_v3_config_scope_mismatch');
        record = { epoch_start_ms: start, epoch_end_ms: start + DAY_MS, seed, seed_hash: seedHash(seed), config: epochConfig, config_hash: hashOf(epochConfig), prev_commitment: lastCommitment ?? Buffer.alloc(32), keys: new Map() };
        record.commitment = epochCommitment({ env: config.env, mode: config.mode, epochStartMs: start, seedHash: record.seed_hash, configHash: record.config_hash, prevCommitment: record.prev_commitment });
        epochs.set(start, record);
        lastCommitment = record.commitment; lastEpoch = start;
        return record;
    }
    function keys(record, index) {
        let pair = record.keys.get(index);
        if (!pair) {
            const common = { env: config.env, mode: config.mode, index, epochStartMs: record.epoch_start_ms };
            // KeyObjects avoid a costly per-call key import in OpenSSL 3.
            pair = { move: createSecretKey(deriveKey(record.seed, { ...common, purpose: 'price-move' })), digit: createSecretKey(deriveKey(record.seed, { ...common, purpose: 'price-digit' })) };
            record.keys.set(index, pair);
        }
        return pair;
    }
    return { config, configHash: cfgHash, epochs, epoch, keys, hashOf };
}

export function createSeries({ ledger, index, generatedMs = (scheduled) => scheduled }) {
    const { config, configHash: cfgHash } = ledger;
    const entry = config.indices.find((item) => item.index === index) || fail('engine_v3_index_invalid');
    let tickNo = BigInt(entry.genesis_tick_no), prevUnits = BigInt(entry.genesis_units);
    let prevHash = genesisHash({ env: config.env, mode: config.mode, entry, configHash: cfgHash });
    return {
        entry,
        next() {
            tickNo += 1n;
            const scheduled = scheduledMs(entry, tickNo);
            const record = ledger.epoch(epochStartMs(scheduled));
            const epochEntry = record.config.indices.find((item) => item.index === index) || fail('engine_v3_index_invalid');
            const drawn = generateTick({ keys: ledger.keys(record, index), entry: epochEntry, tickNo, prevUnits });
            const tick = {
                env: config.env, mode: config.mode, index, tick_no: tickNo, scheduled_ms: scheduled, generated_ms: BigInt(generatedMs(scheduled)),
                epoch_start_ms: record.epoch_start_ms, prev_units: prevUnits, price_units: drawn.units, decimals: epochEntry.decimals, digit: drawn.digit,
                config_hash: record.config_hash, commitment: record.commitment, prev_tick_hash: prevHash,
            };
            tick.tick_hash = tickHash(tick);
            prevUnits = drawn.units; prevHash = tick.tick_hash;
            return { tick, drawn };
        },
    };
}

// Exports a machine-readable proof package (ADR §8). Seeds are included only
// for epochs listed in `revealed`; all u64 values are decimal strings.
export function proofPackage({ ledger, ticks, revealed = new Set(), contracts = [] }) {
    const { config } = ledger;
    const text = (value) => Buffer.isBuffer(value) ? value.toString('hex') : typeof value === 'bigint' ? value.toString() : value;
    const plain = (object) => Object.fromEntries(Object.entries(object).map(([key, value]) => [key, text(value)]));
    return {
        format: 'smartprofit-proof/v3', env: config.env, mode: config.mode,
        config: { indices: config.indices.map(plain) },
        epochs: [...ledger.epochs.values()].sort((a, b) => (a.epoch_start_ms < b.epoch_start_ms ? -1 : 1)).map((e) => ({
            ...plain({ epoch_start_ms: e.epoch_start_ms, epoch_end_ms: e.epoch_end_ms, seed_hash: e.seed_hash, config_hash: e.config_hash, prev_commitment: e.prev_commitment, commitment: e.commitment }),
            revealed_seed: revealed.has(e.epoch_start_ms) ? e.seed.toString('hex') : null,
            witness: null,
        })),
        ticks: ticks.map((tick) => plain(Object.fromEntries(Object.entries(tick).filter(([key]) => !['env', 'mode'].includes(key))))),
        contracts,
    };
}

// ---- Part B records (ADR 0002 §4) ----
export const SIGNATURE_KINDS = Object.freeze(['epoch-commitment', 'checkpoint']);

export function signedMessage(kind, keyId, subject) {
    oneOf(kind, SIGNATURE_KINDS, 'engine_v3_signature_kind_invalid');
    return Buffer.concat([header('signed'), str(kind), str(keyId), h32(subject)]);
}

export function checkpointHash({ env, mode, index, tickNo, tickHash: hash, createdMs }) {
    return sha256(header('checkpoint'), str(env), str(mode), str(index), u64(tickNo), h32(hash), u64(createdMs));
}

// First scheduled tradable tick of an epoch over every index in its configuration:
// max(genesis + 1, first tick at or after the epoch start). The witness deadline.
export function witnessDeadline(config, epochStart) {
    let best = null;
    for (const e of config.indices) {
        const t0 = BigInt(e.t0_ms), step = BigInt(e.tick_interval_ms), start = BigInt(epochStart);
        const first = t0 + (start <= t0 ? -((t0 - start) / step) : (start - t0 + step - 1n) / step) * step;
        const afterGenesis = t0 + (BigInt(e.genesis_tick_no) + 1n) * step;
        const candidate = first > afterGenesis ? first : afterGenesis;
        if (best === null || candidate < best) best = candidate;
    }
    return best;
}
