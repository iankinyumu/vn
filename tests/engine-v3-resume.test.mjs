// Engine v3.1 rescale drill on real PostgreSQL (ADR 0001 §5.6, §5.7): a running
// index below a tenth of its anchor is rescaled x10 at an announced UTC midnight.
// The drill moves a test-only clock offset that both the database
// (engine_private.v3_now_ms) and the worker read, so three days pass in seconds.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';
import * as g from '../engine/v3/generator.mjs';
import { LocalCustody } from '../engine/v3/service/custody.mjs';
import { Ed25519Signer } from '../engine/v3/service/signer.mjs';
import { EngineWorker } from '../engine/v3/service/worker.mjs';
import { asUser, createRealDatabase } from './helpers/pg-real.mjs';

const DAY = 86_400_000;
const INTERVAL = 2000;
let T, db, wdb, worker, offset = 0, t0, today, rescaleEpoch, pauseAfter, resumeGenesis, firstTick;
const rows = async (client, sql, args = []) => (await client.query(sql, args)).rows;
const errorOf = async (promise) => { try { await promise; return null; } catch (error) { return error.message; } };
const setClock = async (ms) => { offset = ms - Date.now(); await db.query('update engine_private.test_clock set offset_ms=$1', [offset]); };
const tickTime = (tickNo) => t0 + tickNo * INTERVAL;
const lastTick = async () => (await rows(db, `select tick_no::int n,round(price*1000)::bigint u from public.index_ticks where index_code='SPI50' and generation_version=3 order by tick_no desc limit 1`))[0];

before(async () => {
    T = await createRealDatabase();
    db = T.db;
    // Test-only clock: every v3 function reads v3_now_ms, which now adds an offset.
    await db.exec(`create table engine_private.test_clock(offset_ms bigint not null); insert into engine_private.test_clock values(0);
        create or replace function engine_private.v3_now_ms() returns bigint language sql volatile set search_path='' as $$
         select floor(extract(epoch from clock_timestamp())*1000)::bigint+(select offset_ms from engine_private.test_clock) $$;`);
    await asUser(db, 'ian', () => db.query(`select public.engine_v3_configure('test',$1::jsonb,'rescale drill environment')`,
        [JSON.stringify({ min_commit_lead_ms: -DAY, reveal_delay_ms: 0, required_witnesses: [] })]));
    await db.exec(`create role engine_resume_login login password 'resume-test' in role engine_tick_writer`);
    wdb = await T.connect('engine_resume_login', 'resume-test');
    t0 = Number((await rows(db, `select floor(extract(epoch from t0)*1000)::bigint t0 from public.engine_indices where code='SPI50'`))[0].t0);
    today = Math.floor(Date.now() / DAY) * DAY;
    rescaleEpoch = today + 3 * DAY;
    pauseAfter = Math.floor((rescaleEpoch - 4_500_000 - t0) / INTERVAL);
    resumeGenesis = Math.floor((rescaleEpoch - 1 - t0) / INTERVAL);
    firstTick = pauseAfter - 30;
    // SPI50 runs on v3 from tick firstTick at 900.000, below a tenth of its 10000.000 anchor.
    const params = Object.fromEntries(g.INDICES.map((index) => [index, {
        annual_vol_bp: g.ANNUAL_VOL_BP[index], anchor_units: 10_000_000, kappa_e12: 0, min_units: 500_000, max_units: 200_000_000,
        genesis_tick_no: firstTick, genesis_units: index === 'SPI50' ? 900_000 : 10_000_000,
    }]));
    await db.query(`update public.engine_indices set engine_generation=3 where code='SPI50'`);
    await db.query(`update public.index_state set last_tick_no=$1,last_price=900,updated_at=now() where index_code='SPI50'`, [firstTick]);
    worker = new EngineWorker({ db: wdb, mode: 'DEMO', params, custody: new LocalCustody(randomBytes(32)), signer: Ed25519Signer.generate('resume-drill-1'),
        witnesses: [], clock: () => Date.now() + offset, commitAheadEpochs: 0, checkpointEvery: 1_000_000 });
    assert.equal(await worker.acquireLeadership(), true);
    await worker.registerSigningKey();
});
after(async () => { await wdb?.end().catch(() => {}); await T?.close(); });

test('a rescale is scheduled only when due, with a computed direction, a day ahead of an uncommitted epoch', async () => {
    const first = await worker.cycle();
    assert.equal(first.committed, 1, JSON.stringify(first));
    const schedule = (epoch, reason = 'rescale drill: price below a tenth of the anchor') =>
        db.query(`select engine_private.operator_schedule_rescale('DEMO','SPI50',$1,$2) r`, [epoch, reason]);
    assert.match(await errorOf(schedule(today)), /engine_v3_resume_epoch_committed/);
    assert.match(await errorOf(schedule(today + DAY)), /engine_v3_resume_notice_too_short/);
    assert.match(await errorOf(schedule(rescaleEpoch + 1)), /engine_v3_resume_not_boundary/);
    await db.query(`update public.index_state set last_price=10000 where index_code='SPI50'`);
    assert.match(await errorOf(schedule(rescaleEpoch)), /engine_v3_rescale_not_due/, 'inside the soft range there is nothing to rescale');
    await db.query(`update public.index_state set last_price=900 where index_code='SPI50'`);
    const plan = (await schedule(rescaleEpoch)).rows[0].r;
    assert.deepEqual({ kind: plan.kind, exponent: plan.exponent, pause: Number(plan.pause_after_tick_no), genesis: Number(plan.genesis_tick_no) },
        { kind: 'rescale', exponent: 1, pause: pauseAfter, genesis: resumeGenesis });
    assert.match(await errorOf(schedule(rescaleEpoch + DAY)), /engine_v3_resume_already_scheduled/);
    const announced = (await asUser(db, 'customer', () => db.query('select public.get_engine_v3_rescales() r'))).rows[0].r;
    assert.equal(announced.length, 1);
    assert.equal(announced[0].factor, '10');
    assert.equal(new Date(announced[0].resume_at).getTime(), rescaleEpoch);
    assert.match(await asUser(db, 'customer', () => errorOf(db.query(`select engine_private.operator_schedule_rescale('DEMO','SPI50',$1,'customers cannot schedule')`, [rescaleEpoch + DAY]))), /permission denied/);
});

test('the index publishes up to its pause tick and nothing inside the pause is produced or sold', async () => {
    await setClock(today + DAY + 600_000);
    assert.equal((await worker.cycle()).committed, 1);
    await setClock(today + 2 * DAY + 600_000);
    assert.equal((await worker.cycle()).committed, 1);
    await setClock(tickTime(pauseAfter - 10) + 500);
    await worker.cycle();
    assert.equal((await lastTick()).n, pauseAfter - 10);
    await setClock(tickTime(pauseAfter + 15) + 500);
    await worker.cycle();
    await worker.cycle();
    const paused = await lastTick();
    assert.equal(paused.n, pauseAfter, 'nothing is published after the pause tick');
    const publish = wdb.query(`select public.engine_v3_publish_tick('DEMO','SPI50',$1,$2,$3,$4,$5,1::smallint,$6)`,
        [pauseAfter + 1, tickTime(pauseAfter + 1), Date.now() + offset, paused.u, paused.u + 1n, randomBytes(32)]);
    assert.match(await errorOf(publish), /engine_v3_rescale_pause/);
    assert.equal((await rows(db, `select engine_private.v3_purchase_block('DEMO','SPI50',$1,$2) r`, [pauseAfter - 1, pauseAfter + 1]))[0].r, 'engine_v3_rescale_pause');
});

test('the rescale epoch commits at exactly ten times the paused price, and the index resumes from it at midnight', async () => {
    const paused = await lastTick();
    worker.commitAheadEpochs = 1;
    const commit = await worker.cycle();
    assert.equal(commit.committed, 1, JSON.stringify(commit));
    const resume = (await rows(db, `select status,genesis_units::text from public.engine_v3_resumes where index_code='SPI50'`))[0];
    assert.deepEqual(resume, { status: 'committed', genesis_units: String(BigInt(paused.u) * 10n) });
    const entry = (await rows(db, `select engine_private.v3_entry(config_hash,'SPI50') e from public.engine_v3_epochs where epoch_start_ms=$1`, [rescaleEpoch]))[0].e;
    assert.equal(entry.genesis_tick_no, String(resumeGenesis));
    assert.equal(entry.genesis_units, String(BigInt(paused.u) * 10n));

    await setClock(rescaleEpoch + 30_000);
    await worker.cycle();
    const ticks = await rows(db, `select tick_no::int n,round(previous_price*1000)::bigint p,round(price*1000)::bigint u,encode(v3_prev_tick_hash,'hex') h,encode(v3_config_hash,'hex') c
        from public.index_ticks where index_code='SPI50' and generation_version=3 and tick_no>$1 order by tick_no`, [pauseAfter]);
    assert.equal(ticks[0].n, resumeGenesis + 1, 'the pause ticks were never produced');
    assert.equal(ticks[0].p, String(BigInt(paused.u) * 10n));
    const genesisHash = g.genesisHash({ env: 'test', mode: 'DEMO', entry: Object.fromEntries(Object.entries(entry).map(([k, v]) => [k, /_units$|_no$/.test(k) ? BigInt(v) : v])), configHash: Buffer.from(ticks[0].c, 'hex') });
    assert.equal(ticks[0].h, genesisHash.toString('hex'), 'the first resumed tick chains to the committed genesis');
    ticks.forEach((tick, i) => { if (i) assert.equal(tick.n, ticks[i - 1].n + 1); });
    assert.ok(ticks.every((tick) => BigInt(tick.u) > 8_000_000n && BigInt(tick.u) < 10_000_000n), 'about 9000.000 after the x10 rescale');
    assert.equal((await rows(db, `select status from public.engine_v3_resumes where index_code='SPI50'`))[0].status, 'applied');
    assert.deepEqual((await asUser(db, 'customer', () => db.query('select public.get_engine_v3_rescales() r'))).rows[0].r, []);
});

test('a configuration may not change a running index\'s genesis without a scheduled resume', async () => {
    const state = await worker.rpc('engine_v3_writer_state', ['DEMO']);
    const latest = state.latest_commitment;
    const last = state.epochs.find((e) => e.epoch_start_ms === latest.epoch_start_ms);
    const entries = state.configs[last.config_hash].map((e) => (e.index === 'SPI50' ? { ...e, genesis_units: '12345678' } : e));
    const configHash = (await worker.rpc('engine_v3_register_config', ['DEMO', JSON.stringify(entries)]));
    const next = BigInt(latest.epoch_start_ms) + BigInt(DAY);
    const seedHash = g.seedHash(randomBytes(32));
    const commitment = g.epochCommitment({ env: 'test', mode: 'DEMO', epochStartMs: next, seedHash, configHash, prevCommitment: Buffer.from(latest.commitment, 'hex') });
    const attempt = worker.rpc('engine_v3_commit_epoch', ['DEMO', String(next), configHash, seedHash, Buffer.from(latest.commitment, 'hex'), commitment,
        'resume-drill-1', randomBytes(64), 'local:aes-256-gcm', 'k', randomBytes(60)]);
    assert.match(await errorOf(attempt), /engine_v3_resume_unscheduled/);
});
