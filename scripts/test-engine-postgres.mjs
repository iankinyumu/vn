import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import EmbeddedPostgres from 'embedded-postgres';

const execFileAsync = promisify(execFile);
const databaseDir = path.join(os.tmpdir(), `astra-engine-${process.pid}-${Date.now()}`);
const postgres = new EmbeddedPostgres({ databaseDir, port: 55442, user: 'postgres', password: 'postgres', persistent: false, onLog: () => {}, onError: () => {} });
let client;

function javascriptDigit(seed, mode, index, tickNo) {
    for (let counter = 0; ; counter++) {
        const block = createHmac('sha256', seed).update(`digit|${mode}|${index}|${tickNo}|${counter}`, 'utf8').digest();
        for (const value of block) if (value < 250) return value % 10;
    }
}

try {
    await postgres.initialise();
    await postgres.start();
    client = postgres.getPgClient();
    await client.connect();
    await client.query(`
        create extension pgcrypto;
        create role anon; create role authenticated; create role service_role;
        create type public.execution_mode as enum ('DEMO','REAL'); create schema engine_private;
        create table public.engine_indices(code text, execution_mode public.execution_mode, decimals smallint, base_price numeric, sigma_per_tick numeric, kappa numeric, status text, t0 timestamptz, primary key(code, execution_mode));
        create table public.index_state(index_code text, execution_mode public.execution_mode, last_tick_no bigint, last_x numeric, last_price numeric, updated_at timestamptz, primary key(index_code, execution_mode));
        create table public.engine_epochs(id uuid primary key, execution_mode public.execution_mode, starts_at timestamptz, ends_at timestamptz, seed_commitment text, prev_chain_hash text, chain_hash text, committed_at timestamptz default now(), revealed_seed text, revealed_at timestamptz);
        create table engine_private.epoch_seeds(epoch_id uuid primary key, execution_mode public.execution_mode, seed bytea);
        create table public.index_ticks(index_code text, execution_mode public.execution_mode, tick_no bigint, epoch_id uuid, scheduled_at timestamptz, generated_at timestamptz default now(), price numeric, digit smallint, primary key(index_code, execution_mode, tick_no));
        create table public.engine_contracts(index_code text, execution_mode public.execution_mode, state text, entry_tick_no bigint, settle_tick_no bigint);
        create table public.engine_policy_versions(version integer, tick_retention_days integer);
        create function public.engine_settle_tick(text, public.execution_mode, bigint) returns void language sql as 'select';
    `);
    for (const name of ['20260920250000_engine_deterministic_ticks.sql', '20260920380000_engine_determinism_hardening.sql']) {
        await client.query(await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'));
    }
    const seed = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
    const expected = [2, 8, 3, 9, 8, 6, 1, 6, 7, 8, 7, 7, 6, 1, 9, 0, 1, 8, 2, 5];
    assert.deepEqual(Array.from({ length: 20 }, (_, index) => javascriptDigit(Buffer.from(seed, 'hex'), 'DEMO', 'SPI10', index + 1)), expected);
    const vectors = await client.query(`select public.engine_digit(decode($1,'hex'),'DEMO','SPI10',n) digit from generate_series(1,20) n`, [seed]);
    assert.deepEqual(vectors.rows.map((row) => Number(row.digit)), expected);
    const one = await client.query(`select public.engine_walk_normal(decode($1,'hex'),'DEMO','SPI10',7) value`, [seed]);
    const two = await client.query(`select public.engine_walk_normal(decode($1,'hex'),'DEMO','SPI10',7) value`, [seed]);
    assert.equal(one.rows[0].value, two.rows[0].value);
    const invariant = await client.query(`select public.engine_tick_price(1000::numeric,3::smallint,ln(1000::numeric),7::smallint) price`);
    assert.equal(Math.round(Number(invariant.rows[0].price) * 1000) % 10, 7);
    const invariantSweep = await client.query(`
        select count(*)::integer failures
        from generate_series(1, 100000) n
        cross join (values ('SPI10'), ('SPI25'), ('SPI50'), ('SPI75'), ('SPI100')) indices(code)
        cross join lateral (select (n % 10)::smallint digit, ln(1000::numeric) + ((n % 1000) - 500)::numeric / 100000 price_x) input
        cross join lateral (select public.engine_tick_price(1000::numeric, 3::smallint, input.price_x, input.digit) price) displayed
        where mod(round(displayed.price / .001)::bigint, 10) <> input.digit
    `);
    assert.equal(invariantSweep.rows[0].failures, 0);
    await client.query(`
        insert into public.engine_indices values ('SPI10','DEMO',3,1000,.0004,.0005,'ACTIVE',clock_timestamp()-interval '6 seconds');
        insert into public.index_state values ('SPI10','DEMO',0,null,null,clock_timestamp());
        select public.engine_advance();
    `);
    const generated = await client.query(`select count(*)::integer ticks, min(last_x) <> ln(1000::numeric) evolved from public.index_state join public.index_ticks on index_code=code and index_state.execution_mode=index_ticks.execution_mode group by last_x`);
    assert.ok(generated.rows.some((row) => row.ticks > 0 && row.evolved));
    console.log('PostgreSQL pgcrypto digit, walk, and price invariant vectors: PASS');
} catch (error) {
    console.error(error);
    process.exitCode = 1;
} finally {
    if (client) await client.end().catch(() => {});
    const pid = postgres.process?.pid;
    if (pid) await execFileAsync('taskkill', ['/pid', String(pid), '/f', '/t']).catch(() => {});
    await rm(databaseDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
    process.exit(process.exitCode ?? 0);
}
