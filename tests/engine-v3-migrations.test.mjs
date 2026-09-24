// Forward-only v3 migrations on a database that already holds v1/v2 history
// (production fix brief §1): history is byte-identical afterwards, v2
// generation and settlement keep working, and older proofs stay readable.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { V3_MIGRATIONS, asUser, createRealDatabase } from './helpers/pg-real.mjs';

test('v3 migrations apply onto v1/v2 history without changing it, and v2 keeps running', async () => {
    const { db, close } = await createRealDatabase({ extra: [] });
    try {
        await db.exec(`update public.engine_indices set t0=clock_timestamp()-interval '30 seconds'`);
        await db.query('select public.engine_advance()');
        const account = (await asUser(db, 'customer', () => db.query('select public.enroll_practice_account() id'))).rows[0].id;
        await asUser(db, 'customer', () => db.query(`select public.engine_buy_contract($1,'SPI10','EVEN',null,5,1,'v2-before-v3')`, [account]));
        await new Promise((r) => setTimeout(r, 2500));
        await db.query('select public.engine_advance()');
        const snapshot = async () => (await db.query(`select
            -- Pre-v3 columns only: the migration adds empty v3 columns, which change row::text but no data.
            (select md5(string_agg(concat_ws(',',index_code,execution_mode,tick_no,epoch_id,scheduled_at,generated_at,price,digit,generation_version,
                previous_price,generation_base_price,generation_sigma,generation_kappa,generation_decimals),'|' order by index_code,tick_no)) from public.index_ticks t) ticks,
            (select md5(string_agg(e::text,'|' order by id)) from public.engine_epochs e) epochs,
            (select md5(string_agg(c::text,'|' order by id)) from public.engine_contracts c) contracts,
            (select md5(string_agg(l::text,'|' order by id)) from public.ledger_entries l) ledger,
            (select count(*)::int from public.index_ticks) n`)).rows[0];
        const before = await snapshot();
        assert.ok(before.n > 10, 'v2 history exists');
        const versions = (await db.query('select distinct generation_version from public.index_ticks order by 1')).rows.map((r) => r.generation_version);
        assert.deepEqual(versions, [2]);

        for (const name of V3_MIGRATIONS) {
            await db.exec((await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8')).replace(/^﻿/, ''));
        }
        assert.deepEqual(await snapshot(), before, 'v1/v2 ticks, epochs, contracts and ledger are unchanged');

        // v2 still generates, settles and serves its verification data.
        await new Promise((r) => setTimeout(r, 2500));
        assert.ok((await db.query('select public.engine_advance() n')).rows[0].n > 0);
        assert.equal((await db.query(`select count(*)::int n from public.index_ticks where generation_version<>2`)).rows[0].n, 0);
        const open = (await db.query(`select count(*)::int n from public.engine_contracts where state='OPEN'`)).rows[0].n;
        assert.equal(open, 0, 'the v2 contract settled on v2 ticks');
        const verification = await asUser(db, 'customer', () => db.query(`select * from public.get_tick_verification_data($1,'SPI10',0,5)`, [account]));
        assert.ok(verification.rows.length > 0 && verification.rows.every((r) => Number(r.generation_version) === 2));
        // With no v3 index, the v2 purchase path is unaffected by the v3 gate.
        await asUser(db, 'customer', () => db.query(`select public.engine_buy_contract($1,'SPI10','EVEN',null,5,1,'v2-after-v3')`, [account]));
    } finally { await close(); }
});
