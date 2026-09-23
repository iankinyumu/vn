import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { createTestDatabase } from './helpers/test-db.mjs';

async function migratedDatabase() {
    return createTestDatabase();
}

test('legacy order commands are shut down by the module guard', async () => {
    const db = await migratedDatabase();
    await assert.rejects(
        db.query("select public.submit_demo_order('x','X', 'BUY', 'MARKET', 1, null, null, 'x')"),
        /module_disabled/
    );
    await db.close();
});

test('active source has no legacy feed references', () => {
    const terms = ['bina' + 'nce', 'bit' + 'coin', '\\bb' + 'tc\\b', '\\beth\\b', 'usd' + 't', 'cryp' + 'to', 'market_' + 'symbol', 'market-' + 'registry', 'market-' + 'ticker', 'fcsa' + 'pi', 'upst' + 'ash'];
    const result = spawnSync('rg', ['-rniE', '-g', '!**/_disabled/**', terms.join('|'), 'pages', 'assets', 'supabase/functions', 'tests', 'docs', 'README.md', 'package.json', '.env.example'], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.stdout);
});
