import assert from 'node:assert/strict';
import fs from 'node:fs';
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
    const matcher = new RegExp(terms.join('|'), 'i');
    // The Web Crypto API is the one legitimate use of a banned word, and only through these exact references.
    const allowed = /\bwindow\.crypto\b|\bcrypto\.(?:subtle|randomUUID)\b/g;
    // Adjacent string literals are joined before matching, so a term cannot be hidden by splitting it across a '+'.
    const joinLiterals = (source) => source.replace(/(['"`])\s*\+\s*\1/g, '');
    const roots = ['pages', 'assets', 'supabase/functions', 'README.md', 'package.json', '.env.example'];
    const matches = [];
    const visit = (target) => {
        if (!fs.existsSync(target)) return;
        const stat = fs.statSync(target);
        if (stat.isDirectory()) {
            for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
                if (entry.isDirectory() && entry.name === '_disabled') continue;
                visit(`${target}/${entry.name}`);
            }
            return;
        }
        const contents = fs.readFileSync(target);
        if (contents.includes(0)) return;
        const found = joinLiterals(contents.toString('utf8')).replace(allowed, '').match(matcher);
        if (found) matches.push(`${target} (${found[0]})`);
    };
    roots.forEach(visit);
    assert.deepEqual(matches, [], `legacy feed references found in: ${matches.join(', ')}`);
});

test('the repository root contains no duplicate frontend pages', () => {
    const rootPages = fs.readdirSync('.', { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.html'))
        .map((entry) => entry.name);
    assert.deepEqual(rootPages, [], `root-level frontend duplicates: ${rootPages.join(', ')}`);
});

test('retired page snapshots are not kept in the working tree', () => {
    assert.equal(fs.existsSync('.restore'), false, '.restore must stay removed; the old pages remain in git history');
    const referencing = ['pages', 'assets', 'scripts', 'supabase', 'package.json', 'README.md']
        .flatMap((root) => (fs.statSync(root).isDirectory() ? fs.readdirSync(root, { recursive: true }).map((file) => `${root}/${file}`) : [root]))
        .filter((file) => fs.statSync(file).isFile() && fs.readFileSync(file, 'utf8').includes('.restore'));
    assert.deepEqual(referencing, []);
});
