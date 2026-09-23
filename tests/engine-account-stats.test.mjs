import assert from 'node:assert/strict';
import test from 'node:test';
import { claimsFor, createTestDatabase } from './helpers/test-db.mjs';

async function as(db, identity, role = 'authenticated') {
    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify(identity ? claimsFor(identity) : {})]);
    await db.exec(`set role ${role}`);
}

async function enroll(db, identity) {
    await as(db, identity);
    const account = await db.query('select public.enroll_practice_account() id');
    await db.exec('reset role');
    return account.rows[0].id;
}

/* Seeds contracts directly so every state is represented. OPEN rows go first:
   the insert guardrail rate-limits by recent contract count. */
async function seed(db, accountId, state, count, stake, payout) {
    for (let n = 0; n < count; n++) {
        await db.query(`insert into public.engine_contracts(trading_account_id,execution_mode,index_code,contract_type,stake,payout,payout_multiplier,win_digits,policy_version,entry_tick_no,settle_tick_no,state,idempotency_key,payload_hash,settled_at)
            values($1,'DEMO','SPI10','EVEN',$2,$3,$3::numeric/$2::numeric,5,1,$4,$4,$5,$6,'stats-fixture',case when $5='OPEN' then null else now() end)`,
            [accountId, stake, payout, 100 + n, state, `${state}-${n}-${accountId}`]);
    }
}

test('account stats aggregate every settled contract of the account on the server', async () => {
    const db = await createTestDatabase();
    try {
        const account = await enroll(db, 'customer');
        const other = await enroll(db, 'customer2');
        await seed(db, account, 'OPEN', 2, 10, 19.30);
        await seed(db, other, 'OPEN', 1, 10, 19.30);
        await seed(db, account, 'WON', 25, 10, 19.30);
        await seed(db, account, 'LOST', 7, 5, 9.65);
        await seed(db, account, 'VOID', 3, 20, 38.60);
        await seed(db, other, 'WON', 4, 100, 193.00);
        await seed(db, other, 'LOST', 2, 50, 96.50);

        await as(db, 'customer');
        const stats = (await db.query('select public.get_account_stats($1) stats', [account])).rows[0].stats;
        // 25 wins x 9.30 profit - 7 losses x 5.00 stake; voids and open contracts are neutral.
        assert.deepEqual({ ...stats, net_result: Number(stats.net_result) }, { wins: 25, losses: 7, voids: 3, open: 2, net_result: 197.5, currency: 'USD' });
        assert.match(String(stats.net_result), /^197\.50?$/);

        await as(db, 'customer2');
        const otherStats = (await db.query('select public.get_account_stats($1) stats', [other])).rows[0].stats;
        assert.deepEqual({ ...otherStats, net_result: Number(otherStats.net_result) }, { wins: 4, losses: 2, voids: 0, open: 1, net_result: 272, currency: 'USD' });
        await assert.rejects(db.query('select public.get_account_stats($1)', [account]), /account_not_available/);

        await as(db, null, 'anon');
        await assert.rejects(db.query('select public.get_account_stats($1)', [account]), /permission denied/);

        await db.exec('reset role');
        await db.query("update public.trading_accounts set status='SUSPENDED' where id=$1", [account]);
        await as(db, 'customer');
        await assert.rejects(db.query('select public.get_account_stats($1)', [account]), /account_not_available/);
    } finally {
        await db.exec('reset role');
        await db.close();
    }
});

test('account stats of a fresh account are zero with a two-decimal net result', async () => {
    const db = await createTestDatabase();
    try {
        const account = await enroll(db, 'customer');
        await as(db, 'customer');
        const stats = (await db.query('select public.get_account_stats($1) stats', [account])).rows[0].stats;
        assert.deepEqual({ ...stats, net_result: Number(stats.net_result) }, { wins: 0, losses: 0, voids: 0, open: 0, net_result: 0, currency: 'USD' });
        assert.match(String(stats.net_result), /^0(\.00)?$/);
    } finally {
        await db.exec('reset role');
        await db.close();
    }
});

test('ACCESS restrictions gate account stats like every account-scoped read', async () => {
    const db = await createTestDatabase();
    try {
        const account = await enroll(db, 'customer');
        await db.query("insert into public.account_restrictions(user_id,restriction_type,scope,severity,params,active,reason,applied_by) values($1,'ACCESS','DEMO','BLOCKED','{}',true,'Stats access restriction',$2)", [claimsFor('customer').sub, claimsFor('ian').sub]);
        await as(db, 'customer');
        await assert.rejects(db.query('select public.get_account_stats($1)', [account]), /access_restricted/);
    } finally {
        await db.exec('reset role');
        await db.close();
    }
});
