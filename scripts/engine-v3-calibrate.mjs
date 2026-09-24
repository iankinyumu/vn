// Calibration harness for engine v3 (ADR 0001 §7). Statistics here are
// diagnostics in floating point; nothing in this file is normative.
//
//   node scripts/engine-v3-calibrate.mjs [--ticks 1000000] [--seeds 4] [--first-seed 0]
//        [--indices SPI10,SPI100] [--out docs/calibration/engine-v3]
//
// Seeds are SHA-256("calibration-<n>") in env=test: public, held out from any
// real stream, and reproducible by anyone.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import * as g from '../engine/v3/generator.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, token, i, all) => (token.startsWith('--') ? [...pairs, [token.slice(2), all[i + 1]]] : pairs), []));
const TICKS = Number(args.ticks ?? 1_000_000);
const SEEDS = Number(args.seeds ?? 4);
const FIRST_SEED = Number(args['first-seed'] ?? 0);
const INDICES = (args.indices ?? g.INDICES.join(',')).split(',');
const OUT = args.out ?? 'docs/calibration/engine-v3';
const DAY_TICKS = 43_200;

// Pre-registered bands (ADR 0001 §7). Do not tune these after seeing results.
const Z4 = 3.719016485; // one-sided normal quantile at p = 1e-4
const chiCritical = (df) => df * (1 - 2 / (9 * df) + Z4 * Math.sqrt(2 / (9 * df))) ** 3; // Wilson–Hilferty
const BANDS = {
    volFull: 0.01, volDay: 0.03, driftZ: 5, acfZ: 5, kurtosis: [-0.15, -0.05], maxAbsE: 6.0,
    digitChi: 33.72, pairChi: chiCritical(81), runPerMillion: 12, logDevSd: 8,
};

function seedFor(n) { return createHash('sha256').update(`calibration-${n}`).digest(); }

function run(index, seedNo) {
    const config = g.defaultConfig({ env: 'test', mode: 'DEMO', t0Ms: 0n });
    const entry = config.indices.find((e) => e.index === index);
    // A fresh epoch seed each day, derived from the calibration seed and the day.
    const root = seedFor(seedNo);
    const ledger = g.createEpochLedger({ config, seedForEpoch: (start) => createHash('sha256').update(root).update(g.u64(start)).digest() });
    const series = g.createSeries({ ledger, index });
    const sigma = Number(entry.sigma_e12) / 1e12, kappa = Number(entry.kappa_e12) / 1e12, anchor = Number(entry.anchor_units);
    const tpy = Number(g.ticksPerYear(entry.tick_interval_ms));
    const stationarySd = sigma / Math.sqrt(2 * kappa);

    let n = 0, sumR = 0, sumR2 = 0, sumE = 0, sumE2 = 0, sumE3 = 0, sumE4 = 0, sumEE = 0, prevE = null, maxAbsE = 0;
    let dayN = 0, daySum = 0, daySum2 = 0, worstDay = 0;
    let minUnits = Infinity, maxUnits = -Infinity, maxLogDev = 0;
    const digits = new Array(10).fill(0), pairs = new Array(100).fill(0);
    let prevDigit = null, run = 0, longestRunBlock = 0, worstRun = 0;
    const started = Date.now();
    for (let i = 0; i < TICKS; i++) {
        const { tick } = series.next();
        const P = Number(tick.prev_units), next = Number(tick.price_units);
        const r = Math.log(next / P);
        const e = (next - P - kappa * (anchor - P)) / (P * sigma);
        n++; sumR += r; sumR2 += r * r;
        sumE += e; sumE2 += e * e; sumE3 += e * e * e; sumE4 += e * e * e * e;
        if (prevE !== null) sumEE += prevE * e;
        prevE = e; maxAbsE = Math.max(maxAbsE, Math.abs(e));
        dayN++; daySum += r; daySum2 += r * r;
        if (dayN === DAY_TICKS) {
            const vol = Math.sqrt((daySum2 - daySum * daySum / dayN) / (dayN - 1) * tpy);
            worstDay = Math.max(worstDay, Math.abs(vol / (sigma * Math.sqrt(tpy)) - 1));
            dayN = 0; daySum = 0; daySum2 = 0;
        }
        minUnits = Math.min(minUnits, next); maxUnits = Math.max(maxUnits, next);
        maxLogDev = Math.max(maxLogDev, Math.abs(Math.log(next / anchor)) / stationarySd);
        digits[tick.digit]++;
        if (prevDigit !== null) pairs[prevDigit * 10 + tick.digit]++;
        run = prevDigit === tick.digit ? run + 1 : 1;
        longestRunBlock = Math.max(longestRunBlock, run);
        if ((i + 1) % 1_000_000 === 0) { worstRun = Math.max(worstRun, longestRunBlock); longestRunBlock = 0; }
        prevDigit = tick.digit;
    }
    worstRun = Math.max(worstRun, longestRunBlock);

    const meanE = sumE / n, varE = sumE2 / n - meanE ** 2;
    const m4 = sumE4 / n - 4 * meanE * sumE3 / n + 6 * meanE ** 2 * sumE2 / n - 3 * meanE ** 4;
    const lag1 = (sumEE / (n - 1) - meanE ** 2) / varE;
    const realisedVol = Math.sqrt((sumR2 - sumR * sumR / n) / (n - 1) * tpy);
    const targetVol = sigma * Math.sqrt(tpy);
    const expected = n / 10;
    const digitChi = digits.reduce((total, count) => total + (count - expected) ** 2 / expected, 0);
    const pairTotal = n - 1;
    const rows = Array.from({ length: 10 }, (_, a) => pairs.slice(a * 10, a * 10 + 10).reduce((x, y) => x + y, 0));
    const cols = Array.from({ length: 10 }, (_, b) => rows.reduce((total, _row, a) => total + pairs[a * 10 + b], 0));
    let pairChi = 0;
    for (let a = 0; a < 10; a++) for (let b = 0; b < 10; b++) { const exp = rows[a] * cols[b] / pairTotal; pairChi += (pairs[a * 10 + b] - exp) ** 2 / exp; }

    const metrics = {
        index, seed: `calibration-${seedNo}`, ticks: n, seconds: (Date.now() - started) / 1000,
        target_vol: targetVol, realised_vol: realisedVol, vol_ratio_error: realisedVol / targetVol - 1, worst_day_vol_error: worstDay,
        drift_z: meanE * Math.sqrt(n), lag1_acf_z: lag1 * Math.sqrt(n), excess_kurtosis: m4 / varE ** 2 - 3, max_abs_e: maxAbsE,
        digit_chi2: digitChi, pair_chi2: pairChi, longest_run_per_million: worstRun,
        min_price: minUnits / 1000, max_price: maxUnits / 1000, max_log_dev_sd: maxLogDev, digits,
    };
    const checks = {
        vol: n >= 1_000_000 ? Math.abs(metrics.vol_ratio_error) < BANDS.volFull : null,
        vol_day: n >= DAY_TICKS ? worstDay < BANDS.volDay : null,
        drift: Math.abs(metrics.drift_z) < BANDS.driftZ,
        acf: Math.abs(metrics.lag1_acf_z) < BANDS.acfZ,
        kurtosis: metrics.excess_kurtosis > BANDS.kurtosis[0] && metrics.excess_kurtosis < BANDS.kurtosis[1],
        tails: maxAbsE <= BANDS.maxAbsE,
        digits: digitChi < BANDS.digitChi,
        pairs: pairChi < BANDS.pairChi,
        runs: worstRun < BANDS.runPerMillion,
        range: minUnits >= Number(entry.min_units) && maxUnits <= Number(entry.max_units) && maxLogDev < BANDS.logDevSd,
    };
    return { metrics, checks, pass: Object.values(checks).every((value) => value !== false) };
}

const results = [];
for (const index of INDICES) {
    for (let s = FIRST_SEED; s < FIRST_SEED + SEEDS; s++) {
        const result = run(index, s);
        results.push(result);
        const failed = Object.entries(result.checks).filter(([, ok]) => ok === false).map(([name]) => name);
        console.log(`${index} calibration-${s}: vol ${(result.metrics.realised_vol * 100).toFixed(3)}% (target ${(result.metrics.target_vol * 100).toFixed(1)}%), `
            + `digit chi2 ${result.metrics.digit_chi2.toFixed(2)}, ${result.pass ? 'PASS' : `FAIL ${failed.join(',')}`} [${result.metrics.seconds.toFixed(1)}s]`);
    }
}

const git = (...a) => { try { return execFileSync('git', a, { encoding: 'utf8' }).trim(); } catch { return 'unknown'; } };
const commit = git('rev-parse', 'HEAD');
const dirty = git('status', '--porcelain', '--', 'engine/v3', 'scripts/engine-v3-calibrate.mjs') !== '';
const command = `node scripts/engine-v3-calibrate.mjs --ticks ${TICKS} --seeds ${SEEDS} --first-seed ${FIRST_SEED} --indices ${INDICES.join(',')} --out ${OUT}`;
const report = { spec: 'v3.0', generated_at: new Date().toISOString(), commit, engine_files_uncommitted: dirty, node: process.version, command, bands: BANDS, results };
const outPath = resolve(OUT);
mkdirSync(dirname(`${outPath}.json`), { recursive: true });
writeFileSync(`${outPath}.json`, `${JSON.stringify(report, null, 2)}\n`);

const pct = (x) => `${(x * 100).toFixed(3)}%`;
const lines = [
    '# Engine v3 calibration report', '',
    `Specification \`v3.0\`, commit \`${commit}\`${dirty ? ' (engine files had uncommitted changes)' : ''}, Node ${process.version}, generated ${report.generated_at}.`, '',
    'Reproduce with:', '', '```', command, '```', '',
    `Seeds are \`SHA-256("calibration-<n>")\`; each UTC-day epoch seed is \`SHA-256(root ‖ u64(epoch_start_ms))\`. Bands are pre-registered in ADR 0001 §7. The lag-one pair χ²(81) critical value is ${BANDS.pairChi.toFixed(1)}. A \`—\` check was not applicable at this sample size.`, '',
    '| Index | Seed | Ticks | Target | Realised | Error | Worst day | Drift z | ACF z | Ex. kurt | max\\|e\\| | Digit χ² | Pair χ² | Run | Price range | Max dev (sd) | Result |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...results.map(({ metrics: m, checks, pass }) => `| ${m.index} | ${m.seed} | ${m.ticks} | ${pct(m.target_vol)} | ${pct(m.realised_vol)} | ${pct(m.vol_ratio_error)} | ${checks.vol_day === null ? '—' : pct(m.worst_day_vol_error)} | ${m.drift_z.toFixed(2)} | ${m.lag1_acf_z.toFixed(2)} | ${m.excess_kurtosis.toFixed(3)} | ${m.max_abs_e.toFixed(2)} | ${m.digit_chi2.toFixed(2)} | ${m.pair_chi2.toFixed(1)} | ${m.longest_run_per_million} | ${m.min_price.toFixed(3)}–${m.max_price.toFixed(3)} | ${m.max_log_dev_sd.toFixed(2)} | ${pass ? 'PASS' : `**FAIL** (${Object.entries(checks).filter(([, ok]) => ok === false).map(([k]) => k).join(', ')})`} |`),
    '', `Overall: **${results.every((r) => r.pass) ? 'all runs within pre-registered bands' : 'at least one run outside its band — kept above, not rerun'}**.`, '',
    'Empirical digit tests are implementation diagnostics. Exact digit uniformity follows from the construction proved in ADR 0001 §6, not from these counts.', '',
];
writeFileSync(`${outPath}.md`, lines.join('\n'));
console.log(`Report: ${OUT}.md / .json`);
process.exitCode = results.every((r) => r.pass) ? 0 : 1;
