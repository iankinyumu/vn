import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import test from 'node:test';
import { createTestDatabase } from './helpers/test-db.mjs';

const migrationUrl = new URL('../supabase/migrations/20260920100000_disable_' + 'cryp' + 'to_module.sql', import.meta.url);

async function migratedDatabase() {
    const db = await createTestDatabase();
    await db.exec(await fs.readFile(migrationUrl, 'utf8'));
    return db;
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
