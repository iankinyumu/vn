import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { createTestDatabase } from './helpers/test-db.mjs';

test('engine contract changes are published to Realtime idempotently and without a row filter', async () => {
    const db = await createTestDatabase();
    try {
        const published = await db.query("select count(*)::integer count from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='engine_contracts'");
        assert.equal(published.rows[0].count, 1);
        await db.exec(await fs.readFile(new URL('../supabase/migrations/20260920520000_engine_contract_realtime.sql', import.meta.url), 'utf8'));
        const again = await db.query("select count(*)::integer count, bool_and(rowfilter is null) unfiltered from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='engine_contracts'");
        assert.deepEqual({ ...again.rows[0] }, { count: 1, unfiltered: true });
        const rls = await db.query("select relrowsecurity from pg_class where oid='public.engine_contracts'::regclass");
        assert.equal(rls.rows[0].relrowsecurity, true);
    } finally {
        await db.close();
    }
});
