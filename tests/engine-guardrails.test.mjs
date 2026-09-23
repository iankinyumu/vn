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

test('settlement posts an idempotent win and clears the settled exposure bucket', async () => {
    const db = await createTestDatabase();
    await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify(claimsFor('customer'))]);
    await db.exec('set role authenticated');
    const account = await db.query('select public.enroll_practice_account() id');
    await db.exec('reset role');
    await db.query("update public.index_state set last_tick_no=1,updated_at=now() where index_code='SPI10' and execution_mode='DEMO'");
    await db.exec('set role authenticated');
    const purchase = await db.query("select public.engine_buy_contract($1,'SPI10','EVEN',null,10,1,'settle-win') result", [account.rows[0].id]);
    const contractId = purchase.rows[0].result.id;
    await db.exec('reset role');
    const contract = await db.query('select settle_tick_no,payout from public.engine_contracts where id=$1', [contractId]);
    const epoch = await db.query("insert into public.engine_epochs(id,execution_mode,starts_at,ends_at,seed_commitment,chain_hash) values(gen_random_uuid(),'DEMO',date_trunc('day',now()),date_trunc('day',now())+interval '1 day','proof','chain') returning id");
    await db.query("insert into public.index_ticks(index_code,execution_mode,tick_no,epoch_id,scheduled_at,generated_at,price,digit) values('SPI10','DEMO',$1,$2,now(),now(),1000.002,2)", [contract.rows[0].settle_tick_no, epoch.rows[0].id]);
    await db.query("select public.engine_settle_tick('SPI10','DEMO',$1)", [contract.rows[0].settle_tick_no]);
    const settled = await db.query('select state,exit_digit from public.engine_contracts where id=$1', [contractId]);
    assert.equal(settled.rows[0].state, 'WON');
    assert.equal(Number(settled.rows[0].exit_digit), 2);
    const exposure = await db.query("select count(*)::integer count from public.engine_tick_exposure where execution_mode='DEMO' and index_code='SPI10' and settle_tick_no=$1", [contract.rows[0].settle_tick_no]);
    assert.equal(exposure.rows[0].count, 0);
    await db.close();
});

test('ACCESS restrictions gate account-scoped customer RPCs', async () => {
    const db = await createTestDatabase();
    await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify(claimsFor('customer'))]);
    await db.exec('set role authenticated');
    const account = await db.query('select public.enroll_practice_account() id');
    await db.exec('reset role');
    await db.query("insert into public.account_restrictions(user_id,restriction_type,scope,severity,params,active,reason,applied_by) values($1,'ACCESS','DEMO','BLOCKED','{}',true,'Test access restriction',$2)", [claimsFor('customer').sub, claimsFor('ian').sub]);
    await db.exec('set role authenticated');
    await assert.rejects(db.query('select public.get_account_summary($1)', [account.rows[0].id]), /access_restricted/);
    await db.exec('reset role');
    await db.close();
});
