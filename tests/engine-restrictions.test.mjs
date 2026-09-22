import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestDatabase, identities } from './helpers/test-db.mjs';

test('expired restrictions are ignored and blocked restrictions resolve by scoped mode', async () => {
    const db = await createTestDatabase();
    await db.query(`insert into public.account_restrictions(user_id,restriction_type,scope,severity,params,active,reason,applied_by,expires_at)
        values($1,'TRADING','DEMO','BLOCKED','{}',true,'Practice block',$2,now()+interval '1 hour'),($1,'TRADING','REAL','BLOCKED','{}',true,'Expired real block',$2,now()-interval '1 hour')`, [identities.customer.id, identities.ian.id]);
    const result = await db.query("select public.effective_restrictions($1,'DEMO','TRADING') value", [identities.customer.id]);
    assert.equal(result.rows[0].value.blocked, true);
    await db.close();
});
