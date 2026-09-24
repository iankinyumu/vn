// Produces the frozen v3 known-answer vectors from the reference generator.
//   node scripts/engine-v3-vectors.mjs          check engine/v3/vectors.json is unchanged
//   node scripts/engine-v3-vectors.mjs --write  (re)write it; only with a new spec version
// tests/engine-v3.test.mjs checks the independent verifier against the same file.
import { createHmac } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import * as g from '../engine/v3/generator.mjs';

const file = new URL('../engine/v3/vectors.json', import.meta.url);
const hex = (b) => Buffer.from(b).toString('hex');
const SEED_A = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const SEED_B = '202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f';
const BOUNDARY = 1_790_035_200_000n; // 2026-09-22T00:00:00Z
const T0 = BOUNDARY - 21_000n;       // tick 10 is the last of day one, tick 11 the first of day two

export function buildVectors() {
    const config = g.defaultConfig({ env: 'test', mode: 'DEMO', t0Ms: T0, genesisTickNo: 0n });
    const ledger = g.createEpochLedger({ config, seedForEpoch: (start) => (start < BOUNDARY ? SEED_A : SEED_B) });
    const series = {};
    const rows = {};
    for (const index of ['SPI10', 'SPI100']) {
        const s = g.createSeries({ ledger, index, generatedMs: (scheduled) => scheduled + 150n });
        rows[index] = [];
        for (let n = 0; n < 20; n++) {
            const { tick, drawn } = s.next();
            rows[index].push({ tick, drawn });
        }
        series[index] = rows[index].map(({ tick, drawn }) => ({
            tick_no: tick.tick_no.toString(), scheduled_ms: tick.scheduled_ms.toString(), generated_ms: tick.generated_ms.toString(),
            epoch_start_ms: tick.epoch_start_ms.toString(), prev_units: tick.prev_units.toString(),
            z: drawn.z.toString(), parity: Number(drawn.parity), residue: Number(drawn.residue), digit_counter: Number(drawn.digitCounter), coarse: drawn.coarse.toString(),
            price_units: tick.price_units.toString(), digit: tick.digit, commitment: hex(tick.commitment), prev_tick_hash: hex(tick.prev_tick_hash), tick_hash: hex(tick.tick_hash),
        }));
    }

    // Forced first-byte rejection: the first SPI25 tick in epoch B whose digit
    // block starts with a byte >= 250.
    const epochB = ledger.epoch(BOUNDARY);
    const keys = ledger.keys(epochB, 'SPI25');
    let rejection = null;
    for (let tickNo = 11n; !rejection; tickNo++) {
        const block = createHmac('sha256', keys.digit).update(g.tickMessage(tickNo, 0)).digest();
        if (block[0] >= 250) {
            const entry = config.indices.find((e) => e.index === 'SPI25');
            const drawn = g.generateTick({ keys, entry, tickNo, prevUnits: 10_000_000n });
            rejection = { index: 'SPI25', epoch_start_ms: BOUNDARY.toString(), tick_no: tickNo.toString(), prev_units: '10000000', digit_block_0: hex(block), residue: Number(drawn.residue), price_units: drawn.units.toString() };
        }
    }

    return {
        spec: 'v3.0',
        note: 'Test-only seeds. Never use these values outside env=test.',
        rfc5869_case1: {
            ikm: '0b'.repeat(22), salt: '000102030405060708090a0b0c', info: 'f0f1f2f3f4f5f6f7f8f9',
            okm_first_32: '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf',
        },
        encoding: {
            tick_msg_zero: hex(g.tickMessage(0n, 0n)),
            tick_msg_max: hex(g.tickMessage((1n << 64n) - 1n, (1n << 32n) - 1n)),
            label_spi10: hex(g.str('SPI10')),
        },
        sigma_e12: Object.fromEntries(config.indices.map((e) => [e.index, e.sigma_e12.toString()])),
        config: {
            env: config.env, mode: config.mode, t0_ms: T0.toString(),
            indices: config.indices.map((e) => Object.fromEntries(Object.entries(e).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v]))),
            config_hash: hex(ledger.configHash),
        },
        epochs: [...ledger.epochs.values()].map((e) => ({
            epoch_start_ms: e.epoch_start_ms.toString(), seed: hex(e.seed), seed_hash: hex(e.seed_hash), prev_commitment: hex(e.prev_commitment), commitment: hex(e.commitment),
            keys: Object.fromEntries([...e.keys].map(([index, pair]) => [index, { move: hex(pair.move.export()), digit: hex(pair.digit.export()) }])),
        })),
        genesis_hash: Object.fromEntries(['SPI10', 'SPI100'].map((index) => [index, hex(g.genesisHash({ env: 'test', mode: 'DEMO', entry: config.indices.find((e) => e.index === index), configHash: ledger.configHash }))])),
        series,
        rejection,
    };
}

if (import.meta.url === `file:///${process.argv[1].replaceAll('\\', '/').replace(/^\//, '')}`) {
    const vectors = buildVectors();
    if (process.argv.includes('--write')) {
        writeFileSync(file, `${JSON.stringify(vectors, null, 2)}\n`);
        console.log('Wrote engine/v3/vectors.json');
    } else {
        const frozen = JSON.parse(readFileSync(file, 'utf8'));
        if (!isDeepStrictEqual(frozen, vectors)) { console.error('engine/v3/vectors.json does not match the generator.'); process.exit(1); }
        console.log('engine v3 vectors: generator matches frozen file');
    }
}
