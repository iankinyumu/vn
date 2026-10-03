import assert from 'node:assert/strict';
import test from 'node:test';
import { claimsFor, createTestDatabase, identities } from './helpers/test-db.mjs';

async function as(db, identity, role = 'authenticated') {
    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify(identity ? claimsFor(identity) : {})]);
    await db.exec(`set role ${role}`);
}

test('engine internals and unrevealed seeds are never callable by API roles', async () => {
    const db = await createTestDatabase();
    try {
        await as(db, null, 'anon');
        await assert.rejects(db.query('select public.engine_advance()'), /permission denied/);
        await assert.rejects(db.query("select public.engine_price_units_v2(decode('00','hex'),'DEMO','SPI10',1,1000000,1000000,200,.003)"), /permission denied/);
        await assert.rejects(db.query("select * from public.get_tick_verification_data('00000000-0000-4000-8000-000000000006','SPI10',0,1)"), /permission denied/);
        await assert.rejects(db.query('select * from engine_private.epoch_seeds'), /permission denied/);

        await as(db, 'customer');
        await assert.rejects(db.query("select public.engine_digit(decode('00','hex'),'DEMO','SPI10',1)"), /permission denied/);
        await assert.rejects(db.query('select public.engine_post_ledger($1,$2,$3,$4)', [identities.customer.id, 'attack', 'attack', '[]']), /permission denied/);
        const config = await db.query('select public.get_engine_config() config');
        assert.equal(config.rows[0].config.real_enabled, false);
    } finally {
        await db.exec('reset role');
        await db.close();
    }
});

test('admin engine RPCs observe the capability boundary and expose live data', async () => {
    const db = await createTestDatabase();
    try {
        await as(db, 'agent');
        await assert.rejects(db.query('select * from public.list_admin_contracts()'), /forbidden/);
        await assert.rejects(db.query("select public.set_index_trading_status('SPI10','DEMO','PAUSED','Operational pause for a verified incident')"), /forbidden/);

        await as(db, 'administrator');
        assert.deepEqual((await db.query('select * from public.list_admin_contracts()')).rows, []);
        assert.deepEqual((await db.query("select public.get_admin_engine_exposure('DEMO') exposure")).rows[0].exposure, []);
        await db.query("select public.set_index_trading_status('SPI10','DEMO','PAUSED','Operational pause for a verified incident')");
        await db.exec('reset role');
        const status = await db.query("select status from public.engine_indices where code='SPI10' and execution_mode='DEMO'");
        assert.equal(status.rows[0].status, 'PAUSED');
        const audit = await db.query("select action from public.admin_audit_events where action='engine.index_status'");
        assert.equal(audit.rows.length, 1);
    } finally {
        await db.exec('reset role');
        await db.close();
    }
});
