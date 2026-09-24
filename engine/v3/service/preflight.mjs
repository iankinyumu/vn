// Startup checks for the engine worker (brief §Required design decisions 7).
// Returns a list of failures; the worker must not start while any exist.
// In production every check is mandatory. There is no silent fallback to
// local custody, an unpinned key or fewer witnesses.
import { readFileSync } from 'node:fs';

export function loadTrustManifest(url = new URL('../../../verifier/v3/trusted-keys.json', import.meta.url)) {
    return JSON.parse(readFileSync(url, 'utf8'));
}

/**
 * @param {object} o
 * @param {string} o.dbEnv            engine_v3_settings.env from the database
 * @param {string[]} o.requiredWitnesses  engine_v3_settings.required_witnesses
 * @param {string[]} o.indices        index codes configured in the database for the mode
 * @param {object} o.custody          custody provider
 * @param {object} o.signer           Ed25519Signer
 * @param {object} o.trust            parsed verifier/v3/trusted-keys.json
 * @param {Array}  o.witnesses        witness providers ({name, roots})
 * @param {object} o.params           per-index parameters
 */
export async function preflight({ dbEnv, requiredWitnesses, indices, custody, signer, trust, witnesses, params, mode = 'DEMO' }) {
    const failures = [];
    const production = dbEnv === 'production';
    if (!dbEnv) failures.push('database environment is not configured (engine_v3_configure)');
    if (mode !== 'DEMO') failures.push('only DEMO is permitted; REAL requires the separate REAL readiness gate');
    if (production && !String(custody?.provider).startsWith('kms:')) failures.push(`custody provider ${custody?.provider} is not allowed in production`);
    try {
        const probe = Buffer.from('engine-v3-startup-check');
        const context = { purpose: 'startup-check', env: dbEnv || 'unset', mode };
        const wrapped = await custody.wrap(probe, context);
        const back = await custody.unwrap(wrapped, context);
        if (!back.equals(probe)) failures.push('custody round trip returned different bytes');
    } catch (error) { failures.push(`custody unavailable: ${error.message}`); }
    const keys = trust?.keys || {};
    if (production && !Object.keys(keys).length) failures.push('trust manifest verifier/v3/trusted-keys.json is empty');
    if (production && keys[signer.keyId] !== signer.publicKey.toString('hex')) failures.push(`signing key ${signer.keyId} is not published in the trust manifest`);
    const names = witnesses.map((w) => w.name);
    for (const required of requiredWitnesses || []) if (!names.includes(required)) failures.push(`required witness ${required} is not configured`);
    if (production && new Set(names).size < 2) failures.push('production requires two independent witnesses');
    for (const w of witnesses) if (!w.roots?.length) failures.push(`witness ${w.name} has no pinned roots`);
    for (const index of indices) {
        const p = params?.[index];
        if (!p) { failures.push(`parameters missing for ${index}`); continue; }
        for (const field of ['annual_vol_bp', 'anchor_units', 'kappa_e12', 'min_units', 'max_units', 'genesis_tick_no', 'genesis_units']) {
            if (p[field] === undefined || p[field] === null || p[field] === '') failures.push(`${index}.${field} missing`);
        }
    }
    return failures;
}
