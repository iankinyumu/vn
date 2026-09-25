import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { inspect, promisify } from 'node:util';
import EmbeddedPostgres from 'embedded-postgres';

const execFileAsync = promisify(execFile);
const databaseDir = path.join(os.tmpdir(), `smartprofit-engine-${process.pid}-${Date.now()}`);
const port = await findFreePort();
const postgres = new EmbeddedPostgres({ databaseDir, port, user: 'postgres', password: 'postgres', persistent: false, onLog: () => {}, onError: () => {} });
let client;

/* A stale cluster left behind by an interrupted run keeps its port bound, and
   embedded-postgres rejects with a bare `undefined` when its port is busy. Ask
   the OS for a port that is free right now instead of hard-coding one. */
function findFreePort() {
    return new Promise((resolve, reject) => {
        const probe = createServer();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const { port: freePort } = probe.address();
            probe.close(() => resolve(freePort));
        });
    });
}

function javascriptDigit(seed, mode, index, tickNo) {
    for (let counter = 0; ; counter++) {
        const block = createHmac('sha256', seed).update(`digit|${mode}|${index}|${tickNo}|${counter}`, 'utf8').digest();
        for (const value of block) if (value < 250) return value % 10;
    }
}

/* The SQL v3 functions are a third implementation; they must reproduce the
   frozen vectors that the Node generator and WebCrypto verifier also match. */
async function verifyV3Vectors(db) {
    const v = JSON.parse(await readFile(new URL('../engine/v3/vectors.json', import.meta.url), 'utf8'));
    const one = async (sql, params) => (await db.query(sql, params)).rows[0];
    const hexOf = async (sql, params) => (await one(`select encode((${sql}), 'hex') value`, params)).value;
    assert.equal(await hexOf(`engine_private.v3_hkdf32(decode($1,'hex'), decode($2,'hex'), decode($3,'hex'))`,
        [v.rfc5869_case1.salt, v.rfc5869_case1.ikm, v.rfc5869_case1.info]), v.rfc5869_case1.okm_first_32);
    assert.equal(await hexOf(`engine_private.v3_tick_message(0, 0)`), v.encoding.tick_msg_zero);
    assert.equal(await hexOf(`engine_private.v3_tick_message(18446744073709551615, 4294967295)`), v.encoding.tick_msg_max);
    for (const [index, sigma] of Object.entries(v.sigma_e12)) {
        const entry = v.config.indices.find((e) => e.index === index);
        assert.equal((await one(`select engine_private.v3_sigma_e12($1, $2)::text value`, [entry.annual_vol_bp, entry.tick_interval_ms])).value, sigma);
    }
    const configHash = await hexOf(`engine_private.v3_config_hash($1, $2, $3::jsonb)`, [v.config.env, v.config.mode, JSON.stringify(v.config.indices)]);
    assert.equal(configHash, v.config.config_hash);
    for (const epoch of v.epochs) {
        assert.equal(await hexOf(`engine_private.v3_seed_hash(decode($1,'hex'))`, [epoch.seed]), epoch.seed_hash);
        assert.equal(await hexOf(`engine_private.v3_epoch_commitment('test','DEMO',$1,decode($2,'hex'),decode($3,'hex'),decode($4,'hex'))`,
            [epoch.epoch_start_ms, epoch.seed_hash, configHash, epoch.prev_commitment]), epoch.commitment);
        for (const [index, keys] of Object.entries(epoch.keys)) {
            for (const [purpose, name] of [['price-move', 'move'], ['price-digit', 'digit']]) {
                assert.equal(await hexOf(`engine_private.v3_derive_key(decode($1,'hex'),$2,'test','DEMO',$3,$4)`, [epoch.seed, purpose, index, epoch.epoch_start_ms]), keys[name]);
            }
        }
    }
    const priceSql = `select p.price_units::text, p.digit, p.z::text, p.parity, p.residue, p.digit_counter::text, p.coarse::text
        from engine_private.v3_price(engine_private.v3_derive_key(decode($1,'hex'),'price-move','test','DEMO',$2,$3),
         engine_private.v3_derive_key(decode($1,'hex'),'price-digit','test','DEMO',$2,$3),$4,$5,$6,$7,$8,$9,$10) p`;
    for (const [index, rows] of Object.entries(v.series)) {
        const e = v.config.indices.find((entry) => entry.index === index);
        assert.equal(await hexOf(`engine_private.v3_genesis_hash('test','DEMO',$1,$2,$3,decode($4,'hex'))`, [index, e.genesis_tick_no, e.genesis_units, configHash]), v.genesis_hash[index]);
        for (const row of rows) {
            const seed = v.epochs.find((epoch) => epoch.epoch_start_ms === row.epoch_start_ms).seed;
            const got = await one(priceSql, [seed, index, row.epoch_start_ms, row.tick_no, row.prev_units, e.anchor_units, e.sigma_e12, e.kappa_e12, e.min_units, e.max_units]);
            assert.deepEqual(
                [got.price_units, Number(got.digit), got.z, Number(got.parity), Number(got.residue), Number(got.digit_counter), got.coarse],
                [row.price_units, row.digit, row.z, row.parity, row.residue, row.digit_counter, row.coarse], `${index} tick ${row.tick_no}`);
            assert.equal(await hexOf(`engine_private.v3_tick_hash('test','DEMO',$1,$2,$3,$4,$5,$6,$7,3,$8,decode($9,'hex'),decode($10,'hex'),decode($11,'hex'))`,
                [index, row.tick_no, row.scheduled_ms, row.generated_ms, row.epoch_start_ms, row.prev_units, row.price_units, row.digit, configHash, row.commitment, row.prev_tick_hash]), row.tick_hash);
        }
    }
    const r = v.rejection, re = v.config.indices.find((entry) => entry.index === r.index);
    const rejectionSeed = v.epochs.find((epoch) => epoch.epoch_start_ms === r.epoch_start_ms).seed;
    const rejected = await one(priceSql, [rejectionSeed, r.index, r.epoch_start_ms, r.tick_no, r.prev_units, re.anchor_units, re.sigma_e12, re.kappa_e12, re.min_units, re.max_units]);
    assert.deepEqual([rejected.price_units, Number(rejected.residue)], [r.price_units, r.residue]);
    for (const [sql, code] of [
        [`select engine_private.v3_label('SPI 10')`, 'engine_v3_label_invalid'],
        [`select engine_private.v3_uint(18446744073709551616, 8)`, 'engine_v3_integer_out_of_range'],
        [`select engine_private.v3_uint(-1, 8)`, 'engine_v3_integer_out_of_range'],
        [`select engine_private.v3_seed_hash('\\x00'::bytea)`, 'engine_v3_seed_invalid'],
        [`select engine_private.v3_derive_key(decode(repeat('00',32),'hex'),'price','test','DEMO','SPI10',0)`, 'engine_v3_purpose_invalid'],
        [`select * from engine_private.v3_price(decode(repeat('01',32),'hex'),decode(repeat('02',32),'hex'),1,10000000,10000000,251832452,534835,9999999,10000001)`, 'engine_v3_price_out_of_band'],
    ]) {
        await assert.rejects(db.query(sql), (error) => error.message.includes(code), sql);
    }
    const exposed = await one(`select count(*)::integer n from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='engine_private' and p.proname like 'v3\\_%'
        and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))`);
    assert.equal(exposed.n, 0, 'v3 functions must not be executable by API roles');
}

try {
    await postgres.initialise();
    await postgres.start();
    client = postgres.getPgClient();
    await client.connect();
    await client.query(`
        -- Supabase installs pgcrypto in the extensions schema; nothing is created in public.
        create schema extensions; create extension pgcrypto with schema extensions;
        create role anon; create role authenticated; create role service_role;
        create type public.execution_mode as enum ('DEMO','REAL'); create schema engine_private;
        create table public.engine_indices(code text, execution_mode public.execution_mode, tick_interval_ms integer, decimals smallint, base_price numeric, sigma_per_tick numeric, kappa numeric, status text, t0 timestamptz, primary key(code, execution_mode));
        create table public.index_state(index_code text, execution_mode public.execution_mode, last_tick_no bigint, last_x numeric, last_price numeric, updated_at timestamptz, primary key(index_code, execution_mode));
        create table public.engine_epochs(id uuid primary key, execution_mode public.execution_mode, starts_at timestamptz, ends_at timestamptz, seed_commitment text, prev_chain_hash text, chain_hash text, committed_at timestamptz default now(), revealed_seed text, revealed_at timestamptz);
        create table engine_private.epoch_seeds(epoch_id uuid primary key, execution_mode public.execution_mode, seed bytea);
        create table public.index_ticks(index_code text, execution_mode public.execution_mode, tick_no bigint, epoch_id uuid, scheduled_at timestamptz, generated_at timestamptz default now(), price numeric, digit smallint, primary key(index_code, execution_mode, tick_no));
        create table public.engine_contracts(index_code text, execution_mode public.execution_mode, state text, entry_tick_no bigint, settle_tick_no bigint);
        create table public.engine_policy_versions(version integer, tick_retention_days integer);
        create function public.engine_settle_tick(text, public.execution_mode, bigint) returns void language sql as 'select';
    `);
    for (const name of ['20260920250000_engine_deterministic_ticks.sql', '20260920380000_engine_determinism_hardening.sql', '20260920460000_engine_epoch_uuid_fix.sql', '20260920540000_engine_pgcrypto_schema_bridge.sql', '20260920560000_engine_unified_price_ticks.sql']) {
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
        insert into public.engine_indices values ('SPI10','DEMO',2000,3,1000,.0004,.0005,'ACTIVE',clock_timestamp()-interval '6 seconds');
        insert into public.index_state values ('SPI10','DEMO',0,null,null,clock_timestamp());
        select public.engine_advance();
    `);
    const generated = await client.query(`select count(*)::integer ticks, min(s.last_x) <> ln(1000::numeric) evolved from public.index_state s join public.index_ticks t on t.index_code=s.index_code and s.execution_mode=t.execution_mode group by s.last_x`);
    assert.ok(generated.rows.some((row) => row.ticks > 0 && row.evolved));
    const unified = await client.query(`select t.tick_no,t.price,t.digit,t.previous_price,t.generation_version,
      case when t.tick_no=1 then 1000::numeric else lag(t.price) over(order by t.tick_no) end prior
      from public.index_ticks t order by t.tick_no`);
    assert.ok(unified.rows.every((row) => Number(row.generation_version) === 2));
    assert.ok(unified.rows.every((row) => Number(row.previous_price) === Number(row.prior)));
    assert.ok(unified.rows.every((row) => Math.round(Number(row.price) * 1000) % 10 === Number(row.digit)));
    console.log('PostgreSQL pgcrypto digit, walk, and price invariant vectors: PASS');

    // Version 3 SQL reference functions, applied on top of existing v2 history.
    const historyBefore = await client.query(`select md5(string_agg(t::text, '|' order by tick_no)) digest from public.index_ticks t`);
    await client.query(await readFile(new URL('../supabase/migrations/20260924100000_engine_v3_reference_functions.sql', import.meta.url), 'utf8'));
    const historyAfter = await client.query(`select md5(string_agg(t::text, '|' order by tick_no)) digest from public.index_ticks t`);
    assert.equal(historyAfter.rows[0].digest, historyBefore.rows[0].digest, 'v3 migration must not touch v1/v2 ticks');
    await verifyV3Vectors(client);
    console.log('PostgreSQL pgcrypto engine v3 vectors (keys, commitments, prices, tick hashes): PASS');
} catch (error) {
    if (error instanceof Error) console.error(`Engine PostgreSQL harness failed: ${error.stack}`);
    else console.error(`Engine PostgreSQL harness failed with a non-Error value: ${inspect(error)}`);
    process.exitCode = 1;
} finally {
    if (client) await client.end().catch(() => {});
    const pid = postgres.process?.pid;
    if (pid) await execFileAsync('taskkill', ['/pid', String(pid), '/f', '/t']).catch(() => {});
    await rm(databaseDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
    process.exit(process.exitCode ?? 0);
}
