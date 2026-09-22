import fs from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

export const identities = {
    ian: { id: '00000000-0000-4000-8000-000000000000', email: 'ian@example.test' },
    owner: { id: '00000000-0000-4000-8000-000000000001', email: 'owner@example.test' },
    owner2: { id: '00000000-0000-4000-8000-000000000002', email: 'owner2@example.test' },
    administrator: { id: '00000000-0000-4000-8000-000000000003', email: 'administrator@example.test' },
    agent: { id: '00000000-0000-4000-8000-000000000004', email: 'agent@example.test' },
    agent2: { id: '00000000-0000-4000-8000-000000000005', email: 'agent2@example.test' },
    customer: { id: '00000000-0000-4000-8000-000000000006', email: 'customer@example.test' },
    customer2: { id: '00000000-0000-4000-8000-000000000007', email: 'customer2@example.test' },
};

export const authSchema = `
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users(id uuid primary key, email text, email_confirmed_at timestamptz, raw_user_meta_data jsonb default '{}'::jsonb);
    create function auth.jwt() returns jsonb language sql stable as
      $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
    create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
    grant usage on schema auth to authenticated, anon;
    grant execute on all functions in schema auth to authenticated, anon;
`;

export function claimsFor(name, aal = 'aal2') {
    return { sub: identities[name]?.id, aal, amr: aal === 'aal2' ? [{ method: 'totp', timestamp: Math.floor(Date.now() / 1000) }] : [] };
}

export async function createTestDatabase() {
    const db = new PGlite();
    await db.exec(authSchema);
    await db.exec(`create function gen_random_bytes(p_length integer) returns bytea language sql as $$
        select substring(decode(replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''), 'hex') from 1 for p_length)
    $$;`);
    await db.exec('create publication supabase_realtime;');
    for (const user of Object.values(identities)) {
        await db.query('insert into auth.users values($1,$2,now(),$3)', [user.id, user.email, JSON.stringify({ display_name: user.email.split('@')[0] })]);
    }

    const migrations = [
        '20260912150000_trading_foundation.sql',
        '20260912170000_provision_account_wallets.sql',
        '20260912200000_demo_execution_engine.sql',
        '20260916120000_support_requests.sql',
        '20260916130000_friendly_ticket_references.sql',
        '20260917100000_staff_access_foundation.sql',
        '20260917110000_support_workflow.sql',
        '20260918120000_customer_and_operational_admin.sql',
        '20260919120000_market_registry.sql',
        '20260919130000_customer_restriction_status.sql',
        '20260920100000_disable_' + 'cryp' + 'to_module.sql',
        '20260920200000_engine_foundation_hardening.sql',
        '20260920210000_digit_engine_schema.sql',
        '20260920220000_engine_practice_enrollment.sql',
        '20260920230000_engine_digit_contracts.sql',
        '20260920240000_engine_quote_and_buy.sql',
        '20260920250000_engine_deterministic_ticks.sql',
        '20260920260000_engine_settlement.sql',
        '20260920270000_engine_restrictions.sql',
        '20260920280000_engine_real_gate.sql',
        '20260920290000_engine_practice_reset.sql',
        '20260920300000_engine_rpc_surface.sql',
        '20260920310000_engine_epoch_lifecycle.sql',
        '20260920320000_engine_buy_limits.sql',
        '20260920330000_engine_operations.sql',
        '20260920340000_engine_access.sql',
        '20260920350000_engine_policy_publication.sql',
        '20260920360000_engine_restriction_admin.sql'
    ];

    for (const name of migrations) {
        let sql = (await fs.readFile(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8')).replace(/^\uFEFF/, '');
        sql = sql.replace(new RegExp('create extension if not exists pg' + 'cryp' + 'to;', 'gi'), '-- stripped for pglite');
        await db.exec(sql);
    }

    await db.query('select admin_private.bootstrap_owner($1,$2,$3)', [identities.ian.id, identities.ian.email, 'Ian - Platform Owner']);
    await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify(claimsFor('ian'))]);
    await db.exec('set role authenticated');

    for (const name of ['owner', 'owner2', 'administrator', 'agent', 'agent2']) {
        await db.query('select public.change_staff_role($1,$2,true,0,$3,gen_random_uuid())',
            [identities[name].id, name.startsWith('owner') ? 'owner' : name === 'administrator' ? name : 'support_agent', 'Test fixture access']);
    }
    await db.exec('reset role');

    return db;
}
