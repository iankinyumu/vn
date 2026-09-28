// Writes the engine v3 worker parameters file (ENGINE_PARAMS_FILE) for a Practice
// cutover at a UTC midnight: anchorless (kappa_e12 = 0, ADR 0001 §3), reference and
// start 10000.000, and genesis at the last v2 tick before the cutover (§5.5).
//
//   node scripts/engine-v3-params.mjs --cutover 2026-10-15 --t0-ms <t0> [--out params.json]
//
// t0: select floor(extract(epoch from t0)*1000)::bigint from public.engine_indices where code = 'SPI10' and execution_mode = 'DEMO';
// Every index must share that t0; the database refuses a configuration that does not match.
import { writeFileSync } from 'node:fs';
import * as g from '../engine/v3/generator.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, token, i, all) => (token.startsWith('--') ? [...pairs, [token.slice(2), all[i + 1]]] : pairs), []));
const fail = (message) => { console.error(message); process.exit(64); };
if (!/^\d{4}-\d{2}-\d{2}$/.test(args.cutover || '')) fail('--cutover YYYY-MM-DD (a UTC midnight) is required');
if (!/^\d+$/.test(args['t0-ms'] || '')) fail('--t0-ms is required (see the query in this file)');
const cutoverMs = Date.parse(`${args.cutover}T00:00:00Z`);
const t0 = BigInt(args['t0-ms']);
if (!(cutoverMs > Date.now() + 86_400_000)) fail('the cutover must be at least a day ahead, so it can be announced');
const interval = 2000n;
const genesisTickNo = (BigInt(cutoverMs) - 1n - t0) / interval;
const params = Object.fromEntries(g.INDICES.map((index) => [index, {
    annual_vol_bp: g.ANNUAL_VOL_BP[index], anchor_units: 10_000_000, kappa_e12: 0,
    min_units: 500_000, max_units: 200_000_000, genesis_tick_no: Number(genesisTickNo), genesis_units: 10_000_000,
}]));
const text = `${JSON.stringify(params, null, 2)}\n`;
if (args.out) { writeFileSync(args.out, text); console.log(`Wrote ${args.out}: cutover ${new Date(cutoverMs).toISOString()}, genesis tick ${genesisTickNo}`); } else process.stdout.write(text);
