import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createTestDatabase, identities, claimsFor } from './helpers/test-db.mjs';

const MIGRATIONS = ['supabase/migrations/20261003120000_customer_onboarding.sql', 'supabase/migrations/20261003130000_split_onboarding_and_verification.sql', 'supabase/migrations/20261003140000_remove_verification.sql', 'supabase/migrations/20261003150000_onboarding_answer_values.sql'];

test('onboarding: a light, optional welcome that customers can answer, skip or change later', async (t) => {
    const db = await createTestDatabase();
    for (const file of MIGRATIONS) await db.exec(fs.readFileSync(file, 'utf8'));
    const scalar = async (sql, args = []) => (await db.query(sql, args)).rows[0]?.result;
    async function as(name, aal = 'aal2') {
        await db.exec('reset role');
        await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify(claimsFor(name, aal))]);
        await db.exec('set role authenticated');
    }
    const save = (data, finish = false, skip = false) => scalar('select public.save_my_onboarding($1,$2,$3) as result', [JSON.stringify(data), finish, skip]);

    await t.test('it asks nothing personal: only goal, experience, interests and where to start', async () => {
        await db.exec('reset role');
        const columns = (await db.query("select column_name from information_schema.columns where table_schema = 'public' and table_name = 'customer_onboarding'")).rows.map((r) => r.column_name).sort();
        assert.deepEqual(columns, ['completed_at', 'created_at', 'experience', 'goal', 'interests', 'skipped', 'start_with', 'updated_at', 'user_id']);
    });

    await t.test('answers save a step at a time and finishing marks it done', async () => {
        await as('customer');
        assert.equal((await scalar('select public.get_my_onboarding() as result')).status, 'not_started');
        let view = await save({ goal: 'learn' });
        assert.equal(view.status, 'in_progress');
        view = await save({ experience: 'new', interests: ['overunder', 'evenodd', 'evenodd'] });
        assert.deepEqual(view.data.interests, ['evenodd', 'overunder']);
        assert.equal(view.data.goal, 'learn', 'earlier answers are kept');
        view = await save({ start_with: 'trade' }, true);
        assert.equal(view.status, 'completed');
        assert.equal(view.skipped, false);
        const first = view.completed_at;
        view = await save({ experience: 'experienced', interests: ['matches'] }, true);
        assert.equal(view.data.experience, 'experienced', 'answers can be changed later, from the profile');
        assert.equal(view.completed_at, first, 'changing answers keeps the original completion time');
    });

    await t.test('unknown answers are refused; clients cannot write the table', async () => {
        await as('customer');
        await assert.rejects(save({ goal: 'get_rich' }), /invalid_goal/);
        await assert.rejects(save({ interests: ['roulette'] }), /invalid_interests/);
        await assert.rejects(db.query("update public.customer_onboarding set goal = 'fun'"), /permission denied/);
    });

    await t.test('skipping ends it with nothing answered', async () => {
        await as('customer2');
        const view = await save({}, false, true);
        assert.equal(view.status, 'completed');
        assert.equal(view.skipped, true);
        assert.deepEqual(view.data, { interests: [] });
    });

    await t.test('staff with customers.read see the answers; anonymous callers see nothing', async () => {
        await as('agent');
        await assert.rejects(scalar('select public.staff_get_customer_onboarding($1) as result', [identities.customer.id]), /forbidden/);
        await as('administrator');
        assert.equal((await scalar('select public.staff_get_customer_onboarding($1) as result', [identities.customer.id])).data.start_with, 'trade');
        await db.exec('reset role');
        await db.exec('set role anon');
        await assert.rejects(db.query('select public.get_my_onboarding()'), /permission denied/);
        await db.exec('reset role');
    });
});

test('identity verification is gone: no table, no functions, no answers kept', async () => {
    const db = await createTestDatabase();
    await db.exec(fs.readFileSync(MIGRATIONS[0], 'utf8'));
    await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify(claimsFor('customer'))]);
    await db.exec('set role authenticated');
    await db.query('select public.save_my_onboarding_step(1,$1)', [JSON.stringify({ legal_first_name: 'Wanjiru', legal_last_name: 'Kamau', date_of_birth: '1994-05-17', nationality: 'KE', country_of_residence: 'KE', phone: '+254712345678' })]);
    await db.exec('reset role');
    for (const file of MIGRATIONS.slice(1)) await db.exec(fs.readFileSync(file, 'utf8'));
    const scalar = async (sql) => (await db.query(sql)).rows[0].result;
    assert.equal(await scalar("select to_regclass('public.customer_verification') is null as result"), true);
    assert.equal(await scalar("select count(*)::int as result from pg_proc where proname in ('get_my_verification', 'save_my_verification_step', 'complete_my_verification', 'staff_get_customer_verification', 'verification_view', 'verification_text', 'verification_choice', 'verification_bool')"), 0);
    assert.equal(await scalar("select count(*)::int as result from information_schema.columns where table_schema = 'public' and column_name in ('date_of_birth', 'legal_last_name', 'tax_id', 'is_pep', 'address_line1')"), 0, 'no identity column remains anywhere in public');
});
