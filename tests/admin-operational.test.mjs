import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { identities, claimsFor, authSchema } from '../sandbox/database.mjs';

const customAuthSchema = `
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users(id uuid primary key, email text, email_confirmed_at timestamptz, raw_user_meta_data jsonb default '{}'::jsonb);
    create function auth.jwt() returns jsonb language sql stable as
      $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
    create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
    grant usage on schema auth to authenticated, anon;
    grant execute on all functions in schema auth to authenticated, anon;
`;

async function createOperationalDatabase() {
    const db = new PGlite();
    await db.exec(customAuthSchema);
    await db.exec('create publication supabase_realtime;');
    for (const user of Object.values(identities)) {
        await db.query('insert into auth.users values($1, $2, now(), $3)', [user.id, user.email, JSON.stringify({ display_name: user.email.split('@')[0] })]);
    }

    const migrations = [
        '20260912150000_trading_foundation.sql',
        '20260912170000_provision_account_wallets.sql',
        '20260912200000_demo_execution_engine.sql',
        '20260916120000_support_requests.sql',
        '20260916130000_friendly_ticket_references.sql',
        '20260917100000_staff_access_foundation.sql',
        '20260917110000_support_workflow.sql',
        '20260918120000_customer_and_operational_admin.sql'
    ];

    for (const name of migrations) {
        let sql = (await fs.readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8')).replace(/^\uFEFF/, '');
        sql = sql.replace(/create extension if not exists pgcrypto;/gi, '-- stripped for pglite');
        await db.exec(sql);
    }

    // Bootstrap owner
    await db.query('select admin_private.bootstrap_owner($1, $2, $3)', [identities.owner.id, identities.owner.email, 'Operational test bootstrap']);
    await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify(claimsFor('owner'))]);
    await db.exec('set role authenticated');

    for (const name of ['owner2', 'administrator', 'agent', 'agent2']) {
        await db.query('select public.change_staff_role($1, $2, true, 0, $3, gen_random_uuid())', [
            identities[name].id,
            name.startsWith('owner') ? 'owner' : name === 'administrator' ? name : 'support_agent',
            'Operational test access'
        ]);
    }
    await db.exec('reset role');
    return db;
}

test('Admin Phases 3 & 4: Customer administration, trading restrictions, markets, and operational oversight', async (t) => {
    const db = await createOperationalDatabase();
    const scalar = async (sql, args = []) => (await db.query(sql, args)).rows[0]?.result;

    async function as(name, aal = 'aal2') {
        await db.exec('reset role');
        await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify(claimsFor(name, aal))]);
        await db.exec('set role authenticated');
    }

    try {
        await t.test('Customer directory search is scoped to administrators and owners', async () => {
            await as('agent');
            await assert.rejects(scalar('select public.list_admin_customers() as result'), /forbidden/);

            await as('administrator');
            const list = await scalar('select public.list_admin_customers() as result');
            assert.ok(Array.isArray(list));
            assert.ok(list.length >= 2);

            const filtered = await scalar('select public.list_admin_customers($1) as result', ['customer@']);
            assert.ok(filtered.some(c => c.email.includes('customer@')));

            const detail = await scalar('select public.get_admin_customer_detail($1) as result', [identities.customer.id]);
            assert.equal(detail.email, identities.customer.email);
            assert.equal(detail.email_verified, true);
            assert.ok(Array.isArray(detail.restrictions));
            assert.ok(Array.isArray(detail.demo_balances));
        });

        await t.test('Trading restrictions are enforced at DB level in submit_demo_order', async () => {
            // Seed a snapshot so order pricing can succeed if not restricted
            await db.exec('reset role');
            await db.query(`
                insert into public.market_snapshots(source, symbol, bid_price, ask_price, received_at, sequence_id)
                values ('BINANCE', 'BTCUSDT', 50000, 50010, now(), 'seq-1')
            `);

            await as('administrator');
            const restriction = await scalar(
                'select public.apply_account_restriction($1, $2, $3) as result',
                [identities.customer.id, 'TRADING', 'Suspected abnormal demo activity']
            );
            assert.equal(restriction.active, true);
            assert.equal(restriction.user_id, identities.customer.id);

            // Customer attempts to place a demo order while restricted
            await as('customer');
            await assert.rejects(
                scalar(
                    'select (public.submit_demo_order($1, $2, $3::public.order_side, $4::public.order_type, $5, $6, null, $7)).id as result',
                    ['client-ord-1', 'BTCUSDT', 'BUY', 'LIMIT', 0.01, 50000, randomUUID()]
                ),
                /trading_restricted/
            );

            // Administrator lifts the restriction
            await as('administrator');
            const lifted = await scalar(
                'select public.lift_account_restriction($1, $2) as result',
                [restriction.id, 'Identity and activity verified']
            );
            assert.equal(lifted.active, false);

            // Audit events recorded for both actions
            await db.exec('reset role');
            const auditEvents = (await db.query(
                "select * from public.admin_audit_events where target_id = $1 order by created_at desc",
                [identities.customer.id]
            )).rows;
            assert.ok(auditEvents.some(e => e.action === 'customer.restrict'));
            assert.ok(auditEvents.some(e => e.action === 'customer.lift_restriction'));
        });

        await t.test('Market quote health and symbol trading pause controls', async () => {
            await as('administrator');
            const healthBefore = await scalar('select public.list_admin_market_health() as result');
            assert.ok(Array.isArray(healthBefore));
            const btcHealth = healthBefore.find(h => h.symbol === 'BTCUSDT');
            assert.equal(btcHealth.freshness, 'fresh');
            assert.equal(btcHealth.trading_paused, false);

            // Pause BTCUSDT trading
            await scalar(
                'select public.set_symbol_trading_status($1, $2, $3) as result',
                ['BTCUSDT', true, 'Upstream exchange feed maintenance']
            );

            // Customer cannot place order on paused symbol
            await as('customer');
            await assert.rejects(
                scalar(
                    'select (public.submit_demo_order($1, $2, $3::public.order_side, $4::public.order_type, $5, $6, null, $7)).id as result',
                    ['client-ord-2', 'BTCUSDT', 'BUY', 'LIMIT', 0.01, 50000, randomUUID()]
                ),
                /symbol_trading_paused/
            );

            // Resume BTCUSDT trading
            await as('administrator');
            await scalar('select public.set_symbol_trading_status($1, $2, $3) as result', ['BTCUSDT', false, 'Maintenance complete']);

            const healthAfter = await scalar('select public.list_admin_market_health() as result');
            assert.equal(healthAfter.find(h => h.symbol === 'BTCUSDT').trading_paused, false);
        });

        await t.test('Demo trading oversight allows read-only order and detail inspection', async () => {
            // Customer places an order
            await as('customer');
            const orderId = await scalar(
                'select (public.submit_demo_order($1, $2, $3::public.order_side, $4::public.order_type, $5, $6, null, $7)).id as result',
                ['client-ord-3', 'BTCUSDT', 'BUY', 'LIMIT', 0.01, 50000, randomUUID()]
            );
            assert.ok(orderId);

            // Administrator inspects demo orders
            await as('administrator');
            const orders = await scalar('select public.list_admin_demo_orders() as result');
            assert.ok(Array.isArray(orders));
            assert.ok(orders.some(o => o.id === orderId));

            const detail = await scalar('select public.get_admin_demo_order_detail($1) as result', [orderId]);
            assert.equal(detail.id, orderId);
            assert.equal(detail.symbol, 'BTCUSDT');
            assert.ok(Array.isArray(detail.events));
        });

        await t.test('Staff management is restricted to owners', async () => {
            await as('agent');
            await assert.rejects(scalar('select public.list_staff_members() as result'), /forbidden/);

            await as('administrator');
            await assert.rejects(scalar('select public.list_staff_members() as result'), /forbidden/);

            await as('owner');
            const staff = await scalar('select public.list_staff_members() as result');
            assert.ok(Array.isArray(staff));
            assert.ok(staff.some(s => s.role === 'owner'));
            assert.ok(staff.some(s => s.role === 'administrator'));
            assert.ok(staff.some(s => s.role === 'support_agent'));
        });

        await t.test('Platform overview returns operational health and counts', async () => {
            await as('administrator');
            const overview = await scalar('select public.get_platform_overview() as result');
            assert.ok(overview.total_customers >= 2);
            assert.ok(overview.active_staff >= 4);
            assert.ok(overview.market_health === 'healthy' || overview.market_health === 'degraded');
        });
    } finally {
        await db.close();
    }
});
