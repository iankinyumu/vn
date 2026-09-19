import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createTestDatabase, claimsFor, identities } from './helpers/test-db.mjs';

/* public.account_restrictions is revoked from every client role, so a customer
 * has no direct read path. get_my_active_restrictions() is the only way they can
 * learn why they were restricted, and it must stay hard-scoped to auth.uid():
 * a customer seeing another customer's restriction reason would leak internal
 * enforcement notes. */

const MIGRATION = '20260919130000_customer_restriction_status.sql';

async function as(db, name, aal = 'aal2') {
    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify(claimsFor(name, aal))]);
    await db.exec('set role authenticated');
}

async function applyMigration(db, name) {
    const sql = (await fs.readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8'))
        .replace(/^\uFEFF/, '');
    await db.exec(sql);
}

test('Customer restrictions: get_my_active_restrictions is scoped to the caller', async (t) => {
    const db = await createTestDatabase();

    try {
        // The shared fixture does not load this migration yet, so it is applied
        // here on top of the standard schema.
        await applyMigration(db, MIGRATION);

        await as(db, 'administrator');
        const applied = (await db.query(
            'select public.apply_account_restriction($1, $2, $3) as result',
            [identities.customer.id, 'TRADING', 'Chargeback investigation open']
        )).rows[0].result;
        assert.equal(applied.active, true);

        await t.test('a restricted customer sees their own active restriction', async () => {
            await as(db, 'customer');
            const result = (await db.query(
                'select restriction_type, reason, applied_at from public.get_my_active_restrictions()'
            )).rows;
            assert.equal(result.length, 1);
            assert.equal(result[0].restriction_type, 'TRADING');
            assert.equal(result[0].reason, 'Chargeback investigation open');
            assert.ok(result[0].applied_at, 'applied_at must be returned for display');
        });

        await t.test('an unrestricted customer sees zero rows', async () => {
            await as(db, 'customer2');
            const result = (await db.query(
                'select restriction_type, reason, applied_at from public.get_my_active_restrictions()'
            )).rows;
            assert.deepEqual(result, []);
        });

        await t.test('a customer cannot ask for another user_id', async () => {
            await as(db, 'customer2');
            // The function takes no arguments at all, so there is no call shape
            // that can name someone else.
            await assert.rejects(
                db.query('select * from public.get_my_active_restrictions($1)', [identities.customer.id]),
                /does not exist/i
            );
        });

        await t.test('a lifted restriction disappears from the customer view', async () => {
            await as(db, 'administrator');
            await db.query('select public.lift_account_restriction($1, $2)', [applied.id, 'Chargeback resolved']);

            await as(db, 'customer');
            const result = (await db.query('select * from public.get_my_active_restrictions()')).rows;
            assert.deepEqual(result, []);
        });

        await t.test('the restrictions table itself stays unreadable by clients', async () => {
            for (const role of ['anon', 'authenticated']) {
                await db.exec('reset role');
                await db.exec(`set role ${role}`);
                await assert.rejects(
                    db.query('select * from public.account_restrictions'),
                    /permission denied/i,
                    `${role} must not read account_restrictions directly`
                );
            }
        });

        await t.test('anon cannot execute the RPC', async () => {
            await db.exec('reset role');
            await db.exec('set role anon');
            await assert.rejects(
                db.query('select * from public.get_my_active_restrictions()'),
                /permission denied/i
            );
        });
    } finally {
        await db.exec('reset role');
        await db.close();
    }
});
