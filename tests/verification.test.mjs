import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createTestDatabase, identities, claimsFor } from './helpers/test-db.mjs';

const MIGRATIONS = ['supabase/migrations/20261003120000_customer_onboarding.sql', 'supabase/migrations/20261003130000_split_onboarding_and_verification.sql'];

const STEPS = {
    1: { legal_first_name: 'Wanjiru', legal_last_name: 'Kamau', date_of_birth: '1994-05-17', nationality: 'KE', country_of_residence: 'KE', phone: '+254 712 345 678' },
    2: { address_line1: 'Kenyatta Avenue 12', address_line2: '', city: 'Nairobi', region: 'Nairobi', postal_code: '00100' },
    3: { employment_status: 'employed', occupation: 'ict', annual_income: '1m_3m', savings: '100k_500k', source_of_funds: ['salary', 'savings'], tax_id: 'a123456789z', is_pep: false },
    4: { experience_binary: 'none', experience_forex: 'under_1y', experience_shares: 'none', finance_background: false },
    5: { q1: 'lose_stake', q2: 'same_chance', q3: 'expected_loss', q4: 'more_than_stake' },
    6: { goal: 'learn', weekly_time: '1_5h', ack_lose_stake: true, ack_practice: true, ack_afford: true },
};

test('verification: customers save their own profile step by step, the server validates and scores it, staff views are audited', async (t) => {
    const db = await createTestDatabase();
    for (const file of MIGRATIONS) await db.exec(fs.readFileSync(file, 'utf8'));
    const scalar = async (sql, args = []) => (await db.query(sql, args)).rows[0]?.result;
    async function as(name, aal = 'aal2') {
        await db.exec('reset role');
        await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify(claimsFor(name, aal))]);
        await db.exec('set role authenticated');
    }
    const save = (step, data) => scalar('select public.save_my_verification_step($1,$2) as result', [step, JSON.stringify(data)]);
    const mine = () => scalar('select public.get_my_verification() as result');

    await t.test('a new customer starts at step 1 with their sign-up name pre-filled', async () => {
        await db.exec('reset role');
        await db.query(`update auth.users set raw_user_meta_data = '{"display_name":"Wanjiru Kamau"}' where id = $1`, [identities.customer.id]);
        await as('customer');
        const view = await mine();
        assert.equal(view.status, 'not_started');
        assert.equal(view.current_step, 1);
        assert.equal(view.data.legal_first_name, 'Wanjiru');
        assert.equal(view.data.legal_last_name, 'Kamau');
    });

    await t.test('clients cannot write the table directly or skip ahead', async () => {
        await as('customer');
        await assert.rejects(db.query('insert into public.customer_verification(user_id) values($1)', [identities.customer.id]), /permission denied/);
        await assert.rejects(save(3, STEPS[3]), /step_locked/);
        await assert.rejects(scalar('select public.complete_my_verification() as result'), /verification_incomplete/);
    });

    await t.test('fields are validated with named errors, and under-18s are refused', async () => {
        await as('customer');
        await assert.rejects(save(1, { ...STEPS[1], date_of_birth: new Date(Date.now() - 17 * 365.25 * 864e5).toISOString().slice(0, 10) }), /underage/);
        await assert.rejects(save(1, { ...STEPS[1], phone: '0712345678' }), /invalid_phone/);
        await assert.rejects(save(1, { ...STEPS[1], legal_first_name: '<script>' }), /invalid_legal_first_name/);
        await assert.rejects(save(1, { ...STEPS[1], legal_last_name: 'Kamau\u0007' }), /invalid_legal_last_name/);
        await assert.rejects(save(1, { ...STEPS[1], nationality: 'Kenya' }), /invalid_nationality/);
    });

    await t.test('each step saves, unlocks the next, and normalises input', async () => {
        await as('customer');
        let view = await save(1, STEPS[1]);
        assert.equal(view.current_step, 2);
        assert.equal(view.data.phone, '+254712345678');
        await assert.rejects(save(2, { ...STEPS[2], address_line1: '' }), /invalid_address_line1/);
        view = await save(2, STEPS[2]);
        assert.equal(view.data.address_line2, undefined, 'an empty optional field is stored as nothing');
        await assert.rejects(save(3, { ...STEPS[3], source_of_funds: ['lottery'] }), /invalid_source_of_funds/);
        await assert.rejects(save(3, { ...STEPS[3], tax_id: '12345' }), /invalid_tax_id/, 'a Kenyan resident gives a KRA PIN or nothing');
        await assert.rejects(save(3, { ...STEPS[3], is_pep: 'no' }), /invalid_is_pep/);
        view = await save(3, STEPS[3]);
        assert.equal(view.data.tax_id, 'A123456789Z');
        assert.deepEqual(view.data.source_of_funds, ['salary', 'savings']);
        await save(4, STEPS[4]);
    });

    await t.test('the knowledge check is scored on the server', async () => {
        await as('customer');
        let view = await save(5, { q1: 'win_stake', q2: 'more_likely', q3: 'expected_loss', q4: 'the_stake' });
        assert.equal(view.knowledge_score, 2);
        assert.equal(view.appropriateness, 'not_yet');
        view = await save(5, STEPS[5]);
        assert.equal(view.knowledge_score, 3);
        assert.equal(view.appropriateness, 'appropriate');
    });

    await t.test('the last step needs every acknowledgement, then onboarding completes and locks', async () => {
        await as('customer');
        await assert.rejects(save(6, { ...STEPS[6], ack_afford: false }), /invalid_acknowledgements/);
        await save(6, STEPS[6]);
        const done = await scalar('select public.complete_my_verification() as result');
        assert.equal(done.status, 'completed');
        assert.ok(done.completed_at);
        await assert.rejects(save(1, STEPS[1]), /verification_completed/);
        assert.equal((await scalar('select public.complete_my_verification() as result')).status, 'completed', 'completing twice is harmless');
    });

    await t.test('customers only see their own profile', async () => {
        await as('customer2');
        assert.equal(await scalar('select count(*)::int as result from public.customer_verification'), 0);
        assert.equal((await mine()).status, 'not_started');
    });

    await t.test('staff with customers.read can view a profile, each view is audited; agents cannot', async () => {
        await as('agent');
        await assert.rejects(scalar('select public.staff_get_customer_verification($1) as result', [identities.customer.id]), /forbidden/);
        await as('administrator');
        const view = await scalar('select public.staff_get_customer_verification($1) as result', [identities.customer.id]);
        assert.equal(view.data.legal_last_name, 'Kamau');
        await db.exec('reset role');
        const audits = await scalar("select count(*)::int as result from public.admin_audit_events where action = 'customer.view_verification' and target_id = $1", [identities.customer.id]);
        assert.equal(audits, 1);
        await as('administrator', 'aal1');
        await assert.rejects(scalar('select public.staff_get_customer_verification($1) as result', [identities.customer.id]), /mfa_required/);
    });

    await t.test('anonymous callers have no access', async () => {
        await db.exec('reset role');
        await db.exec('set role anon');
        await assert.rejects(db.query('select public.get_my_verification()'), /permission denied/);
        await assert.rejects(db.query('select * from public.customer_verification'), /permission denied/);
        await db.exec('reset role');
    });
});
