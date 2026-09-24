import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { claimsFor, createTestDatabase, identities } from './helpers/test-db.mjs';

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

/* Operations console against the full migrated schema: each role reaches exactly
   the RPCs its capabilities allow, and every state change leaves an audit row. */
async function opsDatabase() {
    const db = await createTestDatabase();
    const as = async (name, claims = claimsFor(name)) => {
        await db.exec('reset role');
        await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify(claims)]);
        await db.exec('set role authenticated');
    };
    const outcome = async (sql, args = []) => {
        try { await db.query(sql, args); return 'ok'; } catch (error) { return error.message; }
    };
    return { db, as, outcome };
}

const staleOwner = () => ({ ...claimsFor('owner'), amr: [{ method: 'totp', timestamp: Math.floor(Date.now() / 1000) - 3600 }] });
const policy = { house_margin: 0.035, min_ticks: 1, max_ticks: 10, max_settlement_delay_seconds: 30, max_feed_lag_seconds: 10, min_profit_ratio: 0.01, tick_retention_days: 30, enabled_contract_types: ['EVEN', 'ODD'], limits: { DEMO: { min_stake: 1, max_stake: 1000, max_open_contracts: 20, max_buys_per_minute: 30, max_liability_per_tick: 100000 } } };

test('operations RPCs follow the capability matrix for every staff role', async () => {
    const { db, as, outcome } = await opsDatabase();
    try {
        const reads = {
            'select public.get_platform_overview()': ['forbidden', 'ok', 'ok'],
            'select public.list_admin_customers()': ['forbidden', 'ok', 'ok'],
            [`select public.get_admin_customer_detail('${identities.customer.id}')`]: ['forbidden', 'ok', 'ok'],
            "select * from public.list_admin_contracts(p_mode=>'DEMO',p_index=>'SPI10')": ['forbidden', 'ok', 'ok'],
            'select public.get_admin_engine_health()': ['forbidden', 'ok', 'ok'],
            'select public.list_admin_engine_indices()': ['forbidden', 'ok', 'ok'],
            'select public.list_admin_engine_epochs()': ['forbidden', 'ok', 'ok'],
            'select public.list_admin_engine_policies()': ['forbidden', 'ok', 'ok'],
            'select public.list_admin_stuck_contracts()': ['forbidden', 'ok', 'ok'],
            'select public.get_admin_engine_exposure()': ['forbidden', 'ok', 'ok'],
            'select * from public.list_admin_audit()': ['forbidden', 'forbidden', 'ok'],
        };
        for (const [position, role] of ['agent', 'administrator', 'owner'].entries()) {
            await as(role);
            for (const [sql, expected] of Object.entries(reads)) assert.equal(await outcome(sql), expected[position], `${role}: ${sql}`);
        }
        await as('agent');
        assert.equal(await outcome("select public.set_index_trading_status('SPI10','DEMO','PAUSED','Agent attempts a pause')"), 'forbidden');
        assert.equal(await outcome('select public.publish_engine_policy($1,$2)', [policy, 'Agent attempts a publish']), 'forbidden');
    } finally {
        await db.exec('reset role');
        await db.close();
    }
});

test('policy publication succeeds with an audit row and reports the failing field', async () => {
    const { db, as } = await opsDatabase();
    try {
        await as('administrator');
        const version = (await db.query('select public.publish_engine_policy($1,$2) version', [policy, 'Quarterly policy review'])).rows[0].version;
        assert.equal(version, 2);
        const history = (await db.query('select public.list_admin_engine_policies() history')).rows[0].history;
        assert.deepEqual(history.map((row) => row.version), [2, 1]);
        assert.equal(Number(history[0].limits.DEMO.max_stake), 1000);
        const invalid = [
            [{ house_margin: 0.5 }, /house_margin must be between/],
            [{ enabled_contract_types: [] }, /at least one contract type/],
            [{ max_ticks: 12 }, /max_ticks must be between/],
            [{ min_profit_ratio: 0.95 }, /EVEN pays 1\.93 on the minimum stake 1, below min_profit_ratio 0\.95/],
            [{ limits: { DEMO: policy.limits.DEMO, REAL: policy.limits.DEMO } }, /Real limits/],
        ];
        for (const [change, detail] of invalid) {
            await assert.rejects(db.query('select public.publish_engine_policy($1,$2)', [{ ...policy, ...change }, 'Invalid policy attempt']), (error) => /validation_failed/.test(error.message) && detail.test(error.detail));
        }
        await db.exec('reset role');
        const audit = await db.query("select actor_id, target_type, after_state->>'version' as version from public.admin_audit_events where action='engine.publish_policy'");
        assert.deepEqual(audit.rows.map((row) => ({ ...row })), [{ actor_id: identities.administrator.id, target_type: 'engine_policy', version: '2' }]);
    } finally {
        await db.exec('reset role');
        await db.close();
    }
});

test('manual void is Owner-only, needs a reason and fresh verification, refunds and is audited', async () => {
    const { db, as, outcome } = await opsDatabase();
    try {
        await as('customer');
        const account = (await db.query('select public.enroll_practice_account() id')).rows[0].id;
        await db.exec('reset role');
        await db.query("update public.index_state set last_tick_no=1,updated_at=now() where index_code='SPI10' and execution_mode='DEMO'");
        await as('customer');
        const contract = (await db.query("select public.engine_buy_contract($1,'SPI10','EVEN',null,10,5,'void-me') result", [account])).rows[0].result.id;
        await db.exec('reset role');
        await db.query("update public.index_state set last_tick_no=100 where index_code='SPI10' and execution_mode='DEMO'");

        await as('administrator');
        assert.equal((await db.query('select public.list_admin_stuck_contracts() stuck')).rows[0].stuck[0].id, contract);
        assert.equal((await db.query('select public.get_admin_contract_detail($1) detail', [contract])).rows[0].detail.customer.email, identities.customer.email);
        assert.equal(await outcome("select public.void_contract($1,'Administrator tries to void')", [contract]), 'forbidden');
        await as('owner');
        assert.equal(await outcome("select public.void_contract($1,'too short')", [contract]), 'validation_failed');
        await as('owner', staleOwner());
        assert.equal(await outcome("select public.void_contract($1,'Settlement stuck behind the tick')", [contract]), 'reauthentication_required');
        await as('owner');
        assert.equal(await outcome("select public.void_contract($1,'Settlement stuck behind the tick')", [contract]), 'ok');
        await db.exec('reset role');
        assert.equal((await db.query('select state from public.engine_contracts where id=$1', [contract])).rows[0].state, 'VOID');
        const audit = await db.query("select actor_id, before_state->>'execution_mode' as mode_before, after_state->>'execution_mode' as mode_after from public.admin_audit_events where action='contracts.void' and target_id=$1", [contract]);
        assert.deepEqual(audit.rows.map((row) => ({ ...row })), [{ actor_id: identities.owner.id, mode_before: 'DEMO', mode_after: 'DEMO' }]);
        await as('customer');
        assert.equal(Number((await db.query('select public.get_account_summary($1) summary', [account])).rows[0].summary.available), 10000);
    } finally {
        await db.exec('reset role');
        await db.close();
    }
});

test('restrictions are applied, superseded and lifted only with the capability their gravity needs', async () => {
    const { db, as, outcome } = await opsDatabase();
    const target = identities.customer.id;
    const apply = (type, scope, severity, params = {}, reason = 'Restriction applied for review') => db.query('select public.apply_account_restriction($1,$2,$3,$4,$5,null,$6) id', [target, type, scope, severity, params, reason]).then((result) => result.rows[0].id);
    const attempt = (type, scope, severity, params = {}) => outcome('select public.apply_account_restriction($1,$2,$3,$4,$5,null,$6)', [target, type, scope, severity, params, 'Attempted restriction']);
    const lift = (id, reason = 'Lifted after review') => outcome('select public.lift_account_restriction($1,$2)', [id, reason]);
    try {
        await as('agent');
        const notice = await apply('TRADING', 'REAL', 'NOTICE');
        const depositNotice = await apply('DEPOSIT', 'DEMO', 'NOTICE');
        assert.equal(await attempt('TRADING', 'DEMO', 'LIMITED', { max_stake: 5 }), 'forbidden');

        await as('administrator');
        const limited = await apply('TRADING', 'DEMO', 'LIMITED', { max_stake: 5 });
        assert.equal(await attempt('TRADING', 'ALL', 'BLOCKED'), 'forbidden');
        assert.equal(await attempt('WITHDRAWAL', 'DEMO', 'BLOCKED'), 'forbidden');

        await as('owner', staleOwner());
        assert.equal(await attempt('ACCESS', 'ALL', 'BLOCKED'), 'reauthentication_required');
        await as('owner');
        const severe = await apply('ACCESS', 'ALL', 'BLOCKED');

        await as('agent');
        assert.equal(await attempt('TRADING', 'DEMO', 'NOTICE'), 'forbidden', 'a notice cannot supersede a limit');
        assert.equal(await lift(limited), 'forbidden');
        assert.equal(await lift(severe), 'forbidden');
        assert.equal(await lift(notice), 'ok');
        assert.equal(await lift(depositNotice), 'ok');

        await as('administrator');
        assert.equal(await lift(severe), 'forbidden');
        assert.equal(await lift(limited, 'x'), 'validation_failed');
        const stricter = await apply('TRADING', 'DEMO', 'BLOCKED', {}, 'Block supersedes the limit');
        await as('owner');
        assert.equal(await lift(severe), 'ok');

        await db.exec('reset role');
        const rows = await db.query('select id, active from public.account_restrictions where user_id=$1', [target]);
        const active = Object.fromEntries(rows.rows.map((row) => [row.id, row.active]));
        assert.deepEqual([active[notice], active[depositNotice], active[limited], active[severe], active[stricter]], [false, false, false, false, true]);
        const audit = await db.query("select action, before_state->>'severity' as lifted from public.admin_audit_events where target_id=$1 and action like 'customer.%'", [target]);
        assert.equal(audit.rows.filter((row) => row.action === 'customer.restrict').length, 5);
        assert.deepEqual(audit.rows.filter((row) => row.action === 'customer.lift_restriction').map((row) => row.lifted).sort(), ['BLOCKED', 'NOTICE', 'NOTICE']);
    } finally {
        await db.exec('reset role');
        await db.close();
    }
});

test('digit quality counts digits that never appear, and the overview reports the worst index status', async () => {
    const { db, as } = await opsDatabase();
    try {
        await db.query('update public.index_state set updated_at=now()');
        await as('administrator');
        assert.equal((await db.query('select public.get_platform_overview() overview')).rows[0].overview.engine_health, 'healthy');
        await db.exec('reset role');
        // 50 ticks using only digits 0-4: chi-square is 50 over all ten digits (alert), but 25 if absent digits are skipped.
        const epoch = await db.query("insert into public.engine_epochs(id,execution_mode,starts_at,ends_at,seed_commitment,chain_hash) values(gen_random_uuid(),'DEMO',date_trunc('day',now()),date_trunc('day',now())+interval '1 day','proof','chain') returning id");
        for (let tick = 1; tick <= 50; tick++) {
            const digit = tick % 5;
            await db.query("insert into public.index_ticks(index_code,execution_mode,tick_no,epoch_id,scheduled_at,generated_at,price,digit) values('SPI10','DEMO',$1,$2,now(),now(),$3,$4)", [tick, epoch.rows[0].id, (1000 + digit / 1000).toFixed(3), digit]);
        }
        await db.query("update public.index_state set last_tick_no=50,updated_at=now() where index_code='SPI10' and execution_mode='DEMO'");
        await as('administrator');
        const spi10 = (await db.query('select public.get_admin_engine_health() health')).rows[0].health.find((row) => row.index_code === 'SPI10' && row.execution_mode === 'DEMO');
        assert.equal(Number(spi10.chi_square), 50);
        assert.equal(spi10.status, 'alert');
        assert.equal((await db.query('select public.get_platform_overview() overview')).rows[0].overview.engine_health, 'alert');
        await db.exec('reset role');
        await db.query("update public.index_state set updated_at=now()-interval '1 minute' where index_code='SPI25' and execution_mode='DEMO'");
        await as('administrator');
        assert.equal((await db.query('select public.get_platform_overview() overview')).rows[0].overview.engine_health, 'degraded');
    } finally {
        await db.exec('reset role');
        await db.close();
    }
});
