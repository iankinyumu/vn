// Automatic CBK rate import (migration 20260927100000) on real PostgreSQL: the
// database decides whether an observed homepage rate is published, held for an
// owner, ignored or recorded as a failure. The tests share one database and run
// in order; dates are relative to the database's Nairobi date.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { FUNDING_MIGRATIONS, V3_MIGRATIONS, asUser, createRealDatabase, identities } from './helpers/pg-real.mjs';

const SOURCE = 'https://www.centralbank.go.ke/';
let T, db, today;
const day = (offset) => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); };
const errorOf = async (promise) => { try { await promise; return null; } catch (error) { return error.message; } };
const as = (name, sql, params) => asUser(db, name, () => db.query(sql, params));
const one = async (name, sql, params) => (await as(name, sql, params)).rows[0];

async function observe(rate, date, failure = null) {
    await db.exec('set role service_role');
    try {
        return (await db.query('select public.funding_svc_record_rate_observation($1, $2::date, $3, $4) r', [rate, date, SOURCE, failure])).rows[0].r;
    } finally { await db.exec('reset role'); }
}
const current = async () => (await db.query('select version::int version, kes_per_usd::text rate, rate_date::text d, published_by from funding.fx_rate_versions order by version desc limit 1')).rows[0];

before(async () => {
    T = await createRealDatabase({ extra: [...V3_MIGRATIONS, ...FUNDING_MIGRATIONS] });
    db = T.db;
    today = (await db.query('select funding.nairobi_date(now())::text d')).rows[0].d;
    // Baseline: an owner-published rate two days ago.
    await as('ian', `select public.funding_publish_rate(129.62, $1::date, $2, 'Baseline CBK mean for the test')`, [day(-2), SOURCE]);
});
after(async () => { await T?.close(); });

test('the same or an older CBK figure changes nothing; a newer date within 1.5% publishes automatically, once', async () => {
    const base = await current();
    assert.equal((await observe(129.62, day(-2))).outcome, 'UNCHANGED');
    assert.equal((await observe(129.10, day(-3))).outcome, 'UNCHANGED', 'an older date never replaces the current rate');
    assert.equal((await current()).version, base.version);

    const published = await observe(130.5, day(-1));
    assert.equal(published.outcome, 'PUBLISHED');
    assert.equal(published.change_bp, 68);
    const rate = await current();
    assert.deepEqual([rate.rate, rate.d, rate.published_by], ['130.5000', day(-1), null]);
    assert.equal(rate.version, published.version);

    const repeat = await observe(130.5, day(-1));
    assert.deepEqual([repeat.outcome, repeat.repeat], ['PUBLISHED', true]);
    assert.equal((await current()).version, rate.version, 'an hourly repeat publishes nothing new');
    assert.equal((await db.query('select seen_count from funding.fx_rate_observations where id = $1', [published.observation_id])).rows[0].seen_count, 2);
    const audit = (await db.query(`select actor_type, actor_id from public.admin_audit_events where action = 'funding.rate_publish' and after_state->>'observation_id' = $1`, [String(published.observation_id)])).rows;
    assert.deepEqual(audit, [{ actor_type: 'operator', actor_id: null }]);
});

test('a move over 1.5% or a changed figure for the current date waits for an owner; implausible input is recorded as invalid', async () => {
    const before = (await current()).version;
    const big = await observe(135, day(0));
    assert.deepEqual([big.outcome, big.change_bp], ['PENDING_APPROVAL', 345]);
    const corrected = await observe(130.7, day(-1));
    assert.equal(corrected.outcome, 'PENDING_APPROVAL', 'a different figure for the current rate date');
    assert.equal((await current()).version, before, 'nothing was published');

    assert.equal((await observe(129.62, day(1))).outcome, 'INVALID', 'a future date');
    assert.equal((await observe(129.62, day(-20))).outcome, 'INVALID', 'too old');
    assert.equal((await observe(1296.2, day(0))).outcome, 'INVALID', 'out of bounds');
    const failed = await observe(null, null, 'rates_box_missing');
    assert.deepEqual([failed.outcome, failed.detail], ['FAILED', 'rates_box_missing']);

    const status = (await one('administrator', 'select public.funding_rate_sync_status() s')).s;
    assert.equal(status.band_bp, 150);
    assert.equal(status.last.outcome, 'FAILED');
    assert.deepEqual(status.pending.map((row) => [Number(row.kes_per_usd), row.rate_date]), [[135, day(0)], [130.7, day(-1)]]);
    assert.equal(status.recent.length, 9, 'two unchanged, one published, two pending, three invalid, one failed');
    assert.ok(status.last_success_at);
});

test('only an owner with a fresh code decides; approval publishes under their name, rejection publishes nothing', async () => {
    const pending = (await one('ian', 'select public.funding_rate_sync_status() s')).s.pending;
    const [big, corrected] = [pending.find((row) => Number(row.kes_per_usd) === 135), pending.find((row) => Number(row.kes_per_usd) === 130.7)];
    assert.match(await errorOf(as('administrator', `select public.funding_decide_rate_observation($1, true, 'Administrator tries to approve')`, [big.id])), /forbidden/);
    assert.match(await errorOf(asUser(db, 'ian', () => db.query(`select public.funding_decide_rate_observation($1, true, 'Owner without a fresh code')`, [big.id]), 'aal1')), /mfa_required|reauthentication_required/);
    assert.match(await errorOf(as('ian', `select public.funding_decide_rate_observation($1, true, 'short')`, [big.id])), /validation_failed/);

    const approved = (await one('ian', `select public.funding_decide_rate_observation($1, true, 'CBK moved sharply; checked on the CBK site') r`, [big.id])).r;
    assert.equal(approved.outcome, 'APPROVED');
    const rate = await current();
    assert.deepEqual([rate.rate, rate.d, rate.published_by, rate.version], ['135.0000', day(0), identities.ian.id, approved.version]);
    assert.match(await errorOf(as('ian', `select public.funding_decide_rate_observation($1, true, 'Approving twice is refused')`, [big.id])), /conflict/);
    assert.match(await errorOf(as('ian', `select public.funding_decide_rate_observation($1, true, 'Older than the current rate now')`, [corrected.id])), /conflict/);

    const rejected = (await one('ian', `select public.funding_decide_rate_observation($1, false, 'Superseded by the newer approved rate') r`, [corrected.id])).r;
    assert.deepEqual([rejected.outcome, rejected.version], ['REJECTED', null]);
    assert.equal((await current()).version, approved.version);
    assert.deepEqual((await one('ian', 'select public.funding_rate_sync_status() s')).s.pending, []);
});

test('callers cannot reach the import or its table', async () => {
    for (const name of ['customer', 'administrator', 'ian']) {
        assert.match(await errorOf(as(name, `select public.funding_svc_record_rate_observation(130, current_date, 'x://y', null)`)), /permission denied/);
        assert.match(await errorOf(as(name, 'select * from funding.fx_rate_observations')), /permission denied/);
    }
    assert.match(await errorOf(as('customer', 'select public.funding_rate_sync_status()')), /forbidden/);
    await db.exec('set role anon');
    try {
        assert.match(await errorOf(db.query('select public.funding_rate_sync_status()')), /permission denied/);
    } finally { await db.exec('reset role'); }
});
