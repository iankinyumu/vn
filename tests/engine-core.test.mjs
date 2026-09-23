import assert from 'node:assert/strict';
import test from 'node:test';
import { claimsFor, createTestDatabase, identities } from './helpers/test-db.mjs';

test('payout vectors use exact numeric cent flooring', async () => {
    const db = await createTestDatabase();
    const rows = await db.query("select * from public.engine_payout(100::numeric,'EVEN',null::smallint,.035::numeric)");
    assert.equal(Number(rows.rows[0].payout), 193);
    const rare = await db.query("select * from public.engine_payout(100::numeric,'MATCH',1::smallint,.035::numeric)");
    assert.equal(Number(rare.rows[0].payout), 965);
    await db.close();
});

test('practice enrolment is idempotent and creates USD virtual credit', async () => {
    const db = await createTestDatabase();
    await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify(claimsFor('customer'))]);
    await db.exec('set role authenticated');
    const one = await db.query('select public.enroll_practice_account() id');
    const two = await db.query('select public.enroll_practice_account() id');
    assert.equal(one.rows[0].id, two.rows[0].id);
    const summary = await db.query('select public.get_account_summary($1) summary', [one.rows[0].id]);
    assert.equal(summary.rows[0].summary.available, 10000);
    await db.exec('reset role');
    await db.close();
});

test('engine config returns the caller practice account and its policy limits', async () => {
    const db = await createTestDatabase();
    await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify(claimsFor('customer'))]);
    await db.exec('set role authenticated');
    const account = await db.query('select public.enroll_practice_account() id');
    const config = await db.query('select public.get_engine_config() config');
    assert.equal(config.rows[0].config.ledger_asset, 'USD');
    assert.equal(config.rows[0].config.real_enabled, false);
    assert.equal(config.rows[0].config.accounts.length, 1);
    assert.equal(config.rows[0].config.accounts[0].id, account.rows[0].id);
    assert.equal(Number(config.rows[0].config.accounts[0].limits.min_stake), 1);
    await db.exec('reset role');
    await db.close();
});

test('engine advances deterministic ticks with the price-digit invariant', async (t) => {
    const db = await createTestDatabase();
    const crypto = await db.query("select to_regprocedure('hmac(bytea,bytea,text)') available");
    if (crypto.rows[0].available === null) {
        await db.close();
        t.skip('PGlite does not provide PostgreSQL pgcrypto HMAC primitives');
        return;
    }
    await db.exec("update public.engine_indices set t0=now()-interval '4 seconds'");
    await db.query('select public.engine_advance()');
    const ticks = await db.query('select price,digit,decimals from public.index_ticks join public.engine_indices on code=index_code and engine_indices.execution_mode=index_ticks.execution_mode');
    assert.ok(ticks.rows.length > 0);
    for (const tick of ticks.rows) {
        const unit = 10 ** -Number(tick.decimals);
        assert.equal(Math.round(Number(tick.price) / unit) % 10, Number(tick.digit));
    }
    await db.close();
});
