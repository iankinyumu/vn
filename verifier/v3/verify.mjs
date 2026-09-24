// Standalone verifier for SmartProfit engine generation version 3.
// Written independently of engine/v3 from docs/adr/0001-synthetic-engine-v3.md:
// it uses WebCrypto only (browser or Node >= 19), implements HKDF itself, and
// imports nothing from the generator. Keep it that way; it is a second oracle.

const subtle = globalThis.crypto.subtle;
const DAY = 86400000n;
const LABEL_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const INDEX_CODES = ['SPI10', 'SPI25', 'SPI50', 'SPI75', 'SPI100'];
const ENVS = ['production', 'staging', 'test'];
const MODES = ['DEMO', 'REAL'];
const ZERO32 = new Uint8Array(32);

/* Result states, most severe first. `unwitnessed` is reported separately in
   `witness` because v3.0 defines no witness receipt that can be checked yet. */
export const STATES = Object.freeze(['invalid_config', 'invalid_commitment', 'broken_continuity', 'price_mismatch', 'digit_mismatch', 'contract_mismatch', 'missing_history', 'not_yet_revealable', 'verified']);

class VerificationInputError extends Error {}
const reject = (message) => { throw new VerificationInputError(message); };

// ---- bytes ----
function join(...parts) {
    const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let offset = 0;
    for (const part of parts) { out.set(part, offset); offset += part.length; }
    return out;
}
function be(value, bytes) {
    const n = BigInt(value);
    if (n < 0n || n >= 1n << BigInt(8 * bytes)) reject('integer out of range');
    const out = new Uint8Array(bytes);
    for (let i = 0; i < bytes; i++) out[bytes - 1 - i] = Number((n >> BigInt(8 * i)) & 255n);
    return out;
}
const U8 = (n) => be(n, 1), U32 = (n) => be(n, 4), U64 = (n) => be(n, 8);
function label(text) {
    if (!LABEL_PATTERN.test(text)) reject(`invalid label ${JSON.stringify(text)}`);
    return join(be(text.length, 2), Uint8Array.from(text, (ch) => ch.charCodeAt(0)));
}
const ascii = (text) => Uint8Array.from(text, (ch) => ch.charCodeAt(0));
const kind = (name) => join(label('smartprofit-engine'), label('v3'), label(name));
export function fromHex(text, length) {
    if (typeof text !== 'string' || !/^([0-9a-f]{2})*$/.test(text) || (length !== undefined && text.length !== 2 * length)) reject('invalid hex');
    return Uint8Array.from(text.match(/../g) || [], (pair) => parseInt(pair, 16));
}
export const toHex = (buffer) => Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
function integer(text) {
    if (typeof text === 'bigint' && text >= 0n) return text;
    if (typeof text === 'number' && Number.isSafeInteger(text) && text >= 0) return BigInt(text);
    if (typeof text !== 'string' || !/^(0|[1-9][0-9]*)$/.test(text)) reject('invalid integer');
    return BigInt(text);
}
const equal = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);

// ---- primitives ----
async function sha256(...parts) { return new Uint8Array(await subtle.digest('SHA-256', join(...parts))); }
async function hmacKey(key) { return subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); }
async function hmac(key, data) { return new Uint8Array(await subtle.sign('HMAC', key, data)); }

// RFC 5869, single output block (L = 32).
export async function hkdf32(salt, ikm, info) {
    const prk = await hmac(await hmacKey(salt), ikm);
    return hmac(await hmacKey(prk), join(info, Uint8Array.of(1)));
}

export function perTickSigma(annualVolBp, intervalMs) {
    const year = 365n * DAY / integer(intervalMs);
    const target = integer(annualVolBp) ** 2n * 10000000000000000n / year;
    if (target < 2n) return target;
    let lo = 1n, hi = target;
    while (lo < hi) { const mid = (lo + hi + 1n) >> 1n; if (mid * mid <= target) lo = mid; else hi = mid - 1n; }
    return lo;
}

const tickMsg = (tickNo, counter) => join(label('tick'), U64(tickNo), U32(counter));

export async function epochKeys(seed, env, mode, index, epochStart) {
    const derive = async (purpose) => hmacKey(await hkdf32(ascii('smartprofit-engine/v3/hkdf'), seed,
        join(kind('key'), label(purpose), label(env), label(mode), label(index), U64(epochStart))));
    return { move: await derive('price-move'), digit: await derive('price-digit') };
}

export function digitResidue(blocks) {
    let counter = 0n;
    for (const block of blocks) {
        for (let i = 0; i < 32; i++) if (block[i] < 250) return { residue: BigInt(block[i] % 10), counter };
        counter++;
    }
    return null;
}

// Mathematical floor of a / b for b > 0.
const floorPositive = (a, b) => (a >= 0n ? a / b : -((-a + b - 1n) / b));

export async function expectedUnits(keys, entry, tickNo, prevUnits) {
    const move = await hmac(keys.move, tickMsg(tickNo, 0n));
    let z = 0n;
    for (let i = 0; i < 24; i += 2) z += 2n * BigInt((move[i] << 8) | move[i + 1]) - 65535n;
    const parity = BigInt(move[24] & 1);
    let found = null;
    for (let counter = 0n; found === null; counter++) {
        if (counter > 0xffffffffn) reject('residue exhausted');
        found = digitResidue([await hmac(keys.digit, tickMsg(tickNo, counter))]);
    }
    const S = 131072n, den = 1000000000000n * S;
    const num = prevUnits * entry.sigma * z + entry.kappa * (entry.anchor - prevUnits) * S;
    const coarse = floorPositive(num + 5n * den, 10n * den);
    return prevUnits + 10n * coarse + found.residue - 4n - parity;
}

export function contractWins(type, barrier, digit) {
    const b = barrier === null || barrier === undefined ? null : Number(barrier);
    switch (type) {
    case 'EVEN': return digit % 2 === 0;
    case 'ODD': return digit % 2 === 1;
    case 'OVER': return b !== null && b >= 0 && b <= 8 && digit > b;
    case 'UNDER': return b !== null && b >= 1 && b <= 9 && digit < b;
    case 'MATCH': return b !== null && digit === b;
    case 'DIFFER': return b !== null && digit !== b;
    default: return null;
    }
}

function parseEntry(raw) {
    const entry = {
        index: raw.index, annualVolBp: integer(raw.annual_vol_bp), interval: integer(raw.tick_interval_ms), decimals: integer(raw.decimals),
        anchor: integer(raw.anchor_units), sigma: integer(raw.sigma_e12), kappa: integer(raw.kappa_e12), min: integer(raw.min_units), max: integer(raw.max_units),
        t0: integer(raw.t0_ms), genesisTick: integer(raw.genesis_tick_no), genesisUnits: integer(raw.genesis_units),
    };
    if (!INDEX_CODES.includes(entry.index)) reject('unknown index');
    return entry;
}
const encodeEntry = (e) => join(label(e.index), U32(e.annualVolBp), U32(e.interval), U8(e.decimals), U64(e.anchor), U64(e.sigma), U64(e.kappa),
    U64(e.min), U64(e.max), U64(e.t0), U64(e.genesisTick), U64(e.genesisUnits));

/**
 * Verifies a `smartprofit-proof/v3` package without trusting any live API.
 * Returns { status, states, witness, issues, ticks, contracts, anchored }.
 */
export async function verifyPackage(pkg) {
    const issues = [];
    const note = (state, detail) => issues.push({ state, detail });
    const tickStatus = new Map();
    const mark = (key, state) => { const list = tickStatus.get(key) || []; if (!list.includes(state)) list.push(state); tickStatus.set(key, list); };
    const anchored = {};
    const contracts = [];
    try {
        if (pkg?.format !== 'smartprofit-proof/v3') reject('unsupported proof format');
        if (!ENVS.includes(pkg.env) || !MODES.includes(pkg.mode)) reject('invalid env or mode');
        const { env, mode } = pkg;

        // Configuration: recompute every derived constant and the hash.
        const entries = (pkg.config?.indices || []).map(parseEntry);
        if (!entries.length || new Set(entries.map((e) => e.index)).size !== entries.length) reject('invalid configuration index set');
        for (const e of entries) if (perTickSigma(e.annualVolBp, e.interval) !== e.sigma) note('invalid_config', `${e.index} sigma_e12 does not match its annual volatility`);
        const sorted = [...entries].sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1 : 0));
        const configHash = await sha256(kind('model-config'), label(env), label(mode), U32(sorted.length), ...sorted.map(encodeEntry));
        const byIndex = new Map(entries.map((e) => [e.index, e]));

        // Epoch commitments form one contiguous chain per (env, mode).
        const epochs = new Map();
        let previous = null;
        for (const raw of [...(pkg.epochs || [])].sort((a, b) => (integer(a.epoch_start_ms) < integer(b.epoch_start_ms) ? -1 : 1))) {
            const start = integer(raw.epoch_start_ms);
            const record = { start, commitment: fromHex(raw.commitment, 32), seed: raw.revealed_seed ? fromHex(raw.revealed_seed, 32) : null, valid: true };
            const seedHash = fromHex(raw.seed_hash, 32), prev = fromHex(raw.prev_commitment, 32);
            if (start % DAY !== 0n || integer(raw.epoch_end_ms) !== start + DAY) { note('invalid_commitment', `epoch ${start} is not one UTC day`); record.valid = false; }
            if (!equal(fromHex(raw.config_hash, 32), configHash)) { note('invalid_config', `epoch ${start} commits to a different configuration`); record.valid = false; }
            const recomputed = await sha256(kind('epoch-commitment'), label(env), label(mode), U64(start), U64(start + DAY), seedHash, configHash, prev);
            if (!equal(recomputed, record.commitment)) { note('invalid_commitment', `epoch ${start} commitment does not match its fields`); record.valid = false; }
            if (record.seed && !equal(await sha256(kind('seed-hash'), record.seed), seedHash)) { note('invalid_commitment', `epoch ${start} revealed seed does not match its seed hash`); record.valid = false; }
            if (previous === null) { if (!equal(prev, ZERO32)) note('missing_history', `epoch ${start} follows an epoch that is not in this package`); }
            else if (start !== previous.start + DAY || !equal(prev, previous.commitment)) note('broken_continuity', `epoch ${start} does not chain to epoch ${previous.start}`);
            epochs.set(start, record);
            previous = record;
        }

        // Ticks, per index, in order from an anchored genesis.
        const keyCache = new Map();
        const groups = new Map();
        for (const raw of pkg.ticks || []) {
            if (!byIndex.has(raw.index)) reject('tick for an index outside the configuration');
            if (!groups.has(raw.index)) groups.set(raw.index, []);
            groups.get(raw.index).push(raw);
        }
        for (const [index, list] of groups) {
            const e = byIndex.get(index);
            list.sort((a, b) => (integer(a.tick_no) < integer(b.tick_no) ? -1 : 1));
            const genesis = await sha256(kind('genesis'), label(env), label(mode), label(index), U64(e.genesisTick), U64(e.genesisUnits), configHash);
            let prior = null;
            for (const raw of list) {
                const tickNo = integer(raw.tick_no), key = `${index}:${tickNo}`;
                const t = {
                    scheduled: integer(raw.scheduled_ms), generated: integer(raw.generated_ms), epochStart: integer(raw.epoch_start_ms), prevUnits: integer(raw.prev_units),
                    units: integer(raw.price_units), decimals: integer(raw.decimals), digit: integer(raw.digit), config: fromHex(raw.config_hash, 32),
                    commitment: fromHex(raw.commitment, 32), prevHash: fromHex(raw.prev_tick_hash, 32), hash: fromHex(raw.tick_hash, 32),
                };
                tickStatus.set(key, []);
                if (prior === null) {
                    anchored[index] = tickNo === e.genesisTick + 1n && t.prevUnits === e.genesisUnits && equal(t.prevHash, genesis);
                    if (!anchored[index]) { mark(key, 'missing_history'); note('missing_history', `${index} history before tick ${tickNo} is not in this package, so its starting price is unanchored`); }
                } else {
                    if (tickNo !== prior.tickNo + 1n) { mark(key, 'broken_continuity'); note('broken_continuity', `${index} ticks ${prior.tickNo + 1n}..${tickNo - 1n} are missing`); }
                    if (t.prevUnits !== prior.units || !equal(t.prevHash, prior.hash)) { mark(key, 'broken_continuity'); note('broken_continuity', `${index} tick ${tickNo} does not chain to tick ${prior.tickNo}`); }
                }
                const hash = await sha256(kind('tick'), label(env), label(mode), label(index), U64(tickNo), U64(t.scheduled), U64(t.generated), U64(t.epochStart),
                    U64(t.prevUnits), U64(t.units), U8(t.decimals), U8(t.digit), t.config, t.commitment, t.prevHash);
                if (!equal(hash, t.hash)) { mark(key, 'broken_continuity'); note('broken_continuity', `${index} tick ${tickNo} hash does not match its record`); }
                if (t.scheduled !== e.t0 + tickNo * e.interval || t.epochStart !== t.scheduled / DAY * DAY || t.decimals !== e.decimals || !equal(t.config, configHash)) {
                    mark(key, 'invalid_config'); note('invalid_config', `${index} tick ${tickNo} schedule, epoch, precision or configuration is wrong`);
                }
                if (t.units % 10n !== t.digit) { mark(key, 'digit_mismatch'); note('digit_mismatch', `${index} tick ${tickNo} digit is not the final price digit`); }
                const epoch = epochs.get(t.epochStart);
                if (!epoch) { mark(key, 'missing_history'); note('missing_history', `${index} tick ${tickNo} epoch is not in this package`); }
                else if (!equal(epoch.commitment, t.commitment)) { mark(key, 'invalid_commitment'); note('invalid_commitment', `${index} tick ${tickNo} names a different epoch commitment`); }
                else if (!epoch.valid) mark(key, 'invalid_commitment');
                else if (!epoch.seed) mark(key, 'not_yet_revealable');
                else {
                    const cacheKey = `${t.epochStart}:${index}`;
                    if (!keyCache.has(cacheKey)) keyCache.set(cacheKey, await epochKeys(epoch.seed, env, mode, index, t.epochStart));
                    const expected = await expectedUnits(keyCache.get(cacheKey), e, tickNo, t.prevUnits);
                    if (expected < e.min || expected > e.max) { mark(key, 'price_mismatch'); note('price_mismatch', `${index} tick ${tickNo} should have halted the index (outside band)`); }
                    else if (expected !== t.units) { mark(key, 'price_mismatch'); note('price_mismatch', `${index} tick ${tickNo} price ${t.units} differs from the recomputed ${expected}`); }
                }
                prior = { tickNo, units: t.units, hash: t.hash, digit: t.digit };
            }
        }

        // Contracts settle on their fixed exit tick's final digit.
        const tickDigits = new Map();
        for (const raw of pkg.ticks || []) tickDigits.set(`${raw.index}:${integer(raw.tick_no)}`, Number(integer(raw.digit)));
        for (const c of pkg.contracts || []) {
            const exit = `${c.index}:${integer(c.settle_tick_no)}`;
            let state = 'verified';
            if (integer(c.settle_tick_no) <= integer(c.entry_tick_no)) state = 'contract_mismatch';
            else if (!tickDigits.has(exit)) state = 'missing_history';
            else {
                const wins = contractWins(c.contract_type, c.barrier, tickDigits.get(exit));
                if (wins === null || (c.result === 'WON') !== wins || !['WON', 'LOST'].includes(c.result)) state = 'contract_mismatch';
                else if ((tickStatus.get(exit) || []).length) state = tickStatus.get(exit)[0];
            }
            if (state !== 'verified') note(state, `contract ${c.id} ${state === 'contract_mismatch' ? 'result does not follow from its exit tick' : `exit tick is ${state}`}`);
            contracts.push({ id: c.id, status: state });
        }
    } catch (error) {
        if (!(error instanceof VerificationInputError)) throw error;
        note('invalid_config', `malformed proof package: ${error.message}`);
    }

    const ticks = [...tickStatus].map(([key, list]) => {
        const [index, tickNo] = key.split(':');
        const status = list.length ? STATES.find((state) => list.includes(state)) : 'verified';
        return { index, tick_no: tickNo, status, states: list.length ? list : ['verified'] };
    });
    const present = new Set([...issues.map((issue) => issue.state), ...ticks.flatMap((tick) => tick.states), ...contracts.map((c) => c.status)]);
    present.delete('verified');
    const states = STATES.filter((state) => present.has(state));
    return { status: states[0] || 'verified', states: states.length ? states : ['verified'], witness: 'unwitnessed', anchored, issues, ticks, contracts };
}
