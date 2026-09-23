// Deployment status for the digit-index engine, and an explicit migration applier.
//
//   node supabase/migration-status.cjs                      read-only report
//   node supabase/migration-status.cjs --apply <version>... apply exactly those local
//                                                           migrations, in order
//
// The connection string comes only from TRADING_DB_URL and is never printed.
// --apply runs each file in its own transaction, stops at the first failure
// (which rolls back that file), and records successes in
// supabase_migrations.schema_migrations so `supabase migration list` agrees.
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const migrationDir = path.join(__dirname, 'migrations');
const local = fs.readdirSync(migrationDir).filter((file) => /^\d{14}_.+\.sql$/.test(file)).sort()
    .map((file) => ({ version: file.slice(0, 14), name: file.slice(15, -4), file }));

async function exists(client, sql, args = []) { return (await client.query(sql, args)).rows[0]?.present === true; }

async function recordedVersions(client) {
    if (!await exists(client, "select to_regclass('supabase_migrations.schema_migrations') is not null as present")) return null;
    return new Set((await client.query('select version from supabase_migrations.schema_migrations')).rows.map((row) => row.version));
}

async function report(client) {
    const recorded = await recordedVersions(client);
    console.log('\n== Migration history (supabase_migrations.schema_migrations)');
    if (!recorded) console.log('No migration history table: earlier migrations were applied without the Supabase CLI, so the list below is inferred from objects only.');
    else for (const item of local) console.log(`${recorded.has(item.version) ? 'applied' : 'PENDING'}  ${item.file}`);

    console.log('\n== Engine objects');
    const objects = [
        ['table public.engine_indices (20260920210000)', "select to_regclass('public.engine_indices') is not null as present"],
        ['table public.index_ticks (20260920210000)', "select to_regclass('public.index_ticks') is not null as present"],
        ['table public.engine_contracts (20260920230000)', "select to_regclass('public.engine_contracts') is not null as present"],
        ...['enroll_practice_account', 'list_my_accounts', 'get_engine_config', 'get_recent_ticks', 'get_ticks_since', 'engine_advance', 'engine_buy_contract', 'get_account_summary', 'get_account_stats', 'list_admin_engine_epochs']
            .map((name) => [`function public.${name}`, `select exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='${name}') as present`]),
        ['extension pgcrypto', "select exists(select 1 from pg_extension where extname='pgcrypto') as present"],
        ['extension pg_cron >= 1.5', "select exists(select 1 from pg_extension where extname='pg_cron' and string_to_array(extversion,'.')::int[] >= array[1,5]) as present"],
        ['engine_contracts in supabase_realtime', "select exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='engine_contracts') as present"],
        ['realtime policy engine_demo_tick_receive', "select exists(select 1 from pg_policies where schemaname='realtime' and tablename='messages' and policyname='engine_demo_tick_receive') as present"],
    ];
    for (const [label, sql] of objects) console.log(`${await exists(client, sql) ? 'present' : 'MISSING'}  ${label}`);

    if (await exists(client, "select to_regnamespace('cron') is not null as present")) {
        console.log('\n== Engine cron jobs');
        const jobs = (await client.query("select jobname, schedule, active from cron.job where jobname in ('engine-advance','engine-reveal-due-epochs','engine-purge-ticks') order by jobname")).rows;
        if (!jobs.length) console.log('MISSING  no engine cron jobs are scheduled');
        for (const job of jobs) console.log(`${job.active ? 'active ' : 'INACTIVE'}  ${job.jobname} (${job.schedule})`);
        if (await exists(client, "select to_regclass('cron.job_run_details') is not null as present")) {
            const runs = (await client.query("select d.status, d.start_time, left(coalesce(d.return_message,''),200) as message from cron.job_run_details d join cron.job j on j.jobid=d.jobid where j.jobname='engine-advance' order by d.start_time desc limit 3")).rows;
            for (const run of runs) console.log(`  engine-advance ${run.start_time.toISOString()} ${run.status} ${run.message}`);
        }
    }

    if (await exists(client, "select to_regclass('public.index_state') is not null as present")) {
        console.log('\n== Tick progress (two readings, 5 s apart)');
        const read = async () => (await client.query("select index_code, execution_mode, last_tick_no, updated_at from public.index_state order by execution_mode, index_code")).rows;
        const first = await read();
        await new Promise((resolve) => setTimeout(resolve, 5000));
        const second = await read();
        for (const row of second) {
            const before = first.find((item) => item.index_code === row.index_code && item.execution_mode === row.execution_mode);
            const moved = Number(row.last_tick_no) - Number(before?.last_tick_no ?? row.last_tick_no);
            console.log(`${moved > 0 ? 'advancing' : 'STALLED  '}  ${row.execution_mode} ${row.index_code} tick ${row.last_tick_no} (+${moved}) updated ${row.updated_at ? row.updated_at.toISOString() : 'never'}`);
        }
        const epochs = (await client.query("select count(*)::int as count from public.engine_epochs")).rows[0].count;
        console.log(`epochs: ${epochs}`);
    }
}

async function apply(client, versions) {
    const recorded = await recordedVersions(client);
    const chosen = versions.map((version) => {
        const item = local.find((entry) => entry.version === version);
        if (!item) throw new Error(`No local migration has version ${version}.`);
        return item;
    }).sort((a, b) => a.version.localeCompare(b.version));
    for (const item of chosen) {
        if (recorded?.has(item.version)) { console.log(`skip     ${item.file} (already recorded)`); continue; }
        const sql = fs.readFileSync(path.join(migrationDir, item.file), 'utf8').replace(/^﻿/, '');
        await client.query('select pg_advisory_lock(638102900)');
        try {
            await client.query('begin');
            await client.query(sql);
            if (recorded) await client.query('insert into supabase_migrations.schema_migrations(version, name) values ($1, $2) on conflict (version) do nothing', [item.version, item.name]);
            await client.query('commit');
            console.log(`applied  ${item.file}`);
        } catch (error) {
            await client.query('rollback').catch(() => {});
            const line = Number(error.position) ? sql.slice(0, Number(error.position) - 1).split('\n').length : null;
            throw new Error(`${item.file} failed and was rolled back: ${error.message}${line ? ` (line ${line})` : ''}`);
        } finally {
            await client.query('select pg_advisory_unlock(638102900)').catch(() => {});
        }
    }
}

(async () => {
    if (!process.env.TRADING_DB_URL) throw new Error('Set TRADING_DB_URL in this shell first (Supabase dashboard -> Project Settings -> Database -> connection string).');
    const client = new Client({ connectionString: process.env.TRADING_DB_URL, ssl: { rejectUnauthorized: false } });
    client.on('error', () => {});
    await client.connect();
    try {
        const args = process.argv.slice(2);
        if (args[0] === '--apply') {
            if (args.length < 2) throw new Error('List the migration versions to apply, e.g. --apply 20260920510000');
            await apply(client, args.slice(1));
        } else await report(client);
    } finally { await client.end(); }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
