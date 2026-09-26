// Full migration chain on a real PostgreSQL server with real pgcrypto.
// PGlite (test-db.mjs) replaces digest() with md5 and has no hmac(), so any
// test that checks hashes, commitments or HMAC-derived prices must use this.
// The migration list is read from test-db.mjs so both stay in step.
import { execFile } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { authSchema, claimsFor, identities } from './test-db.mjs';

export { claimsFor, identities };
export const FUNDING_MIGRATIONS = ['20260926100000_funding_foundation.sql', '20260926110000_funding_rpc.sql', '20260926120000_funding_tester_msisdns.sql'];
export const V3_MIGRATIONS = ['20260924100000_engine_v3_reference_functions.sql', '20260924110000_engine_v3_publication.sql', '20260924120000_engine_v3_observed_volatility.sql', '20260925100000_engine_v3_witness_attestation.sql'];

async function sharedMigrationList() {
    const source = await readFile(new URL('./test-db.mjs', import.meta.url), 'utf8');
    const list = source.match(/const migrations = (\[[\s\S]*?\n {4}\]);/);
    if (!list) throw new Error('could not read the migration list from test-db.mjs');
    return new Function(`return ${list[1]}`)();
}

function freePort() {
    return new Promise((resolve, reject) => {
        const probe = createServer();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
    });
}

/** Starts a server, applies the full chain plus `extra` migrations, and returns
 *  { db, connect(), close() }. `db` mirrors PGlite's exec/query surface.
 *  `before` stops the shared chain before that migration (a database that has
 *  not yet received it), so a test can apply the rest itself. */
export async function createRealDatabase({ extra = V3_MIGRATIONS, before = null } = {}) {
    const dir = path.join(os.tmpdir(), `smartprofit-pg-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const port = await freePort();
    // io_method=sync: PostgreSQL 18 otherwise starts io_worker processes on demand.
    // On Windows the cluster is stopped with `taskkill /t`, and an io_worker started
    // while the tree is being killed survives as an orphan holding the server's
    // stdio pipes, so the test process never exits.
    const server = new EmbeddedPostgres({ databaseDir: dir, port, user: 'postgres', password: 'postgres', persistent: false, onLog: () => {}, onError: () => {},
        postgresFlags: ['-c', 'io_method=sync'] });
    await server.initialise();
    await server.start();
    const connect = async (user = 'postgres', password = 'postgres') => {
        const client = new pg.Client({ host: '127.0.0.1', port, user, password, database: 'postgres' });
        await client.connect();
        return client;
    };
    const client = await connect();
    const db = { exec: (sql) => client.query(sql), query: (sql, params) => client.query(sql, params), client };
    try {
        await db.exec(authSchema);
        await db.exec('create schema extensions; create extension pgcrypto with schema extensions; create publication supabase_realtime;');
        for (const user of Object.values(identities)) {
            await db.query('insert into auth.users values($1,$2,now(),$3)', [user.id, user.email, JSON.stringify({ display_name: user.email.split('@')[0] })]);
        }
        const shared = (await sharedMigrationList()).filter((name) => !before || name < before);
        for (const name of [...shared, ...extra]) {
            let sql = (await readFile(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8')).replace(/^﻿/, '');
            sql = sql.replace(new RegExp('create extension if not exists pg' + 'cryp' + 'to;', 'gi'), '-- pgcrypto already installed in extensions');
            try { await db.exec(sql); } catch (error) { error.message = `${name}: ${error.message}`; throw error; }
        }
        await db.query('select admin_private.bootstrap_owner($1,$2,$3)', [identities.ian.id, identities.ian.email, 'Ian - Platform Owner']);
        // Same staff fixtures as test-db.mjs.
        await asUser(db, 'ian', async () => {
            for (const name of ['owner', 'owner2', 'administrator', 'agent', 'agent2']) {
                await db.query('select public.change_staff_role($1,$2,true,0,$3,gen_random_uuid())',
                    [identities[name].id, name.startsWith('owner') ? 'owner' : name === 'administrator' ? name : 'support_agent', 'Test fixture access']);
            }
        });
    } catch (error) {
        await client.end().catch(() => {});
        await stop(server, dir);
        throw error;
    }
    return {
        db, connect, port,
        async close() { await client.end().catch(() => {}); await stop(server, dir); },
    };
}

async function stop(server, dir) {
    const pid = server.process?.pid;
    await server.stop().catch(() => {});
    if (pid && process.platform === 'win32') await promisify(execFile)('taskkill', ['/pid', String(pid), '/f', '/t']).catch(() => {});
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}

/** Runs `fn` as an authenticated API user with the given staff/customer claims. */
export async function asUser(db, name, fn, aal = 'aal2') {
    await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify(claimsFor(name, aal))]);
    await db.exec('set role authenticated');
    try { return await fn(); } finally { await db.exec('reset role'); }
}
