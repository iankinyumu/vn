#!/usr/bin/env node
// Verifies an exported smartprofit-proof/v3 package offline:
//   node verifier/v3/cli.mjs proof.json [--json]
// Exit code 0 only when every check is `verified`. `unwitnessed` is always
// reported: v3.0 defines no witness receipt that this tool can check yet.
import { readFile } from 'node:fs/promises';
import { verifyPackage } from './verify.mjs';

const file = process.argv[2];
if (!file) { console.error('usage: node verifier/v3/cli.mjs <proof.json> [--json]'); process.exit(2); }
const result = await verifyPackage(JSON.parse(await readFile(file, 'utf8')));
if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
else {
    const count = (state) => result.ticks.filter((tick) => tick.status === state).length;
    console.log(`Result: ${result.status} (${result.states.join(', ')}); witness: ${result.witness}`);
    console.log(`Ticks: ${result.ticks.length} checked, ${count('verified')} verified, ${count('not_yet_revealable')} not yet revealable`);
    console.log(`Anchored to genesis: ${Object.entries(result.anchored).map(([index, ok]) => `${index} ${ok ? 'yes' : 'no'}`).join(', ') || 'no ticks'}`);
    console.log(`Contracts: ${result.contracts.length} checked, ${result.contracts.filter((c) => c.status === 'verified').length} verified`);
    for (const issue of result.issues.slice(0, 50)) console.log(`  [${issue.state}] ${issue.detail}`);
    if (result.issues.length > 50) console.log(`  … ${result.issues.length - 50} more (use --json)`);
}
process.exitCode = result.status === 'verified' ? 0 : 1;
