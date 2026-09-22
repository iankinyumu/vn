import assert from 'node:assert/strict';
import test from 'node:test';
import { claimsFor, createTestDatabase } from './helpers/test-db.mjs';

test('buy records a mode-scoped correlated exposure bucket', async () => {
    const db = await createTestDatabase();
    await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify(claimsFor('customer'))]);
    await db.exec('set role authenticated');
    const account = await db.query('select public.enroll_practice_account() id');
    await db.exec('reset role');
    await db.query("update public.index_state set last_tick_no=1,updated_at=now() where index_code='SPI10' and execution_mode='DEMO'");
    await db.exec('set role authenticated');
    const bought = await db.query("select public.engine_buy_contract($1,'SPI10','EVEN',null,10,1,'guardrail-buy') result", [account.rows[0].id]);
    assert.ok(bought.rows[0].result.id);
    await db.exec('reset role');
    const exposure = await db.query("select net_loss_by_digit from public.engine_tick_exposure where execution_mode='DEMO' and index_code='SPI10'");
    assert.equal(exposure.rows.length, 1);
    assert.equal(exposure.rows[0].net_loss_by_digit.length, 10);
    await db.close();
});

test('restriction parameter validation rejects unknown and non-positive limits', async () => {
    const db = await createTestDatabase();
    await assert.rejects(
        db.query("select public.validate_engine_restriction_params('TRADING','LIMITED','{\"unknown\": 1}'::jsonb)"),
        /validation_failed/
    );
    await assert.rejects(
        db.query("select public.validate_engine_restriction_params('TRADING','LIMITED','{\"max_stake\": 0}'::jsonb)"),
        /validation_failed/
    );
    await db.close();
});
