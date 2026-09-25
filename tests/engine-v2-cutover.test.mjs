// Rollout of the pending migrations onto a database in the live state (version 1
// ticks, chain up to 20260920550000). Applying 20260920560000 and the four v3
// migrations must not change any live price: every index keeps producing the
// exact version 1 series until its scheduled version 2 start tick.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { FUNDING_MIGRATIONS, V3_MIGRATIONS, asUser, createRealDatabase } from './helpers/pg-real.mjs';

const V2 = '20260920560000_engine_unified_price_ticks.sql';
const PENDING = [V2, ...V3_MIGRATIONS, ...FUNDING_MIGRATIONS];
const DAY = 86400000;

async function apply(db, names) {
    for (const name of names) await db.exec((await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8')).replace(/^﻿/, ''));
}
const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
// Moves every index's schedule back, so `seconds` more ticks are due without waiting.
const elapse = (db, seconds) => db.exec(`update public.engine_indices set t0=t0-interval '${seconds} seconds'`);

// The pre-20260920560000 engine_advance, recomputed tick by tick from the previous log price.
async function expectVersion1(db, index, fromTick, startX) {
    const ticks = (await db.query(`select tick_no::int,price,digit,generation_version from public.index_ticks
        where index_code=$1 and execution_mode='DEMO' and tick_no>=$2 order by tick_no`, [index, fromTick])).rows;
    let x = startX;
    for (const tick of ticks) {
        const expected = await one(db, `select v.x::text x,public.engine_tick_price(i.base_price,i.decimals,v.x,d.digit) price,d.digit
            from public.index_ticks t join engine_private.epoch_seeds s on s.epoch_id=t.epoch_id
            join public.engine_indices i on i.code=t.index_code and i.execution_mode=t.execution_mode
            cross join lateral (select public.engine_digit(s.seed,t.execution_mode,t.index_code,t.tick_no) digit) d
            cross join lateral (select $3::numeric+i.kappa*(ln(i.base_price)-$3::numeric)+i.sigma_per_tick*public.engine_walk_normal(s.seed,t.execution_mode,t.index_code,t.tick_no) x) v
            where t.index_code=$1 and t.execution_mode='DEMO' and t.tick_no=$2`, [index, tick.tick_no, x]);
        assert.equal(Number(tick.generation_version), 1, `tick ${tick.tick_no} is version 1`);
        assert.equal(tick.price, expected.price, `tick ${tick.tick_no} price is the version 1 price`);
        assert.equal(Number(tick.digit), Number(expected.digit));
        x = expected.x;
    }
    return ticks.length;
}

test('applying the pending chain changes no live price, parameter or history', async () => {
    const { db, close } = await createRealDatabase({ extra: [], before: V2 });
    try {
        await db.exec(`update public.engine_indices set t0=clock_timestamp()-interval '30 seconds'`);
        await db.query('select public.engine_advance()');
        const account = (await asUser(db, 'customer', () => db.query('select public.enroll_practice_account() id'))).rows[0].id;
        await asUser(db, 'customer', () => db.query(`select public.engine_buy_contract($1,'SPI10','EVEN',null,5,1,'open-across-rollout')`, [account]));
        const params = `select string_agg(concat_ws(',',code,execution_mode,sigma_per_tick,kappa,base_price,decimals,tick_interval_ms,t0,status),'|' order by code,execution_mode) v from public.engine_indices`;
        const history = `select count(*)::int n,md5(string_agg(concat_ws(',',index_code,execution_mode,tick_no,epoch_id,scheduled_at,generated_at,price,digit),'|' order by index_code,tick_no)) d from public.index_ticks`;
        const paramsBefore = await one(db, params);
        const historyBefore = await one(db, history);
        const state = await one(db, `select last_tick_no::int n,coalesce(last_x,ln(1000::numeric))::text x from public.index_state where index_code='SPI10' and execution_mode='DEMO'`);
        assert.ok(historyBefore.n > 10);

        await apply(db, PENDING);

        assert.deepEqual(await one(db, params), paramsBefore, 'version 1 parameters are unchanged');
        assert.deepEqual(await one(db, history), historyBefore, 'existing ticks are unchanged');
        assert.equal((await one(db, 'select count(*)::int n from public.engine_indices where v2_start_tick_no is not null')).n, 0, 'no index is scheduled');
        assert.equal((await one(db, `select count(*)::int n from public.engine_indices where execution_mode='DEMO' and (v2_sigma_per_tick is null or v2_kappa is null)`)).n, 0, 'version 2 parameters are staged');
        assert.equal((await one(db, 'select count(*)::int n from public.index_ticks where generation_version<>1')).n, 0);

        await elapse(db, 14);
        assert.ok((await one(db, 'select public.engine_advance() n')).n > 0);
        assert.ok(await expectVersion1(db, 'SPI10', state.n + 1, state.x) >= 7, 'the series continues exactly as version 1');
        assert.equal((await one(db, 'select count(*)::int n from public.index_ticks where generation_version<>1')).n, 0, 'every index stays on version 1');
        assert.equal((await one(db, `select count(*)::int n from public.engine_contracts where state='OPEN'`)).n, 0, 'the open contract settled on version 1 ticks');
        const rows = (await asUser(db, 'customer', () => db.query(`select * from public.get_tick_verification_data($1,'SPI10',0,500)`, [account]))).rows;
        assert.ok(rows.length > 10 && rows.every((row) => Number(row.generation_version) === 1));
    } finally { await close(); }
});

test('scheduling a version 2 start: staff with fresh MFA or a SQL operator, a UTC day boundary, 12 hours notice, audited', async () => {
    const { db, close } = await createRealDatabase();
    try {
        const nextBoundary = Math.floor(Date.now() / DAY) * DAY + 2 * DAY;
        const iso = (ms) => new Date(ms).toISOString();
        const schedule = (start, index = 'SPI10') => db.query(`select public.engine_schedule_v2_start('DEMO',$1,$2::timestamptz,'Announced version 2 start') tick`, [index, start]);
        await assert.rejects(asUser(db, 'customer', () => schedule(iso(nextBoundary))), /forbidden/);
        await assert.rejects(asUser(db, 'owner', () => schedule(iso(nextBoundary)), 'aal1'), /mfa_required/);
        await assert.rejects(asUser(db, 'owner', () => schedule(iso(nextBoundary + 3600000))), /engine_v2_start_not_boundary/);
        await assert.rejects(asUser(db, 'owner', () => schedule(iso(Math.floor(Date.now() / DAY) * DAY))), /engine_v2_notice_too_short/);
        await assert.rejects(asUser(db, 'owner', () => db.query(`select public.engine_schedule_v2_start('DEMO','SPI10',$1::timestamptz,'short')`, [iso(nextBoundary)])), /validation_failed/);
        await assert.rejects(asUser(db, 'owner', () => schedule(iso(nextBoundary), 'NOPE')), /index_not_available/);
        await assert.rejects(asUser(db, 'owner', () => db.query(`select engine_private.operator_schedule_v2_start('DEMO','SPI10',$1::timestamptz,'Announced version 2 start')`, [iso(nextBoundary)])), /permission denied/);

        const tick = Number((await asUser(db, 'owner', () => schedule(iso(nextBoundary)))).rows[0].tick);
        const t0 = Number((await one(db, `select floor(extract(epoch from t0)*1000)::bigint ms from public.engine_indices where code='SPI10' and execution_mode='DEMO'`)).ms);
        assert.equal(tick, Math.ceil((nextBoundary - t0) / 2000), 'the first tick scheduled at or after the boundary');
        assert.equal(Number((await one(db, `select v2_start_tick_no from public.engine_indices where code='SPI10' and execution_mode='DEMO'`)).v2_start_tick_no), tick);
        const audit = await one(db, `select actor_type,reason,after_state from public.admin_audit_events where action='engine.schedule_v2_start'`);
        assert.equal(audit.actor_type, 'staff');
        assert.equal(Number(audit.after_state.v2_start_tick_no), tick);
        // Customers see the scheduled time of the first version 2 tick.
        const config = (await asUser(db, 'customer', () => db.query('select public.get_engine_config() c'))).rows[0].c;
        const spi10 = config.indices.find((item) => item.code === 'SPI10');
        assert.equal(new Date(spi10.v2_starts_at).getTime(), t0 + tick * 2000);
        assert.ok(config.indices.filter((item) => item.code !== 'SPI10').every((item) => item.v2_starts_at === null));

        // Rescheduling before the start is allowed; the SQL operator path is audited as an operator.
        const later = Number((await one(db, `select engine_private.operator_schedule_v2_start('DEMO','SPI10',$1::timestamptz,'Moved one day later') tick`, [iso(nextBoundary + DAY)])).tick);
        assert.equal(later, tick + DAY / 2000);
        assert.equal((await one(db, `select count(*)::int n from public.admin_audit_events where action='engine.schedule_v2_start' and actor_type='operator'`)).n, 1);
        // Nothing changes before the start.
        await db.exec(`update public.engine_indices set t0=clock_timestamp()-interval '10 seconds'`);
        await db.query('select public.engine_advance()');
        assert.equal((await one(db, 'select count(*)::int n from public.index_ticks where generation_version<>1')).n, 0);
    } finally { await close(); }
});

test('at the scheduled tick the index switches to version 2, continuing from the last version 1 price', async () => {
    const { db, close } = await createRealDatabase();
    try {
        await db.exec(`update public.engine_indices set t0=clock_timestamp()-interval '20 seconds'`);
        await db.query('select public.engine_advance()');
        const last = Number((await one(db, `select last_tick_no from public.index_state where index_code='SPI10' and execution_mode='DEMO'`)).last_tick_no);
        const start = last + 3;
        // Stands in for the scheduled time arriving (scheduling itself needs 12 hours' notice).
        await db.query(`update public.engine_indices set v2_start_tick_no=$1 where code='SPI10' and execution_mode='DEMO'`, [start]);
        await elapse(db, 16);
        await db.query('select public.engine_advance()');
        const ticks = (await db.query(`select tick_no::int,price,digit,generation_version,previous_price,generation_sigma,generation_kappa,generation_base_price
            from public.index_ticks where index_code='SPI10' and execution_mode='DEMO' order by tick_no`)).rows;
        assert.ok(ticks.at(-1).tick_no >= start + 3);
        for (const [i, tick] of ticks.entries()) {
            assert.equal(Number(tick.generation_version), tick.tick_no < start ? 1 : 2, `tick ${tick.tick_no}`);
            if (tick.tick_no < start) continue;
            assert.equal(tick.previous_price, ticks[i - 1].price, 'continuous with the previous tick');
            assert.equal(Number(tick.digit), Math.round(Number(tick.price) * 1000) % 10, 'the digit is the final price digit');
            assert.equal(Number(tick.generation_sigma), .0002);
            assert.equal(Number(tick.generation_kappa), .003);
        }
        assert.equal((await one(db, `select count(*)::int n from public.index_ticks where index_code<>'SPI10' and generation_version<>1`)).n, 0, 'other indices stay on version 1');
        const account = (await asUser(db, 'customer', () => db.query('select public.enroll_practice_account() id'))).rows[0].id;
        const versions = (await asUser(db, 'customer', () => db.query(`select distinct generation_version v from public.get_tick_verification_data($1,'SPI10',0,500) order by 1`, [account]))).rows.map((r) => Number(r.v));
        assert.deepEqual(versions, [1, 2]);
        const next = Math.floor(Date.now() / DAY) * DAY + 2 * DAY;
        await assert.rejects(db.query(`select engine_private.operator_schedule_v2_start('DEMO','SPI10',$1::timestamptz,'Try to move a started index')`, [new Date(next).toISOString()]), /engine_v2_already_started/);
    } finally { await close(); }
});

// The live push runs through the Supabase CLI, which sends each migration as a
// pipeline of statements outside a transaction block (so LOCK TABLE and SET LOCAL
// fail there, as the second live attempt showed). This rehearsal pushes the pending
// migrations with the real CLI to a database in the live state, while a tick
// transaction is mid-flight: it holds engine_indices and then needs index_ticks.
// The first live attempt deadlocked in exactly this interleaving.
test('supabase db push applies the pending chain while a tick is in flight, without deadlock', async () => {
    const { db, connect, port, close } = await createRealDatabase({ extra: [], before: V2 });
    const tick = await connect();
    try {
        const all = (await readdir(new URL('../supabase/migrations/', import.meta.url))).filter((name) => name.endsWith('.sql')).sort();
        assert.deepEqual(all.filter((name) => name >= V2), PENDING, 'the pending set matches the live dry run');
        for (const name of PENDING) {
            const sql = await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
            assert.doesNotMatch(sql, /^\s*(lock\s+table|set\s+local|begin\s*;|commit\s*;)/im, `${name} must run outside a transaction block`);
        }
        await db.exec(`create schema supabase_migrations;
            create table supabase_migrations.schema_migrations(version text primary key, statements text[], name text)`);
        for (const name of all.filter((item) => item < V2)) await db.query('insert into supabase_migrations.schema_migrations(version,name) values($1,$2)', name.replace('.sql', '').split(/_(.*)/s).slice(0, 2));
        await db.exec(`update public.engine_indices set t0=clock_timestamp()-interval '20 seconds'`);
        await db.query('select public.engine_advance()');

        await tick.query('begin');
        await tick.query('select count(*) from public.engine_indices'); // engine_advance reads its indices first
        const cli = `"${fileURLToPath(new URL(`../node_modules/.bin/supabase${process.platform === 'win32' ? '.cmd' : ''}`, import.meta.url))}"`;
        let exited = null;
        const push = new Promise((resolve) => {
            execFile(cli, ['db', 'push', '--db-url', `postgresql://postgres:postgres@127.0.0.1:${port}/postgres?sslmode=disable`, '--yes'],
                { shell: true, timeout: 240000 }, (error, stdout, stderr) => { exited = error ? error.code ?? 1 : 0; resolve({ stdout, stderr }); });
        });
        await new Promise((resolve) => setTimeout(resolve, 4000));
        if (exited !== null) { const early = await push; assert.fail(`the push ended before the tick transaction finished:\n${early.stdout}\n${early.stderr}`); }
        await tick.query('lock table public.index_ticks in row exclusive mode'); // then inserts its tick
        await tick.query('commit');
        const output = await push;
        assert.equal(exited, 0, `supabase db push failed:\n${output.stderr}`);
        const applied = (await db.query('select version from supabase_migrations.schema_migrations where version>=$1 order by 1', [V2.slice(0, 14)])).rows.map((row) => row.version);
        assert.deepEqual(applied, PENDING.map((name) => name.slice(0, 14)));
        assert.equal((await one(db, 'select count(*)::int n from public.engine_indices where v2_start_tick_no is not null')).n, 0);
        await elapse(db, 6);
        assert.ok((await one(db, 'select public.engine_advance() n')).n > 0, 'ticks continue after the push');
        assert.equal((await one(db, 'select count(*)::int n from public.index_ticks where generation_version<>1')).n, 0);
    } finally { await tick.end().catch(() => {}); await close(); }
});
