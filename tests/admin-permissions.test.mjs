import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const ids = Array.from({ length: 6 }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);
const [owner, owner2, administrator, agent, customer, unverified] = ids;
const migration = fs.readFileSync('supabase/migrations/20260917100000_staff_access_foundation.sql', 'utf8');
let request = 0;
const requestId = () => `10000000-0000-4000-8000-${String(++request).padStart(12, '0')}`;

test('staff permission foundation against an isolated PostgreSQL engine', async (t) => {
    const db = new PGlite();
    try {
        await db.exec(`
            create role anon; create role authenticated; create role service_role;
            create schema auth;
            create table auth.users(id uuid primary key, email text, email_confirmed_at timestamptz);
            create function auth.jwt() returns jsonb language sql stable as
                $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
            create function auth.uid() returns uuid language sql stable as
                $$ select (auth.jwt()->>'sub')::uuid $$;
            grant usage on schema auth to authenticated, anon;
            grant execute on all functions in schema auth to authenticated, anon;
        `);
        for (const [i, id] of ids.entries()) {
            await db.query('insert into auth.users values ($1, $2, $3)', [id, `user${i}@example.test`, id === unverified ? null : new Date()]);
        }
        await db.exec(migration);
        async function as(user, options = {}) {
            await db.exec('reset role');
            const claims = { sub: user, aal: options.aal ?? 'aal2', amr: options.amr ?? [
                { method: 'totp', timestamp: Math.floor(Date.now() / 1000) - (options.age ?? 0) }
            ], user_metadata: { role: 'owner' } };
            await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify(claims)]);
            await db.exec(`set role ${options.anonymous ? 'anon' : 'authenticated'}`);
        }
        const scalar = async (sql, args = []) => (await db.query(sql, args)).rows[0]?.result;
        const context = () => scalar('select public.get_staff_context() as result');
        const change = (user, role, active = true, version = 0, key = requestId(), reason = 'Approved access change') =>
            scalar('select public.change_staff_role($1,$2,$3,$4,$5,$6) as result', [user, role, active, version, reason, key]);

        await t.test('bootstrap is private, validates identity and is one-time', async () => {
            await as(customer);
            await assert.rejects(db.query('select admin_private.bootstrap_owner($1,$2,$3)', [customer, 'user4@example.test', 'Initial owner']), /permission denied/);
            await db.exec('reset role');
            await assert.rejects(db.query('select admin_private.bootstrap_owner($1,$2,$3)', [unverified, 'user5@example.test', 'Initial owner']), /verified_identity_required/);
            await assert.rejects(db.query('select admin_private.bootstrap_owner($1,$2,$3)', [owner, 'wrong@example.test', 'Initial owner']), /verified_identity_required/);
            await db.query('select admin_private.bootstrap_owner($1,$2,$3)', [owner, 'user0@example.test', 'Initial owner verified by operator']);
            await assert.rejects(db.query('select admin_private.bootstrap_owner($1,$2,$3)', [owner2, 'user1@example.test', 'Second bootstrap']), /bootstrap_already_completed/);
            assert.equal(await scalar("select count(*)::int as result from public.admin_audit_events where action='staff.bootstrap'"), 1);
        });

        await t.test('anonymous and customers cannot enter or supply a role', async () => {
            await as(null, { anonymous: true });
            await assert.rejects(context(), /permission denied/);
            await as(null);
            await assert.rejects(context(), /unauthenticated/);
            await as(customer);
            await assert.rejects(context(), /forbidden/);
            await assert.rejects(change(customer, 'owner'), /forbidden/);
        });

        await t.test('owners grant only verified users, roles match explicit capabilities', async () => {
            await as(owner);
            await assert.rejects(change(unverified, 'owner'), /verified_identity_required/);
            await assert.rejects(change(customer, 'security_operator'), /validation_failed/);
            await change(owner2, 'owner');
            await change(administrator, 'administrator');
            await change(agent, 'support_agent');
            for (const [user, role] of [[owner, 'owner'], [administrator, 'administrator'], [agent, 'support_agent']]) {
                await as(user);
                const ctx = await context();
                assert.equal(ctx.role, role);
                assert.equal(ctx.user_id, user);
                assert.equal(ctx.required_step, null);
                assert.equal(ctx.capabilities.includes('staff.manage'), role === 'owner');
                assert.equal(ctx.capabilities.includes('support.assign'), role !== 'support_agent');
                assert.equal(ctx.capabilities.includes('customers.read'), false);
            }
        });

        await t.test('MFA gates data, freshness uses TOTP time rather than token refresh', async () => {
            await as(owner, { aal: 'aal1' });
            assert.deepEqual((await context()).capabilities, []);
            assert.equal((await context()).required_step, 'mfa');
            await assert.rejects(change(customer, 'support_agent'), /mfa_required/);
            await assert.rejects(db.query('select * from public.list_admin_audit()'), /mfa_required/);
            for (const options of [{ age: 601 }, { age: -60 }, { amr: [] }, { amr: [{ method: 'token_refresh', timestamp: Math.floor(Date.now() / 1000) }] }]) {
                await as(owner, options);
                await assert.rejects(change(customer, 'support_agent'), /reauthentication_required/);
            }
        });

        await t.test('agents and administrators cannot manage access or query full audits', async () => {
            for (const user of [agent, administrator]) {
                await as(user);
                await assert.rejects(change(customer, 'owner'), /forbidden/);
                await assert.rejects(db.query('select * from public.list_admin_audit()'), /forbidden/);
            }
        });

        await t.test('direct role and audit writes are denied even to owners and service role', async () => {
            await as(owner);
            for (const role of ['authenticated', 'service_role']) {
                await db.exec(`reset role; set role ${role}`);
                for (const table of ['staff_roles', 'admin_audit_events']) {
                    await assert.rejects(db.query(`select * from public.${table}`), /permission denied/);
                    await assert.rejects(db.query(`insert into public.${table} default values`), /permission denied/);
                    await assert.rejects(db.query(`delete from public.${table}`), /permission denied/);
                    await assert.rejects(db.query(`truncate public.${table}`), /permission denied/);
                }
                await assert.rejects(db.query("update public.staff_roles set role = 'owner'"), /permission denied/);
                await assert.rejects(db.query("insert into public.staff_roles(user_id,role) values ($1,'owner')", [customer]), /permission denied/);
                await assert.rejects(db.query("update public.admin_audit_events set reason = 'tampered'"), /permission denied/);
            }
        });

        await t.test('idempotent retry, mismatched retry and stale version have distinct outcomes', async () => {
            await as(owner);
            const key = requestId();
            const result = await change(agent, 'support_agent', true, 1, key);
            assert.deepEqual(await change(agent, 'support_agent', true, 1, key), result);
            await assert.rejects(change(agent, 'owner', true, 1, key), /conflict/);
            await assert.rejects(change(agent, 'administrator', true, 1), /conflict/);
            await db.exec('reset role');
            assert.equal(await scalar('select count(*)::int as result from public.admin_audit_events where correlation_id=$1', [key]), 1);
        });

        await t.test('revocation is immediate for an unchanged JWT and persisted history remains', async () => {
            await as(owner);
            await change(agent, 'support_agent', false, 2);
            await as(agent);
            await assert.rejects(context(), /forbidden/);
            await as(owner);
            const events = (await db.query('select * from public.list_admin_audit()')).rows;
            assert.ok(events.some(e => e.target_id === agent && e.after_state.active === false));
            assert.ok(events.every(e => !JSON.stringify(e).includes('@example.test')));
        });

        await t.test('audit failure rolls back the corresponding role mutation', async () => {
            await db.exec(`reset role;
                create function admin_private.fail_test_audit() returns trigger language plpgsql as $$ begin raise exception 'test_audit_failure'; end $$;
                create trigger test_fail_audit before insert on public.admin_audit_events for each row execute function admin_private.fail_test_audit();`);
            await as(owner);
            await assert.rejects(change(customer, 'support_agent'), /test_audit_failure/);
            await db.exec('reset role; drop trigger test_fail_audit on public.admin_audit_events');
            assert.equal(await scalar('select count(*)::int as result from public.staff_roles where user_id=$1', [customer]), 0);
        });

        await t.test('competing owner removal is reauthorized and no owner can remove themselves', async () => {
            await as(owner);
            await assert.rejects(change(owner, 'administrator', true, 1), /self_role_change_forbidden/);
            await change(owner2, 'administrator', true, 1);
            await as(owner2);
            await assert.rejects(change(owner, 'administrator', true, 1), /forbidden/);
            await db.exec('reset role');
            assert.equal(await scalar("select count(*)::int as result from public.staff_roles where active and role='owner'"), 1);
            await assert.rejects(db.query('delete from auth.users where id=$1', [owner]), /foreign key constraint/);
            await assert.rejects(db.query("update public.admin_audit_events set reason='tampered'"), /audit_immutable/);
        });

        await t.test('role-change limits are enforced by the server and exact retries remain safe', async () => {
            await db.exec('reset role');
            const existing = await scalar("select count(*)::int as result from public.admin_audit_events where actor_id=$1 and action='staff.role_change'", [owner]);
            let version = await scalar('select version::int as result from public.staff_roles where user_id=$1', [administrator]);
            await as(owner);
            let lastKey, lastResult;
            for (let i = existing; i < 30; i++) {
                lastKey = requestId();
                lastResult = await change(administrator, 'administrator', true, version++, lastKey);
            }
            await assert.rejects(change(administrator, 'administrator', true, version), /rate_limited/);
            assert.deepEqual(await change(administrator, 'administrator', true, version - 1, lastKey), lastResult);
        });

        await t.test('audit queries are bounded and their paired cursor never duplicates tied timestamps', async () => {
            await db.exec(`reset role;
                insert into public.admin_audit_events(actor_type,action,target_type,target_id,correlation_id,reason)
                select 'operator','test.fixture','staff','${owner}'::uuid,gen_random_uuid(),'Pagination test fixture'
                from generate_series(1, 55);`);
            await as(owner);
            const first = (await db.query('select * from public.list_admin_audit()')).rows;
            assert.equal(first.length, 50);
            const last = first.at(-1);
            const second = (await db.query('select * from public.list_admin_audit($1,$2)', [last.created_at, last.id])).rows;
            assert.ok(second.length > 0);
            const seen = new Set(first.map(e => e.id));
            assert.ok(second.every(e => !seen.has(e.id)));
            await assert.rejects(db.query('select * from public.list_admin_audit($1,null)', [last.created_at]), /validation_failed/);
        });
    } finally {
        await db.close();
    }
});
