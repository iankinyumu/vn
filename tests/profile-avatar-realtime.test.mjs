import assert from 'node:assert/strict';
import test from 'node:test';
import { createRealDatabase, identities } from './helpers/pg-real.mjs';

test('a saved character is copied to profiles.avatar and profiles is published to realtime', async () => {
    const database = await createRealDatabase();
    const { db } = database;
    const { id } = identities.agent;
    const avatar = async () => (await db.query('select avatar from public.profiles where id=$1', [id])).rows[0].avatar;
    try {
        await db.query(`update auth.users set raw_user_meta_data = raw_user_meta_data || '{"avatar":"violet-bow"}' where id=$1`, [id]);
        assert.equal(await avatar(), 'violet-bow');
        await db.query(`update auth.users set raw_user_meta_data = raw_user_meta_data || '{"avatar":"rose-pearls"}' where id=$1`, [id]);
        assert.equal(await avatar(), 'rose-pearls', 'a later pick replaces it');
        await db.query(`update auth.users set raw_user_meta_data = raw_user_meta_data || '{"avatar":"<script>"}' where id=$1`, [id]);
        assert.equal(await avatar(), null, 'a malformed value is not copied');
        const published = await db.query("select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='profiles'");
        assert.equal(published.rowCount, 1);
    } finally { await database.close(); }
});
