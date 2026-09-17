// Synthetic identities only. This module never reads environment files or remote credentials.
import fs from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

export const identities = Object.fromEntries(['owner', 'owner2', 'administrator', 'agent', 'agent2', 'customer', 'customer2'].map((name, i) =>
    [name, { id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, email: `${name}@sandbox.example.test` }]));

export const authSchema = `
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users(id uuid primary key, email text, email_confirmed_at timestamptz);
    create function auth.jwt() returns jsonb language sql stable as
      $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
    create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
    grant usage on schema auth to authenticated, anon;
    grant execute on all functions in schema auth to authenticated, anon;
`;
export function claimsFor(name, aal = 'aal2') {
    return { sub: identities[name]?.id, aal, amr: aal === 'aal2' ? [{ method: 'totp', timestamp: Math.floor(Date.now() / 1000) }] : [] };
}

export async function seedAccess(db) {
    await db.exec(authSchema);
    for (const user of Object.values(identities)) await db.query('insert into auth.users values($1,$2,now())', [user.id, user.email]);
    await db.exec(await fs.readFile(new URL('../supabase/migrations/20260917100000_staff_access_foundation.sql', import.meta.url), 'utf8'));
    await db.query('select admin_private.bootstrap_owner($1,$2,$3)', [identities.owner.id, identities.owner.email, 'Synthetic sandbox bootstrap']);
    await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify(claimsFor('owner'))]);
    await db.exec('set role authenticated');
    for (const name of ['owner2', 'administrator', 'agent', 'agent2']) {
        await db.query('select public.change_staff_role($1,$2,true,0,$3,gen_random_uuid())',
            [identities[name].id, name.startsWith('owner') ? 'owner' : name === 'administrator' ? name : 'support_agent', 'Synthetic sandbox access']);
    }
    await db.exec('reset role');
}

export async function createSandboxDatabase() {
    const db = new PGlite();
    try {
        await seedAccess(db);
        for (const name of ['20260916120000_support_requests.sql', '20260916130000_friendly_ticket_references.sql', '20260917110000_support_workflow.sql']) {
            await db.exec((await fs.readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8')).replace(/^\uFEFF/, ''));
        }
        return db;
    } catch (error) { await db.close(); throw error; }
}
