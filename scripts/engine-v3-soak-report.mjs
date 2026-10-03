// Observed behaviour of live v3 (or shadow) ticks against the pre-registered
// bands of ADR 0001 §7, for the practice-soak / shadow-run evidence files.
//
//   ENGINE_REPORT_DATABASE_URL=postgres://readonly@... node scripts/engine-v3-soak-report.mjs [--shadow] [--days 7]
//
// Use a read-only role with SELECT on index_ticks / engine_v3_shadow_ticks /
// engine_v3_epochs / engine_v3_witness_receipts / engine_v3_checkpoints.
import pg from 'pg';

const args = process.argv.slice(2);
const shadow = args.includes('--shadow');
const days = Number(args[args.indexOf('--days') + 1]) || 7;
const table = shadow ? 'public.engine_v3_shadow_ticks' : 'public.index_ticks';
const filter = shadow ? 'true' : 't.generation_version=3';
const db = new pg.Client({ connectionString: process.env.ENGINE_REPORT_DATABASE_URL });
await db.connect();
const TPY = 15_768_000;
const chi = (counts, expected) => counts.reduce((a, n) => a + (n - expected) ** 2 / expected, 0);
const report = { generated_at: new Date().toISOString(), source: shadow ? 'shadow' : 'live', days, indices: [] };
try {
    const indices = (await db.query(`select code, (select (x->>'annual_vol_bp')::int from public.engine_v3_configs c, jsonb_array_elements(c.entries) x where x->>'index'=code limit 1) vol_bp from public.engine_indices where execution_mode='DEMO' order by sort_order`)).rows;
    for (const { code, vol_bp: volBp } of indices) {
        const { rows } = await db.query(`select t.tick_no::bigint n,t.price::float8 p,t.previous_price::float8 q,t.digit d,
            ${shadow ? 't.generated_at' : 't.generated_at'} - t.scheduled_at lag
            from ${table} t where t.index_code=$1 and t.execution_mode='DEMO' and ${filter} and t.scheduled_at>now()-make_interval(days=>$2) order by t.tick_no`, [code, days]);
        if (!rows.length) { report.indices.push({ index: code, ticks: 0 }); continue; }
        const r = rows.map((x) => Math.log(x.p / x.q));
        const mean = r.reduce((a, b) => a + b, 0) / r.length;
        const sd = Math.sqrt(r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1));
        const digits = Array(10).fill(0); rows.forEach((x) => digits[x.d]++);
        let gaps = 0; for (let i = 1; i < rows.length; i++) if (BigInt(rows[i].n) !== BigInt(rows[i - 1].n) + 1n) gaps++;
        const lagSeconds = rows.map((x) => (x.lag?.seconds || 0) + (x.lag?.milliseconds || 0) / 1000).sort((a, b) => a - b);
        const observed = sd * Math.sqrt(TPY), target = volBp / 10000;
        report.indices.push({
            index: code, ticks: rows.length, sequence_gaps: gaps, target_annual: target, observed_annual: observed, relative_error: observed / target - 1,
            within_band: Math.abs(observed / target - 1) < (rows.length >= 1_000_000 ? 0.01 : 0.03),
            digit_chi2: chi(digits, rows.length / 10), digit_chi2_pass: chi(digits, rows.length / 10) < 33.72,
            lag_p50_s: lagSeconds[Math.floor(lagSeconds.length / 2)], lag_p99_s: lagSeconds[Math.floor(lagSeconds.length * 0.99)], lag_max_s: lagSeconds.at(-1),
        });
    }
    report.epochs = (await db.query(`select e.epoch_start_ms::text, e.committed_at, (select count(*) from public.engine_v3_witness_receipts r where r.subject_hash=e.commitment
        and floor(extract(epoch from r.gen_time)*1000)<e.epoch_start_ms) witnessed_before_start from public.engine_v3_epochs e where e.execution_mode='DEMO' and e.epoch_start_ms>(extract(epoch from now())*1000-$1::bigint*86400000) order by 1`, [days])).rows;
} finally { await db.end(); }
console.log(JSON.stringify(report, null, 2));
