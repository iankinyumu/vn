#!/usr/bin/env node
// Engine v3 worker entry point. Configuration comes from the environment:
//
//   ENGINE_DATABASE_URL     postgres URL of a login role that is a member of engine_tick_writer
//   ENGINE_MODE             DEMO (REAL is refused until the REAL gate, ADR 0002 §9)
//   ENGINE_PARAMS_FILE      JSON: per-index model parameters (see docs/runbooks/engine-v3.md)
//   ENGINE_CUSTODY          kms:aws | local        (local refused when the database env is production)
//   ENGINE_KMS_KEY_ID, AWS_REGION                  for kms:aws
//   ENGINE_LOCAL_WRAP_KEY_FILE                     32 raw bytes, test/staging only
//   ENGINE_SIGNING_KEY_FILE JSON {keyId, keyRef, ciphertext(base64)} from `--init-signing-key`
//   ENGINE_WITNESSES        comma list, default digicert,sectigo
//
//   node engine/v3/service/main.mjs --init-signing-key <keyId>   create and wrap a signing key
import { readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import { AwsKmsCustody, LocalCustody, awsKmsClient } from './custody.mjs';
import { Ed25519Signer } from './signer.mjs';
import { DEFAULT_TSAS, Rfc3161Witness, pinnedRoots } from './witness.mjs';
import { EngineWorker } from './worker.mjs';

const env = process.env;
const log = (level, message, detail = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), level, message, ...detail }));

async function custody() {
    if (env.ENGINE_CUSTODY === 'kms:aws') return new AwsKmsCustody({ keyId: env.ENGINE_KMS_KEY_ID, client: await awsKmsClient(env.AWS_REGION) });
    if (env.ENGINE_CUSTODY === 'local') return new LocalCustody(readFileSync(env.ENGINE_LOCAL_WRAP_KEY_FILE));
    throw new Error('ENGINE_CUSTODY must be kms:aws or local');
}

const signingEnv = () => env.ENGINE_SIGNING_ENV || 'production';

if (process.argv[2] === '--init-signing-key') {
    const signer = Ed25519Signer.generate(process.argv[3]);
    const wrapped = await signer.wrap(await custody(), signingEnv());
    writeFileSync(env.ENGINE_SIGNING_KEY_FILE, JSON.stringify({ ...wrapped, ciphertext: wrapped.ciphertext.toString('base64') }, null, 2));
    log('info', 'signing key created', { keyId: signer.keyId, publicKey: signer.publicKey.toString('hex') });
    process.exit(0);
}

if ((env.ENGINE_MODE || 'DEMO') !== 'DEMO') throw new Error('Only DEMO is permitted; REAL requires the separate REAL readiness gate.');
const store = await custody();
const wrappedKey = JSON.parse(readFileSync(env.ENGINE_SIGNING_KEY_FILE, 'utf8'));
const signer = await Ed25519Signer.unwrap(store, signingEnv(), { ...wrappedKey, ciphertext: Buffer.from(wrappedKey.ciphertext, 'base64') });
const roots = pinnedRoots();
const witnesses = (env.ENGINE_WITNESSES || 'digicert,sectigo').split(',').map((name) => new Rfc3161Witness({ name, url: DEFAULT_TSAS[name], roots: roots[name] }));
const params = JSON.parse(readFileSync(env.ENGINE_PARAMS_FILE, 'utf8'));

const db = new pg.Client({ connectionString: env.ENGINE_DATABASE_URL });
await db.connect();
const worker = new EngineWorker({ db, mode: 'DEMO', workerId: env.ENGINE_WORKER_ID || 'engine-v3-worker', params, custody: store, signer, witnesses, log });
while (!(await worker.acquireLeadership())) { log('info', 'standby: another worker holds the lock'); await new Promise((r) => setTimeout(r, 5000)); }
await worker.registerSigningKey();
log('info', 'engine v3 worker started', { custody: store.provider, keyId: signer.keyId });
for (;;) {
    const started = Date.now();
    try {
        const report = await worker.cycle();
        if (report.errors.length || report.committed || report.revealed || report.activated) log(report.errors.length ? 'warn' : 'info', 'cycle', report);
    } catch (error) {
        log('error', 'cycle failed', { error: error.message });
        if (worker.stopped) process.exit(2);
    }
    await new Promise((r) => setTimeout(r, Math.max(100, 1000 - (Date.now() - started))));
}
