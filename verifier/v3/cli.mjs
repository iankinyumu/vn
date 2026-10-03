#!/usr/bin/env node
// Verifies an exported smartprofit-proof/v3 package offline.
//
//   node verifier/v3/cli.mjs proof.json [--json]
//   node verifier/v3/cli.mjs proof.json --trust-dir DIR --allow-test-trust   (test/staging packages only)
//
// By default it loads the published trust manifest (trusted-keys.json) and the
// pinned root bundle (tsa-roots.json) beside this file: the same documents the
// fairness page fetches. Exit codes: 0 fully verified, 2 partial (nothing
// wrong but evidence incomplete), 1 invalid, 64 usage error.
import { readFile } from 'node:fs/promises';
import { EXIT, trustFromDocuments } from './trust.mjs';
import { verifyPackage } from './verify.mjs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--trust-dir');
const usage = (message) => { console.error(`${message}\nusage: node verifier/v3/cli.mjs <proof.json> [--json] [--trust-dir DIR --allow-test-trust]`); process.exit(EXIT.usage); };
if (!file) usage('missing proof file');
const trustDir = args.includes('--trust-dir') ? args[args.indexOf('--trust-dir') + 1] : null;
if (trustDir && !args.includes('--allow-test-trust')) usage('--trust-dir replaces the published trust bundle and requires --allow-test-trust');

let pkg;
try { pkg = JSON.parse(await readFile(file, 'utf8')); } catch (error) { usage(`cannot read ${file}: ${error.message}`); }
if (trustDir && !['test', 'staging'].includes(pkg.env)) usage(`a test trust bundle cannot be used for a ${pkg.env} package`);
const base = trustDir ? new URL(`file:///${trustDir.replaceAll('\\', '/').replace(/^\/+/, '')}/`) : new URL('./', import.meta.url);
const trust = trustFromDocuments(JSON.parse(await readFile(new URL('trusted-keys.json', base), 'utf8')), JSON.parse(await readFile(new URL('tsa-roots.json', base), 'utf8')));
const result = await verifyPackage(pkg, trust);

if (args.includes('--json')) console.log(JSON.stringify({ trust: trustDir ? 'TEST TRUST BUNDLE' : 'published', ...result }, null, 2));
else {
    if (trustDir) console.log('*** TEST TRUST BUNDLE: not production evidence ***');
    const verdictText = { fully_verified: 'FULLY VERIFIED', partial: 'PARTIAL: nothing contradicts the record, but some evidence is missing', invalid: 'INVALID' }[result.verdict];
    console.log(`Verdict: ${verdictText}`);
    for (const [name, value] of Object.entries(result.components)) console.log(`  ${name.replace('_', '/').padEnd(17)} ${value}`);
    const count = (state) => result.ticks.filter((tick) => tick.status === state).length;
    console.log(`Ticks: ${result.ticks.length} checked, ${count('verified')} verified, ${count('not_yet_revealable')} not yet revealable`);
    console.log(`Anchored: ${Object.entries(result.anchored).map(([index, ok]) => `${index} ${ok ? 'yes' : 'no'}`).join(', ') || 'no ticks'}`);
    console.log(`Contracts: ${result.contracts.length} checked, ${result.contracts.filter((c) => c.status === 'verified').length} verified`);
    for (const issue of result.issues.slice(0, 50)) console.log(`  [${issue.state}] ${issue.detail}`);
    if (result.issues.length > 50) console.log(`  … ${result.issues.length - 50} more (use --json)`);
}
process.exitCode = EXIT[result.verdict];
