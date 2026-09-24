#!/usr/bin/env node
// Witness attestor entry point. Deploy separately from the tick worker, with
// its own database login (member of engine_witness_attestor only) and no KMS
// access. Configuration:
//
//   ENGINE_ATTESTOR_DATABASE_URL   postgres URL of the attestor login
//   ENGINE_ATTESTOR_ID             optional label recorded with each verdict
//
// It verifies every submitted RFC 3161 token against verifier/v3/tsa-roots.json
// (the published pinned roots). The database refuses verdicts whose root bundle
// id differs from the one staff configured, so a stale or edited bundle cannot attest.
import pg from 'pg';
import { WitnessAttestor } from './attestor.mjs';
import { pinnedRoots } from './witness.mjs';

const log = (level, message, detail = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), level, message, ...detail }));
const all = pinnedRoots();
const roots = Object.fromEntries(Object.entries(all).filter(([name]) => name !== 'freetsa'));
const db = new pg.Client({ connectionString: process.env.ENGINE_ATTESTOR_DATABASE_URL });
await db.connect();
const attestor = new WitnessAttestor({ db, roots, attestorId: process.env.ENGINE_ATTESTOR_ID || 'engine-v3-attestor', log });
log('info', 'attestor started', { bundle: (await attestor.bundleId()).toString('hex'), providers: Object.keys(roots) });
for (;;) {
    try {
        const report = await attestor.cycle();
        if (report.valid || report.late || report.invalid) log('info', 'attested', report);
    } catch (error) {
        log('error', 'attestation failed', { error: error.message });
        if (/engine_v3_root_bundle_(mismatch|unset)/.test(error.message)) process.exit(3);
    }
    await new Promise((r) => setTimeout(r, 2000));
}
