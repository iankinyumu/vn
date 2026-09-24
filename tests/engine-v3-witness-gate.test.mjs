// Witness attestation and the purchase gate on real PostgreSQL (production fix
// brief §2). Each scenario is a distinct provider name added to the required
// witnesses, so all of them share one live epoch; each asserts the purchase
// gate AND the exported proof result.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';
import * as g from '../engine/v3/generator.mjs';
import { WitnessAttestor } from '../engine/v3/service/attestor.mjs';
import { LocalCustody } from '../engine/v3/service/custody.mjs';
import { Ed25519Signer } from '../engine/v3/service/signer.mjs';
import { EngineWorker } from '../engine/v3/service/worker.mjs';
import { decodeBase64, rootBundleId } from '../verifier/v3/tsa.mjs';
import { verifyPackage } from '../verifier/v3/verify.mjs';
import { asUser, createRealDatabase } from './helpers/pg-real.mjs';
import { TEST_TSA_ROOT, TestWitness, issueTestToken } from './helpers/test-tsa.mjs';
import { readFileSync } from 'node:fs';

const DAY = 86_400_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errorOf = async (p) => { try { await p; return null; } catch (e) { return e.message; } };
const TEST_ROOT = [new Uint8Array(TEST_TSA_ROOT)];
const DIGICERT_ROOT = JSON.parse(readFileSync(new URL('../verifier/v3/tsa-roots.json', import.meta.url), 'utf8')).providers.digicert.certificates.map(decodeBase64);
// The attestor pins the test root for every scenario provider except p-chain, which is pinned to DigiCert.
const ROOTS = { digicert: TEST_ROOT, sectigo: TEST_ROOT, 'p-missing': TEST_ROOT, 'p-wrong': TEST_ROOT, 'p-forged': TEST_ROOT, 'p-chain': DIGICERT_ROOT, 'p-replace': TEST_ROOT, 'p-recover': TEST_ROOT };

let T, db, wdb, adb, worker, attestor, signer, params, genesis, account, today, commitment;
const configure = (settings) => asUser(db, 'ian', () => db.query(`select public.engine_v3_configure('test',$1::jsonb,'witness gate scenario settings')`, [JSON.stringify(settings)]));
const submit = (subject, provider, token, claimed = new Date(0)) => wdb.query(`select public.engine_v3_record_witness('epoch-commitment',$1,$2,$3,$4)`, [subject, provider, token, claimed.toISOString()]);
const block = async (entryOffset = 1, settleOffset = 1) => {
    const [s] = (await db.query(`select last_tick_no::bigint n from public.index_state where index_code='SPI50'`)).rows;
    return (await db.query(`select engine_private.v3_purchase_block('DEMO','SPI50',$1,$2) b`, [BigInt(s.n) + BigInt(entryOffset), BigInt(s.n) + BigInt(settleOffset)])).rows[0].b;
};
async function proofWitness(required) {
    const [last] = (await db.query(`select max(tick_no)::bigint n from public.index_ticks where index_code='SPI50' and generation_version=3`)).rows;
    const pkg = (await asUser(db, 'customer', () => db.query(`select public.get_v3_proof_package($1,'SPI50',$2,$3) p`, [account, genesis + 1, last.n]))).rows[0].p;
    const result = await verifyPackage(pkg, { trustedKeys: { [signer.keyId]: signer.publicKey.toString('hex') }, tsaRoots: ROOTS, requiredWitnesses: required });
    return result.components;
}
async function scenario(provider) {
    await configure({ required_witnesses: ['digicert', 'sectigo', provider] });
    try { return { gate: await block(), proof: await proofWitness(['digicert', 'sectigo', provider]) }; }
    finally { await configure({ required_witnesses: ['digicert', 'sectigo'] }); }
}
const cycle = async () => { await worker.cycle(); return attestor.cycle(); };

before(async () => {
    T = await createRealDatabase();
    db = T.db;
    await configure({ min_commit_lead_ms: -DAY, reveal_delay_ms: 0, max_checkpoint_gap_ticks: 20, tsa_root_bundle_id: await rootBundleId(ROOTS) });
    await db.exec(`create role gate_worker login password 'w' in role engine_tick_writer; create role gate_attestor login password 'a' in role engine_witness_attestor`);
    wdb = await T.connect('gate_worker', 'w');
    adb = await T.connect('gate_attestor', 'a');
    const t0 = Number((await db.query(`select floor(extract(epoch from t0)*1000)::bigint t0 from public.engine_indices where code='SPI50'`)).rows[0].t0);
    genesis = Math.floor((Date.now() - t0) / 2000) + 1;
    params = Object.fromEntries(g.INDICES.map((i) => [i, { annual_vol_bp: g.ANNUAL_VOL_BP[i], anchor_units: 10_000_000, kappa_e12: 534835, min_units: 500_000, max_units: 200_000_000, genesis_tick_no: genesis, genesis_units: 10_000_000 }]));
    signer = Ed25519Signer.generate('gate-key-1');
    worker = new EngineWorker({ db: wdb, params, custody: new LocalCustody(randomBytes(32)), signer, witnesses: [new TestWitness('digicert'), new TestWitness('sectigo')], checkpointEvery: 5 });
    attestor = new WitnessAttestor({ db: adb, roots: ROOTS });
    await worker.registerSigningKey();
    await db.query(`update public.engine_indices set engine_generation=3 where code='SPI50'`);
    await db.query(`update public.index_state set last_tick_no=$1,last_price=10000,updated_at=now() where index_code='SPI50'`, [genesis]);
    account = (await asUser(db, 'customer', () => db.query('select public.enroll_practice_account() id'))).rows[0].id;
    for (let i = 0; i < 20 && (await db.query(`select count(*)::int n from public.index_ticks where index_code='SPI50' and generation_version=3`)).rows[0].n < 6; i++) { await cycle(); await sleep(700); }
    today = Math.floor(Date.now() / DAY) * DAY;
    commitment = (await db.query(`select commitment from public.engine_v3_epochs where epoch_start_ms=$1`, [today])).rows[0].commitment;
});
after(async () => { await wdb?.end().catch(() => {}); await adb?.end().catch(() => {}); await T?.close(); });

test('two valid receipts before the deadline open the gate and verify in the proof', async () => {
    await cycle();
    assert.equal(await block(), null);
    assert.equal((await proofWitness(['digicert', 'sectigo'])).witness, 'witnessed');
    const [deadline] = (await db.query(`select engine_private.v3_witness_deadline(config_hash,epoch_start_ms)::bigint d from public.engine_v3_epochs where epoch_start_ms=$1`, [today])).rows;
    assert.equal(BigInt(deadline.d), BigInt(worker.state.indices.find((i) => i.index === 'SPI50').t0_ms) + BigInt(genesis + 1) * 2000n, 'deadline is the first tradable tick');
});

test('a missing receipt keeps the gate closed and the proof unwitnessed', async () => {
    const r = await scenario('p-missing');
    assert.equal(r.gate, 'engine_unwitnessed');
    assert.equal(r.proof.witness, 'missing');
});

test('a token for another subject is attested invalid: gate closed, proof invalid', async () => {
    await submit(commitment, 'p-wrong', issueTestToken(randomBytes(32)));
    await attestor.cycle();
    const r = await scenario('p-wrong');
    assert.equal(r.gate, 'engine_unwitnessed');
    assert.equal(r.proof.witness, 'invalid');
});

test('a forged genTime claim is ignored: the token time after the deadline makes the receipt late', async () => {
    const [e] = (await db.query(`select engine_private.v3_witness_deadline(config_hash,epoch_start_ms)::bigint d from public.engine_v3_epochs where epoch_start_ms=$1`, [today])).rows;
    await submit(commitment, 'p-forged', issueTestToken(commitment, Number(e.d) + 60_000), new Date(today - 3_600_000)); // writer claims an hour before the epoch
    await attestor.cycle();
    const [a] = (await db.query(`select a.verdict,a.before_deadline,a.gen_time_ms from public.engine_v3_witness_attestations a join public.engine_v3_witness_submissions s on s.id=a.submission_id where s.provider='p-forged'`)).rows;
    assert.deepEqual([a.verdict, a.before_deadline, BigInt(a.gen_time_ms)], ['valid', false, BigInt(e.d) + 60_000n]);
    const r = await scenario('p-forged');
    assert.equal(r.gate, 'engine_unwitnessed');
    assert.equal(r.proof.witness, 'late');
});

test('a token that does not chain to the pinned root is invalid', async () => {
    await submit(commitment, 'p-chain', issueTestToken(commitment));
    await attestor.cycle();
    const [a] = (await db.query(`select a.verdict,a.reason from public.engine_v3_witness_attestations a join public.engine_v3_witness_submissions s on s.id=a.submission_id where s.provider='p-chain'`)).rows;
    assert.equal(a.verdict, 'invalid'); assert.match(a.reason, /pinned root/);
    const r = await scenario('p-chain');
    assert.equal(r.gate, 'engine_unwitnessed');
    assert.equal(r.proof.witness, 'invalid');
});

test('an invalid first receipt does not block a valid replacement; identical resubmission is idempotent', async () => {
    const bad = issueTestToken(randomBytes(32));
    await submit(commitment, 'p-replace', bad);
    await submit(commitment, 'p-replace', bad);
    assert.equal((await db.query(`select count(*)::int n from public.engine_v3_witness_submissions where provider='p-replace'`)).rows[0].n, 1);
    await attestor.cycle();
    assert.equal((await scenario('p-replace')).gate, 'engine_unwitnessed');
    const [e] = (await db.query(`select engine_private.v3_witness_deadline(config_hash,epoch_start_ms)::bigint d from public.engine_v3_epochs where epoch_start_ms=$1`, [today])).rows;
    await submit(commitment, 'p-replace', issueTestToken(commitment, Number(e.d) - 1000));
    await attestor.cycle();
    const r = await scenario('p-replace');
    assert.equal(r.gate, null);
    assert.equal(r.proof.witness, 'witnessed');
    const events = (await db.query(`select count(*)::int n from public.engine_v3_events where action='submit_witness' and detail->>'provider'='p-replace'`)).rows[0].n;
    assert.equal(events, 2, 'each distinct token is audited');
});

test('a settlement epoch that is not witnessed blocks the purchase', async () => {
    assert.equal(await block(1, 3 * 43_200 + 10), 'engine_unwitnessed'); // exit tick three days out: uncommitted epoch
});

test('recovery after a TSA outage: a future epoch witnessed in time becomes tradable, the current epoch cannot be repaired late', async () => {
    const tomorrow = today + DAY;
    const tomorrowCommitment = (await db.query(`select commitment from public.engine_v3_epochs where epoch_start_ms=$1`, [tomorrow])).rows[0].commitment;
    const recover = new TestWitness('p-recover');
    recover.fail = true;
    await assert.rejects(recover.witness(tomorrowCommitment), /tsa_unreachable/);
    recover.fail = false;
    const receipt = await recover.witness(tomorrowCommitment);
    await submit(tomorrowCommitment, 'p-recover', receipt.token);
    await submit(commitment, 'p-recover', (await recover.witness(commitment)).token); // today: after its first tick
    await attestor.cycle();
    await configure({ required_witnesses: ['digicert', 'sectigo', 'p-recover'] });
    try {
        assert.equal((await db.query(`select engine_private.v3_epoch_attested('DEMO',$1) ok`, [tomorrow])).rows[0].ok, true);
        assert.equal((await db.query(`select engine_private.v3_epoch_attested('DEMO',$1) ok`, [today])).rows[0].ok, false);
        assert.equal(await block(), 'engine_unwitnessed');
    } finally { await configure({ required_witnesses: ['digicert', 'sectigo'] }); }
});

test('an unwitnessed checkpoint closes the gate once the witnessed anchor is too old, and shows in the proof', async () => {
    await configure({ max_checkpoint_gap_ticks: 3 });
    try {
        for (const w of worker.witnesses) w.fail = true;
        const unwitnessedCheckpoints = async () => (await db.query(`select count(*)::int n from public.engine_v3_checkpoints c where c.index_code='SPI50'
            and not exists(select 1 from public.engine_v3_witness_submissions s where s.subject_hash=c.checkpoint_hash)`)).rows[0].n;
        for (let i = 0; i < 20 && ((await block()) !== 'engine_checkpoint_stale' || (await unwitnessedCheckpoints()) === 0); i++) { await cycle(); await sleep(1000); }
        assert.ok(await unwitnessedCheckpoints() > 0, 'a checkpoint was published while both TSAs were unreachable');
        assert.equal(await block(), 'engine_checkpoint_stale');
        const components = await proofWitness(['digicert', 'sectigo']);
        assert.equal(components.checkpoints, 'unwitnessed');
    } finally {
        for (const w of worker.witnesses) w.fail = false;
        await configure({ max_checkpoint_gap_ticks: 20 });
    }
    for (let i = 0; i < 10 && (await block()) !== null; i++) { await cycle(); await sleep(800); }
    assert.equal(await block(), null, 'witnessing resumes and the gate reopens');
});

test('only the attestor can attest, only with the configured root bundle, once per submission', async () => {
    const [pending] = (await wdb.query(`select id from public.engine_v3_witness_submissions order by id desc limit 1`).catch(() => ({ rows: [] }))).rows;
    assert.equal(pending, undefined, 'the writer cannot read submissions directly');
    assert.match(await errorOf(wdb.query(`select public.engine_v3_attest_witness(1,'valid','forged by writer',0,$1,'writer')`, [Buffer.alloc(32)])), /permission denied/);
    assert.match(await errorOf(wdb.query('select * from public.engine_v3_pending_witnesses(10)')), /permission denied/);
    assert.match(await errorOf(adb.query(`select public.engine_v3_record_witness('epoch-commitment',$1,'digicert',$2,now())`, [commitment, issueTestToken(commitment)])), /permission denied/);
    assert.match(await errorOf(adb.query(`select public.engine_v3_publish_tick('DEMO','SPI50',1,1,1,1,1,1::smallint,$1)`, [Buffer.alloc(32)])), /permission denied/);
    assert.match(await asUser(db, 'customer', () => errorOf(db.query(`select public.engine_v3_attest_witness(1,'valid','x',0,$1,'c')`, [Buffer.alloc(32)]))), /permission denied/);
    assert.match(await asUser(db, 'administrator', () => errorOf(db.query(`select public.engine_v3_attest_witness(1,'valid','x',0,$1,'a')`, [Buffer.alloc(32)]))), /permission denied/);
    const [first] = (await db.query(`select id from public.engine_v3_witness_submissions order by id limit 1`)).rows;
    assert.match(await errorOf(adb.query(`select public.engine_v3_attest_witness($1,'valid','again',0,$2,'attestor')`, [first.id, Buffer.from(await rootBundleId(ROOTS), 'hex')])), /engine_v3_already_attested/);
    await submit(commitment, 'digicert', issueTestToken(commitment, Date.now()));
    const [next] = (await adb.query('select * from public.engine_v3_pending_witnesses(1)')).rows;
    assert.match(await errorOf(adb.query(`select public.engine_v3_attest_witness($1,'valid','wrong bundle',0,$2,'attestor')`, [next.submission_id, randomBytes(32)])), /engine_v3_root_bundle_mismatch/);
    assert.match(await errorOf(wdb.query(`select public.engine_v3_record_witness('epoch-commitment',$1,'digicert',$2,now())`, [randomBytes(32), issueTestToken(commitment)])), /engine_v3_subject_unknown/);
    assert.match(await errorOf(wdb.query(`select public.engine_v3_record_witness('epoch-commitment',$1,'digicert',$2,now())`, [commitment, Buffer.from('not a token')])), /engine_v3_token_malformed/);
    assert.match(await errorOf(db.query(`update public.engine_v3_witness_attestations set verdict='valid'`)), /engine_v3_immutable/);
});
