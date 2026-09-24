// Real-PostgreSQL run of the check that tests/engine-core.test.mjs skips under
// PGlite ("engine advances deterministic ticks with the price-digit invariant"),
// because PGlite has no pgcrypto HMAC. Same setup and assertions, real pgcrypto.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRealDatabase } from './helpers/pg-real.mjs';

export const REPLACES_SKIP = 'engine advances deterministic ticks with the price-digit invariant';

test(`${REPLACES_SKIP} (real PostgreSQL)`, async () => {
    const { db, close } = await createRealDatabase({ extra: [] });
    try {
        assert.notEqual((await db.query("select to_regprocedure('public.hmac(bytea,bytea,text)') available")).rows[0].available, null, 'pgcrypto HMAC is available');
        await db.exec("update public.engine_indices set t0=now()-interval '4 seconds'");
        await db.query('select public.engine_advance()');
        const ticks = await db.query('select price,digit,decimals from public.index_ticks join public.engine_indices on code=index_code and engine_indices.execution_mode=index_ticks.execution_mode');
        assert.ok(ticks.rows.length > 0);
        for (const tick of ticks.rows) {
            const unit = 10 ** -Number(tick.decimals);
            assert.equal(Math.round(Number(tick.price) / unit) % 10, Number(tick.digit));
        }
    } finally { await close(); }
});
