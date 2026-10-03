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

test('unified generator publishes a continuous price and derives the settlement digit from it', async () => {
    const db = await createTestDatabase();
    // PGlite has no pgcrypto HMAC. A fixed 32-byte block exercises the SQL
    // price arithmetic, price continuity, and tick publication path.
    await db.exec(`create function public.hmac(bytea,bytea,text) returns bytea language sql immutable as
        $$ select decode(repeat('0123456789abcdef',4),'hex') $$;`);
    // Version 2 runs only from a scheduled start tick; here it starts at tick 1.
    await db.exec("update public.engine_indices set t0=now()-interval '8 seconds',v2_start_tick_no=1 where code='SPI10'");
    await db.query('select public.engine_advance()');
    const result = await db.query("select tick_no,price,digit,previous_price,generation_version,generation_sigma from public.index_ticks where index_code='SPI10' order by tick_no");
    assert.ok(result.rows.length >= 3);
    assert.equal(Number(result.rows[0].price), 999.722);
    for (const [index, tick] of result.rows.entries()) {
        assert.equal(Number(tick.generation_version), 2);
        assert.equal(Number(tick.digit), Math.round(Number(tick.price) * 1000) % 10);
        if (index) assert.equal(Number(tick.previous_price), Number(result.rows[index - 1].price));
        assert.equal(Number(tick.generation_sigma), .0002);
    }
    await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify(claimsFor('customer'))]);
    await db.exec('set role authenticated');
    const account = await db.query('select public.enroll_practice_account() id');
    const proofRows = await db.query("select * from public.get_tick_verification_data($1,'SPI10',0,10)", [account.rows[0].id]);
    assert.equal(proofRows.rows.length, result.rows.length);
    assert.equal(Number(proofRows.rows[0].generation_version), 2);
    await db.exec('reset role');
    await db.close();
});
