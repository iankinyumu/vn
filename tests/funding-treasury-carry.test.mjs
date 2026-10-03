// Automatic SANDBOX treasury carry-forward (migration 20260927110000) on real
// PostgreSQL. Older snapshots are inserted with explicit timestamps to stand in
// for the passage of time.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { FUNDING_MIGRATIONS, V3_MIGRATIONS, asUser, createRealDatabase, identities } from './helpers/pg-real.mjs';

let T, db;
const errorOf = async (promise) => { try { await promise; return null; } catch (error) { return error.message; } };
const as = (name, sql, params) => asUser(db, name, () => db.query(sql, params));
async function carry(environment = 'SANDBOX') {
    await db.exec('set role service_role');
    try { return (await db.query('select public.funding_svc_carry_forward_treasury($1) r', [environment])).rows[0].r; } finally { await db.exec('reset role'); }
}
const ownerSnapshot = (kes, age) => db.query(`insert into funding.treasury_snapshots(environment, kes_liquid_reserve, recorded_by, note, recorded_at)
    values ('SANDBOX', $1, $2, 'Owner test float', now() - $3::interval) returning id::int id`, [kes, identities.ian.id, age]).then((r) => r.rows[0].id);
const status = async () => (await as('ian', `select public.funding_staff_overview('SANDBOX') o`)).rows[0].o.treasury;

before(async () => {
    T = await createRealDatabase({ extra: [...V3_MIGRATIONS, ...FUNDING_MIGRATIONS] });
    db = T.db;
});
after(async () => { await T?.close(); });

test('with no owner figure nothing is invented; production is always refused', async () => {
    assert.equal((await carry()).outcome, 'OWNER_SNAPSHOT_REQUIRED');
    assert.equal((await db.query('select count(*)::int n from funding.treasury_snapshots')).rows[0].n, 0);
    assert.match(await errorOf(carry('PRODUCTION')), /production_requires_real_evidence/);
    assert.match(await errorOf(carry('ELSEWHERE')), /validation_failed/);
});

test('an owner figure older than 30 days is not carried forward', async () => {
    await ownerSnapshot(240000, '31 days');
    const result = await carry();
    assert.equal(result.outcome, 'OWNER_SNAPSHOT_REQUIRED');
    assert.equal((await db.query('select count(*)::int n from funding.treasury_snapshots where carried_from is not null')).rows[0].n, 0);
});

test('the daily run carries the owner figure forward exactly once per Nairobi day, even when the figure is recent', async () => {
    const owner = await ownerSnapshot(250000, '18 hours');
    const carried = await carry();
    assert.deepEqual([carried.outcome, carried.carried_from, Number(carried.kes_liquid_reserve)], ['CARRIED_FORWARD', owner, 250000]);
    const row = (await db.query('select recorded_by, carried_from, note from funding.treasury_snapshots where id = $1', [carried.snapshot_id])).rows[0];
    assert.equal(row.recorded_by, null);
    assert.equal(Number(row.carried_from), owner);
    assert.match(row.note, new RegExp(`^Automatic sandbox carry-forward of owner snapshot ${owner} recorded `));
    assert.equal((await status()).status, 'OK');
    const again = await carry();
    assert.deepEqual([again.outcome, again.snapshot_id], ['ALREADY_REFRESHED_TODAY', carried.snapshot_id], 'a second run the same day records nothing');
    assert.equal((await db.query('select count(*)::int n from funding.treasury_snapshots where carried_from is not null')).rows[0].n, 1);
    const audit = (await db.query(`select actor_type, actor_id from public.admin_audit_events where action = 'funding.treasury_carry_forward'`)).rows;
    assert.deepEqual(audit, [{ actor_type: 'operator', actor_id: null }]);
});

test('a carried row always names its owner figure and never exists in production', async () => {
    assert.match(await errorOf(db.query(`insert into funding.treasury_snapshots(environment, kes_liquid_reserve, recorded_by, note) values ('SANDBOX', 1, null, 'no origin')`)), /treasury_snapshots_origin_check/);
    const owner = (await db.query(`select id from funding.treasury_snapshots where recorded_by is not null limit 1`)).rows[0].id;
    assert.match(await errorOf(db.query(`insert into funding.treasury_snapshots(environment, kes_liquid_reserve, recorded_by, carried_from, note) values ('PRODUCTION', 1, null, $1, 'carried into production')`, [owner])), /treasury_snapshots_origin_check/);
    assert.match(await errorOf(db.query(`update funding.treasury_snapshots set kes_liquid_reserve = 1`)), /funding_record_immutable/);
});

test('the status shows the automatic chain and when the owner must confirm the figure; callers cannot run the carry-forward', async () => {
    const shown = (await as('administrator', `select public.funding_treasury_snapshot_status('SANDBOX') s`)).rows[0].s;
    assert.equal(shown.automatic, true);
    assert.equal(shown.latest_automatic, true);
    assert.equal(Number(shown.owner_kes_liquid_reserve), 250000);
    assert.ok(Date.parse(shown.owner_confirmation_due) > Date.now());
    assert.equal((await as('administrator', `select public.funding_treasury_snapshot_status('PRODUCTION') s`)).rows[0].s.automatic, false);
    assert.match(await errorOf(as('customer', `select public.funding_treasury_snapshot_status('SANDBOX')`)), /forbidden/);
    assert.match(await errorOf(as('ian', `select public.funding_svc_carry_forward_treasury('SANDBOX')`)), /permission denied/);
});
