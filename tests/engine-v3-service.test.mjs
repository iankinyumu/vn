// Engine v3 worker + publication on a real PostgreSQL with pgcrypto: custody,
// commitments, witnesses, shadow and live publication, settlement, fail-closed
// gates and failure drills (ADR 0002, plan Workstreams A, B, D, E).
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';
import * as g from '../engine/v3/generator.mjs';
import { LocalCustody } from '../engine/v3/service/custody.mjs';
import { Ed25519Signer } from '../engine/v3/service/signer.mjs';
import { EngineWorker } from '../engine/v3/service/worker.mjs';
import { verifyPackage } from '../verifier/v3/verify.mjs';
import { asUser, createRealDatabase } from './helpers/pg-real.mjs';
import { TEST_TSA_ROOT, TestWitness, issueTestToken } from './helpers/test-tsa.mjs';

const DAY = 86_400_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class SpyCustody extends LocalCustody {
    constructor() { super(randomBytes(32)); this.seeds = new Map(); this.failUnwrap = false; }
    async wrap(plaintext, context) {
        if (context.purpose === 'epoch-seed') this.seeds.set(context.epoch_start_ms, Buffer.from(plaintext));
        return super.wrap(plaintext, context);
    }
    async unwrap(wrapped, context) {
        if (this.failUnwrap) throw new Error('kms_unavailable');
        return super.unwrap(wrapped, context);
    }
}

let T, db, wdb, custody, signer, witnesses, worker, params, t0, genesis, account;
const rpc = async (client, sql, args = []) => (await client.query(sql, args)).rows;
const errorOf = async (promise) => { try { await promise; return null; } catch (error) { return error.message; } };
const liveTicks = async (index) => rpc(db, `select tick_no::int,digit,price,v3_tick_hash,v3_prev_tick_hash,generation_version from public.index_ticks where index_code=$1 and generation_version=3 order by tick_no`, [index]);
const makeWorker = (overrides = {}) => new EngineWorker({ db: wdb, mode: 'DEMO', params, custody, signer, witnesses, checkpointEvery: 5, ...overrides });
async function cycleUntil(predicate, { timeoutMs = 20000, instance = worker } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const report = await instance.cycle();
        if (await predicate()) return;
        if (Date.now() > deadline) throw new Error(`condition not reached in time; last cycle: ${JSON.stringify(report)}`);
        await sleep(400);
    }
}
const customer = (fn) => asUser(db, 'customer', fn);
const buy = (index, key, ticks = 2) => customer(() => db.query(`select public.engine_buy_contract($1,$2,'EVEN',null,10,$3,$4) r`, [account, index, ticks, key]));

before(async () => {
    T = await createRealDatabase();
    db = T.db;
    await asUser(db, 'ian', () => db.query(`select public.engine_v3_configure('test',$1::jsonb,'integration test environment')`,
        [JSON.stringify({ min_commit_lead_ms: -DAY, reveal_delay_ms: 0, max_checkpoint_gap_ticks: 20 })]));
    await db.exec(`create role engine_worker_login login password 'worker-test' in role engine_tick_writer`);
    wdb = await T.connect('engine_worker_login', 'worker-test');
    t0 = Number((await rpc(db, `select floor(extract(epoch from t0)*1000)::bigint t0 from public.engine_indices where code='SPI10'`))[0].t0);
    genesis = Math.floor((Date.now() - t0) / 2000) + 1;
    const tomorrow = Math.floor(Date.now() / DAY) * DAY + DAY;
    params = Object.fromEntries(g.INDICES.map((index) => [index, {
        annual_vol_bp: g.ANNUAL_VOL_BP[index], anchor_units: 10_000_000, kappa_e12: 534835, min_units: 500_000, max_units: 200_000_000,
        // SPI25 is reserved for the scheduled-cutover checks: its genesis is the last tick before tomorrow.
        genesis_tick_no: index === 'SPI25' ? Math.floor((tomorrow - 1 - t0) / 2000) : genesis, genesis_units: 10_000_000,
    }]));
    custody = new SpyCustody();
    signer = Ed25519Signer.generate('test-signing-1');
    witnesses = [new TestWitness('digicert'), new TestWitness('sectigo')];
    worker = makeWorker();
    assert.equal(await worker.acquireLeadership(), true);
    await worker.registerSigningKey();
    await asUser(db, 'ian', () => db.query(`select public.engine_v3_set_shadow('DEMO','SPI10',true,'shadow run for integration test')`));
    // A live v3 index, as after an activated cutover at the genesis tick.
    await db.query(`update public.engine_indices set engine_generation=3 where code in ('SPI50','SPI75')`);
    await db.query(`update public.index_state set last_tick_no=$1,last_price=10000,updated_at=now() where index_code in ('SPI50','SPI75')`, [genesis]);
    account = (await customer(() => db.query('select public.enroll_practice_account() id'))).rows[0].id;
});
after(async () => { await wdb?.end().catch(() => {}); await T?.close(); });

test('API roles and the writer role cannot read seeds or call each other\'s surfaces', async () => {
    for (const sql of [`select * from public.engine_v3_epochs`, `select * from engine_private.v3_wrapped_seeds`,
        `select public.engine_v3_publish_tick('DEMO','SPI50',1,1,1,1,1,1::smallint,'\\x00'::bytea)`, `select * from public.engine_v3_wrapped_seed('DEMO',0)`]) {
        assert.match(await customer(() => errorOf(db.query(sql))), /permission denied/, sql);
    }
    assert.match(await errorOf(wdb.query('select * from engine_private.v3_wrapped_seeds')), /permission denied/);
    assert.match(await errorOf(wdb.query('select * from public.engine_v3_epochs')), /permission denied/);
    assert.match(await errorOf(wdb.query('select public.get_admin_engine_v3_health()')), /permission denied/);
});

test('the worker commits, signs and witnesses epochs before their ticks and keeps no plaintext in the database', async () => {
    const report = await worker.cycle();
    assert.equal(report.committed, 3, JSON.stringify(report));
    const epochs = await rpc(db, `select e.epoch_start_ms::text, e.committed_at, (select count(*)::int from public.engine_v3_witness_receipts r where r.subject_hash=e.commitment) receipts,
        octet_length(w.ciphertext) wrapped from public.engine_v3_epochs e join engine_private.v3_wrapped_seeds w using(execution_mode,epoch_start_ms) order by 1`);
    assert.equal(epochs.length, 3);
    assert.ok(epochs.every((e) => e.receipts === 2 && e.wrapped === 60));
    assert.equal(custody.seeds.size, 3);
    // Scan every text-like and bytea column in every schema for the seeds.
    const columns = await rpc(db, `select table_schema s,table_name t,column_name c,data_type d from information_schema.columns
        where table_schema not in ('pg_catalog','information_schema','pg_toast') and data_type in ('bytea','text','jsonb','character varying')`);
    for (const seed of custody.seeds.values()) {
        for (const col of columns) {
            const where = col.d === 'bytea' ? `position($1::bytea in "${col.c}")>0` : `position($1::text in "${col.c}"::text)>0`;
            const hits = await rpc(db, `select count(*)::int n from "${col.s}"."${col.t}" where ${where}`, [col.d === 'bytea' ? seed : seed.toString('hex')]);
            assert.equal(hits[0].n, 0, `plaintext seed found in ${col.s}.${col.t}.${col.c}`);
        }
    }
    assert.match(await errorOf(wdb.query(`select * from public.engine_v3_wrapped_seed('DEMO',$1)`, [epochs[1].epoch_start_ms])), /engine_v3_epoch_not_due/);
});

test('shadow and live ticks publish in order on one chain, with checkpoints', async () => {
    await cycleUntil(async () => (await liveTicks('SPI50')).length >= 6 && (await rpc(db, `select count(*)::int n from public.engine_v3_shadow_ticks where index_code='SPI10'`))[0].n >= 6);
    const live = await liveTicks('SPI50');
    assert.equal(live[0].tick_no, genesis + 1);
    live.forEach((tick, i) => { if (i) { assert.equal(tick.tick_no, live[i - 1].tick_no + 1); assert.deepEqual(tick.v3_prev_tick_hash, live[i - 1].v3_tick_hash); } });
    assert.equal((await rpc(db, `select count(*)::int n from public.index_ticks where index_code='SPI10' and generation_version=3`))[0].n, 0, 'shadow ticks never reach index_ticks');
    assert.ok((await rpc(db, `select count(*)::int n from public.engine_v3_checkpoints where index_code='SPI50' and not shadow`))[0].n >= 1);
    // v2 generation skips a v3 index entirely.
    await db.query('select public.engine_advance()');
    assert.equal((await rpc(db, `select count(*)::int n from public.index_ticks where index_code='SPI50' and generation_version<3`))[0].n, 0);
});

test('a purchase passes the gate and settles on its fixed v3 exit tick', async () => {
    const bought = (await buy('SPI50', 'v3-settle-1')).rows[0].r;
    await cycleUntil(async () => (await rpc(db, `select state from public.engine_contracts where id=$1`, [bought.id]))[0].state !== 'OPEN');
    const [contract] = await rpc(db, `select c.state,c.exit_digit,c.exit_price,t.digit,t.price from public.engine_contracts c join public.index_ticks t on t.index_code=c.index_code and t.execution_mode=c.execution_mode and t.tick_no=c.settle_tick_no where c.id=$1`, [bought.id]);
    assert.equal(contract.exit_digit, contract.digit);
    assert.equal(contract.exit_price, contract.price);
    assert.equal(contract.state, contract.digit % 2 === 0 ? 'WON' : 'LOST');
    const ledger = await rpc(db, `select coalesce(sum(e.amount),0)::numeric total from public.ledger_entries e join public.ledger_transactions x on x.id=e.ledger_transaction_id where x.trading_account_id=$1 and x.idempotency_key in ($2,$3)`, [account, `buy-${bought.id}`, `settle-${bought.id}`]);
    assert.ok(ledger.length === 1);
});

test('purchases fail closed when a witness is missing, the feed is stale or the worker is silent', async () => {
    await worker.cycle();
    await asUser(db, 'ian', () => db.query(`select public.engine_v3_configure('test',$1::jsonb,'require an extra witness')`, [JSON.stringify({ required_witnesses: ['digicert', 'sectigo', 'extra'] })]));
    assert.match(await errorOf(buy('SPI50', 'v3-gate-witness')), /engine_unwitnessed/);
    await asUser(db, 'ian', () => db.query(`select public.engine_v3_configure('test',$1::jsonb,'restore required witnesses')`, [JSON.stringify({ required_witnesses: ['digicert', 'sectigo'] })]));
    await worker.cycle();
    assert.equal(await errorOf(buy('SPI50', 'v3-gate-ok')), null);
    await sleep(8000); // worker stopped: ticks and heartbeat go stale
    assert.match(await errorOf(buy('SPI50', 'v3-gate-stale')), /feed_stale|engine_worker_unhealthy/);
    await cycleUntil(async () => (await customer(() => db.query('select public.get_engine_v3_status() s'))).rows[0].s.find((i) => i.index_code === 'SPI50').purchase_block === null);
});

test('the database refuses future, out-of-order, conflicting, skewed and forged publications but accepts identical retries', async () => {
    await worker.cycle();
    const stored = (await rpc(db, `select tick_no::bigint n,floor(extract(epoch from scheduled_at)*1000)::bigint s,v3_generated_ms g,round(previous_price*1000)::bigint p,round(price*1000)::bigint u,digit d,v3_tick_hash h
        from public.index_ticks where index_code='SPI50' and generation_version=3 order by tick_no desc limit 1`))[0];
    const publish = (a) => wdb.query(`select public.engine_v3_publish_tick('DEMO','SPI50',$1,$2,$3,$4,$5,$6,$7) r`, [a.n, a.s, a.g, a.p, a.u, a.d, a.h]);
    assert.equal((await publish(stored)).rows[0].r, 'duplicate');
    assert.match(await errorOf(publish({ ...stored, h: randomBytes(32) })), /engine_v3_tick_conflict/);
    await sleep(4500); // let the next two ticks fall due without publishing them
    const next = { n: BigInt(stored.n) + 1n, s: BigInt(stored.s) + 2000n, g: Date.now(), p: stored.u, u: 10_000_001n, d: 1, h: randomBytes(32) };
    assert.match(await errorOf(publish({ ...next, n: next.n + 50n, s: next.s + 100000n })), /engine_v3_future_tick/);
    assert.match(await errorOf(publish({ ...next, n: next.n + 1n, s: next.s + 2000n })), /engine_v3_sequence_gap/);
    assert.match(await errorOf(publish({ ...next, p: BigInt(stored.u) + 1n })), /engine_v3_prev_mismatch/);
    assert.match(await errorOf(publish({ ...next, g: Date.now() + 5000 })), /engine_v3_clock_drift/);
    assert.match(await errorOf(publish({ ...next, s: next.s + 1n })), /engine_v3_schedule_mismatch/);
    assert.match(await errorOf(publish({ ...next, u: 100n, d: 0 })), /engine_v3_price_out_of_band/);
    assert.match(await errorOf(publish(next)), /engine_v3_tick_hash_mismatch/);
    await worker.cycle(); // the honest worker resumes the chain
    const live = await liveTicks('SPI50');
    live.forEach((tick, i) => { if (i) assert.equal(tick.tick_no, live[i - 1].tick_no + 1); });
});

test('crash, lost-reply and second-worker drills leave exactly one chain', async () => {
    // Lost reply: the tick is stored, the worker sees an error, the next cycle continues.
    let dropped = false;
    const flaky = { query: async (sql, args) => { const out = await wdb.query(sql, args); if (!dropped && sql.includes('engine_v3_publish_tick')) { dropped = true; throw new Error('connection reset'); } return out; } };
    const lossy = makeWorker({ db: flaky });
    await sleep(2100);
    const report = await lossy.cycle();
    assert.ok(dropped && report.errors.length >= 1, JSON.stringify(report));
    // Stale view after a lost reply: regeneration conflicts; the worker adopts the stored tick after checking its price.
    const state = await worker.rpc('engine_v3_writer_state', ['DEMO']);
    const staleRow = state.indices.find((i) => i.index === 'SPI50');
    const live = await liveTicks('SPI50');
    const previous = live[live.length - 2];
    staleRow.last = { tick_no: String(previous.tick_no), price_units: String(Math.round(Number(previous.price) * 1000)), tick_hash: previous.v3_tick_hash.toString('hex') };
    worker.state = state; worker.env = state.env;
    const r = { published: 0, duplicates: 0, errors: [] };
    await worker.publishDue(staleRow, r);
    assert.ok(r.duplicates >= 1, JSON.stringify(r));
    // Restart: a fresh worker instance continues from the database state.
    await sleep(2100);
    await makeWorker().cycle();
    const after = await liveTicks('SPI50');
    after.forEach((tick, i) => { if (i) { assert.equal(tick.tick_no, after[i - 1].tick_no + 1); assert.deepEqual(tick.v3_prev_tick_hash, after[i - 1].v3_tick_hash); } });
    // Only one worker may lead.
    const second = await T.connect('engine_worker_login', 'worker-test');
    assert.equal(await makeWorker({ db: second }).acquireLeadership(), false);
    await second.end();
});

test('a clock-skewed worker publishes nothing', async () => {
    const before = (await liveTicks('SPI50')).length;
    await sleep(2100);
    const report = await makeWorker({ clock: () => Date.now() + 5000 }).cycle();
    assert.deepEqual(report.errors, ['clock_drift']);
    assert.equal((await liveTicks('SPI50')).length, before);
});

test('a KMS outage stops ticks and purchases; recovery catches up in order', async () => {
    await worker.cycle();
    const before = (await liveTicks('SPI50')).at(-1).tick_no;
    custody.failUnwrap = true;
    const blind = makeWorker(); // no cached keys, as after a restart during the outage
    await sleep(7000);
    const report = await blind.cycle();
    assert.ok(report.errors.some((e) => e.includes('kms_unavailable')), JSON.stringify(report));
    assert.equal((await liveTicks('SPI50')).at(-1).tick_no, before);
    assert.match(await errorOf(buy('SPI50', 'v3-kms-down')), /feed_stale/);
    custody.failUnwrap = false;
    await blind.cycle();
    const live = await liveTicks('SPI50');
    assert.ok(live.at(-1).tick_no >= before + 3, 'backlog caught up');
    live.forEach((tick, i) => { if (i) assert.equal(tick.tick_no, live[i - 1].tick_no + 1); });
});

test('a halted index refunds contracts whose exit tick cannot be produced and refuses new work', async () => {
    await cycleUntil(async () => (await liveTicks('SPI75')).length >= 2);
    const bought = (await buy('SPI75', 'v3-halt-1', 10)).rows[0].r;
    await wdb.query(`select public.engine_v3_halt('DEMO','SPI75','simulated price band breach')`);
    assert.equal((await wdb.query(`select public.engine_v3_void_unproducible('DEMO','SPI75','simulated price band breach') n`)).rows[0].n, 1);
    const [contract] = await rpc(db, 'select state from public.engine_contracts where id=$1', [bought.id]);
    assert.equal(contract.state, 'VOID');
    const [event] = await rpc(db, `select reason from public.contract_events where contract_id=$1 and event_type='VOID'`, [bought.id]);
    assert.equal(event.reason, 'ENGINE_UNPRODUCIBLE');
    const refund = await rpc(db, 'select sum(e.amount)::numeric n from public.ledger_entries e join public.ledger_transactions x on x.id=e.ledger_transaction_id where x.idempotency_key=$1', [`void-${bought.id}`]);
    assert.equal(Number(refund[0].n), 0, 'refund is a balanced reserved-to-available transfer');
    assert.match(await errorOf(buy('SPI75', 'v3-halt-2')), /index_not_available/);
    const report = await worker.cycle();
    assert.ok(!report.errors.some((e) => e.startsWith('SPI75')), 'the worker skips a halted index');
});

test('reveal is refused before an epoch ends; a finished epoch reveals once and only with its committed seed', async () => {
    const today = String(Math.floor(Date.now() / DAY) * DAY);
    assert.match(await errorOf(wdb.query('select public.engine_v3_reveal_epoch($1,$2,$3)', ['DEMO', today, custody.seeds.get(today)])), /engine_v3_reveal_too_early/);
    // A finished epoch in a separate chain (REAL has no indices, so its configuration is empty).
    const seed = randomBytes(32);
    const start = Math.floor(Date.now() / DAY) * DAY - 2 * DAY;
    const config = (await wdb.query(`select public.engine_v3_register_config('REAL','[]'::jsonb) h`)).rows[0].h;
    const seedHash = g.seedHash(seed);
    const commitment = g.epochCommitment({ env: 'test', mode: 'REAL', epochStartMs: BigInt(start), seedHash, configHash: config, prevCommitment: Buffer.alloc(32) });
    await db.query(`insert into public.engine_v3_epochs(execution_mode,epoch_start_ms,epoch_end_ms,config_hash,seed_hash,prev_commitment,commitment,signing_key_id,signature,committed_at)
        values('REAL',$1,$2,$3,$4,$5,$6,$7,$8,now()-interval '3 days')`, [start, start + DAY, config, seedHash, Buffer.alloc(32), commitment, signer.keyId, signer.sign('epoch-commitment', commitment)]);
    assert.match(await errorOf(wdb.query(`select public.engine_v3_reveal_epoch('REAL',$1,$2)`, [start, randomBytes(32)])), /engine_v3_seed_mismatch/);
    await wdb.query(`select public.engine_v3_reveal_epoch('REAL',$1,$2)`, [start, seed]);
    await wdb.query(`select public.engine_v3_reveal_epoch('REAL',$1,$2)`, [start, seed]); // idempotent
    assert.match(await errorOf(db.query(`update public.engine_v3_epochs set revealed_seed=$1 where execution_mode='REAL'`, [randomBytes(32)])), /engine_v3_immutable/);
    assert.match(await errorOf(db.query(`delete from public.engine_v3_epochs where execution_mode='REAL'`)), /engine_v3_immutable/);
});

test('the exported proof package verifies offline: signatures, witnesses, anchors, prices and contracts', async () => {
    await cycleUntil(async () => (await liveTicks('SPI50')).length >= 20);
    const last = (await liveTicks('SPI50')).at(-1).tick_no;
    const exportPackage = async (from) => (await customer(() => db.query(`select public.get_v3_proof_package($1,'SPI50',$2,$3) p`, [account, from, last]))).rows[0].p;
    const options = { trustedKeys: { [signer.keyId]: signer.publicKey.toString('hex') }, tsaRoots: { digicert: [new Uint8Array(TEST_TSA_ROOT)], sectigo: [new Uint8Array(TEST_TSA_ROOT)] } };
    const reveal = (pkg) => { for (const e of pkg.epochs) if (custody.seeds.has(e.epoch_start_ms)) e.revealed_seed = custody.seeds.get(e.epoch_start_ms).toString('hex'); return pkg; };

    const pending = await verifyPackage(await exportPackage(genesis + 1), options);
    assert.equal(pending.status, 'not_yet_revealable', JSON.stringify(pending.issues.slice(0, 3)));
    assert.equal(pending.witness, 'witnessed');
    assert.equal(pending.signatures, 'valid');

    const full = reveal(await exportPackage(genesis + 1));
    const verified = await verifyPackage(full, options);
    assert.equal(verified.status, 'verified', JSON.stringify(verified.issues.slice(0, 3)));
    assert.equal(verified.anchored.SPI50, true);
    assert.ok(verified.contracts.length >= 1 && verified.contracts.every((c) => ['verified', 'void_refunded'].includes(c.status)), JSON.stringify(verified.contracts));

    // A later range is anchored by a signed checkpoint instead of genesis.
    const anchoredPkg = reveal(await exportPackage(last - 2));
    assert.equal(Object.keys(anchoredPkg.anchors).length, 1, 'anchor checkpoint exported');
    const anchored = await verifyPackage(anchoredPkg, options);
    assert.equal(anchored.status, 'verified', JSON.stringify(anchored.issues.slice(0, 3)));
    assert.equal(anchored.anchored.SPI50, true);

    // Tampering is caught with a specific state.
    const tamper = async (edit) => { const pkg = structuredClone(full); edit(pkg); return verifyPackage(pkg, options); };
    assert.ok((await tamper((p) => { const t = p.ticks.at(-1); t.price_units = String(BigInt(t.price_units) + 10n); })).states.includes('price_mismatch'));
    assert.equal((await verifyPackage(full, { ...options, trustedKeys: { [signer.keyId]: '00'.repeat(32) } })).status, 'invalid_signature');
    assert.equal((await tamper((p) => { const b = parseInt(p.epochs[0].signature.slice(0, 2), 16) ^ 1; p.epochs[0].signature = b.toString(16).padStart(2, '0') + p.epochs[0].signature.slice(2); })).status, 'invalid_signature');
    assert.equal((await tamper((p) => { for (const e of p.epochs) for (const w of e.witness) w.token = Buffer.from(issueTestToken(randomBytes(32))).toString('base64'); })).witness, 'invalid');
    assert.equal((await tamper((p) => { for (const e of p.epochs) e.witness = e.witness.filter((w) => w.provider !== 'sectigo'); })).witness, 'unwitnessed');
    assert.equal((await verifyPackage(full, { trustedKeys: options.trustedKeys })).witness, 'unwitnessed', 'no pinned TSA roots, no witness claim');
});

test('scheduled cutover stops v2 at the boundary, blocks straddling contracts and activates only when due', async () => {
    const tomorrow = Math.floor(Date.now() / DAY) * DAY + DAY;
    const final = (await asUser(db, 'ian', () => db.query(`select public.engine_v3_schedule_cutover('DEMO','SPI25',$1,'announced Practice cutover for SPI25') f`, [tomorrow]))).rows[0].f;
    assert.equal(Number(final), params.SPI25.genesis_tick_no);
    assert.match(await asUser(db, 'ian', () => errorOf(db.query(`select public.engine_v3_schedule_cutover('DEMO','SPI100',$1,'mismatched genesis must fail')`, [tomorrow]))), /engine_v3_genesis_mismatch/);
    assert.match(await asUser(db, 'ian', () => errorOf(db.query(`select public.engine_v3_schedule_cutover('DEMO','SPI100',$1,'not a day boundary')`, [tomorrow + 1]))), /engine_v3_cutover_not_boundary/);
    assert.equal((await rpc(db, `select engine_private.v3_purchase_block('DEMO','SPI25',$1,$2) b`, [final - 1, Number(final) + 1]))[0].b, 'engine_generation_cutover');
    assert.equal((await rpc(db, `select engine_private.v3_purchase_block('DEMO','SPI25',$1,$2) b`, [final - 2, final]))[0].b, null);
    assert.match(await errorOf(wdb.query(`select public.engine_v3_activate_cutover('DEMO','SPI25')`)), /engine_v3_cutover_not_due/);
    // v2 generation never passes the final tick (simulate a final tick that is already due).
    const [state] = await rpc(db, `select last_tick_no::int n from public.index_state where index_code='SPI100'`);
    await db.query(`update public.engine_indices set v2_final_tick_no=$1 where code='SPI100'`, [state.n + 2]);
    await sleep(100);
    await db.query('select public.engine_advance()');
    assert.equal((await rpc(db, `select max(tick_no)::int n from public.index_ticks where index_code='SPI100'`))[0].n, state.n + 2);
});

test('staff see v3 health; customers see gate status; only engine managers configure', async () => {
    const health = (await asUser(db, 'administrator', () => db.query('select public.get_admin_engine_v3_health() h'))).rows[0].h;
    assert.ok(health.epochs.length >= 3 && health.workers.length >= 1 && health.events.length >= 1);
    assert.match(await asUser(db, 'agent', () => errorOf(db.query('select public.get_admin_engine_v3_health()'))), /forbidden/);
    assert.match(await asUser(db, 'agent', () => errorOf(db.query(`select public.engine_v3_set_shadow('DEMO','SPI100',true,'agents may not do this')`))), /forbidden/);
    assert.match(await asUser(db, 'ian', () => errorOf(db.query(`select public.engine_v3_configure('production','{}'::jsonb,'environment is immutable once set')`))), /engine_v3_environment_immutable/);
    const status = (await customer(() => db.query('select public.get_engine_v3_status() s'))).rows[0].s;
    const spi50 = status.find((i) => i.index_code === 'SPI50');
    assert.equal(spi50.engine_generation, 3);
    // Observed volatility is published with its target and window, and matches an independent computation.
    const vol = health.volatility.find((v) => v.index_code === 'SPI50')['1h'];
    const ticks = await rpc(db, `select price::float8 p,previous_price::float8 q from public.index_ticks where index_code='SPI50' and generation_version=3 order by tick_no desc limit 1800`);
    const r = ticks.map((t) => Math.log(t.p / t.q));
    const mean = r.reduce((a, b) => a + b, 0) / r.length;
    const sd = Math.sqrt(r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1));
    assert.equal(vol.window_ticks, ticks.length);
    assert.equal(Number(vol.target_annual), 0.5);
    assert.ok(Math.abs(Number(vol.observed_annual) - sd * Math.sqrt(15_768_000)) < 1e-5, `${vol.observed_annual} vs ${sd * Math.sqrt(15_768_000)}`);
    assert.equal(vol.status, 'insufficient_data');
    assert.equal(spi50.volatility_1d.target_annual, 0.5);
});
