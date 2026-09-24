// Witness, custody and signing (ADR 0002 D2, D4, D5) and the production-only
// database guards.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { AwsKmsCustody, LocalCustody, seedContext } from '../engine/v3/service/custody.mjs';
import { Ed25519Signer } from '../engine/v3/service/signer.mjs';
import { timestampRequest, tokenFromResponse } from '../engine/v3/service/witness.mjs';
import { decodeBase64, verifyTimestampToken } from '../verifier/v3/tsa.mjs';
import { asUser, createRealDatabase } from './helpers/pg-real.mjs';
import { TEST_TSA_ROOT, issueTestToken } from './helpers/test-tsa.mjs';

const roots = JSON.parse(readFileSync(new URL('../verifier/v3/tsa-roots.json', import.meta.url), 'utf8')).providers;
const fixture = (name) => new Uint8Array(readFileSync(new URL(`../verifier/v3/fixtures/${name}.tst`, import.meta.url)));
const pinned = (name) => roots[name].certificates.map(decodeBase64);
// Subject: the first epoch commitment in engine/v3/vectors.json. Times were
// confirmed independently with `openssl ts -reply -text` when captured.
const SUBJECT = Uint8Array.from(Buffer.from('1fbb8772d2a399c665e805567b515f7d50d8945b1b11bbb06195bea2607345f7', 'hex'));
const EXPECTED = { digicert: '2026-09-24T19:29:16.000Z', sectigo: '2026-09-24T19:29:18.000Z', freetsa: '2026-09-24T19:29:20.000Z' };

test('real DigiCert, Sectigo and FreeTSA tokens verify against their pinned roots', async () => {
    for (const [name, time] of Object.entries(EXPECTED)) {
        const result = await verifyTimestampToken(fixture(name), { subject: SUBJECT, roots: pinned(name) });
        assert.equal(result.ok, true, `${name}: ${result.error}`);
        assert.equal(new Date(result.genTimeMs).toISOString(), time);
    }
});

test('a token is rejected for another subject, another root set or an altered signed byte', async () => {
    const other = SUBJECT.slice(); other[31] ^= 1;
    for (const name of Object.keys(EXPECTED)) {
        assert.match((await verifyTimestampToken(fixture(name), { subject: other, roots: pinned(name) })).error, /imprint/);
        assert.match((await verifyTimestampToken(fixture(name), { subject: SUBJECT, roots: pinned(name === 'digicert' ? 'sectigo' : 'digicert') })).error, /pinned root/);
        // Flip bytes in every protected region: digestAlgorithms, the signed
        // TSTInfo, the signer certificate and the signature. (Copies of CA
        // certificates that the chain never uses are outside the trust decision.)
        const token = fixture(name);
        for (const at of [40, 80, 120, token.length - 20, token.length - 60]) {
            const altered = token.slice(); altered[at] ^= 0x01;
            assert.equal((await verifyTimestampToken(altered, { subject: SUBJECT, roots: pinned(name) })).ok, false, `${name} byte ${at}`);
        }
    }
    assert.equal((await verifyTimestampToken(new Uint8Array([0x30, 0x03, 0x02, 0x01]), { subject: SUBJECT, roots: pinned('digicert') })).ok, false);
});

test('the pinned root list matches the fingerprints recorded in ADR 0002', () => {
    assert.equal(roots.digicert.sha256, '552f7bdcf1a7af9e6ce672017f4f12abf77240c78e761ac203d1d9d20ac89988');
    assert.equal(roots.sectigo.sha256, '4941b001b8a97e961b7817c9d9e960ec4b056bfc915a8c1aabf6ef6b3ac046a5');
    assert.ok(!JSON.stringify(roots).includes(TEST_TSA_ROOT.toString('base64')), 'the test root is never pinned');
});

test('RFC 3161 request and response framing', async () => {
    const request = timestampRequest(Buffer.from(SUBJECT), Buffer.alloc(8, 1));
    assert.equal(request.toString('hex'), '3043020101303130' + '0d06096086480165030402010500' + '0420' + Buffer.from(SUBJECT).toString('hex') + '02080101010101010101' + '0101ff');
    const token = issueTestToken(Buffer.from(SUBJECT));
    const granted = Buffer.concat([Buffer.from([0x30, 0x82, (token.length + 5) >> 8, (token.length + 5) & 0xff, 0x30, 0x03, 0x02, 0x01, 0x00]), token]);
    assert.deepEqual(tokenFromResponse(granted), token);
    assert.throws(() => tokenFromResponse(Buffer.from([0x30, 0x05, 0x30, 0x03, 0x02, 0x01, 0x02])), /tsa_rejected_status_2/);
    assert.equal((await verifyTimestampToken(new Uint8Array(token), { subject: SUBJECT, roots: [new Uint8Array(TEST_TSA_ROOT)] })).ok, true);
});

test('custody binds ciphertext to its context; KMS calls carry the encryption context', async () => {
    const local = new LocalCustody(randomBytes(32));
    const seed = randomBytes(32);
    const context = seedContext({ env: 'test', mode: 'DEMO', epochStartMs: 86_400_000n });
    const wrapped = await local.wrap(seed, context);
    assert.ok(!wrapped.ciphertext.includes(seed));
    assert.deepEqual(await local.unwrap(wrapped, context), seed);
    await assert.rejects(local.unwrap(wrapped, { ...context, epoch_start_ms: '0' }));
    await assert.rejects(new LocalCustody(randomBytes(32)).unwrap(wrapped, context), /custody_key_ref_mismatch/);

    const calls = [];
    const fakeKms = {
        encrypt: async (input) => { calls.push(['encrypt', input]); return { KeyId: input.KeyId, CiphertextBlob: Buffer.concat([Buffer.from('kms:'), input.Plaintext]) }; },
        decrypt: async (input) => { calls.push(['decrypt', input]); return { Plaintext: input.CiphertextBlob.subarray(4) }; },
    };
    const kms = new AwsKmsCustody({ keyId: 'arn:aws:kms:eu-west-1:111111111111:key/test', client: fakeKms });
    assert.equal(kms.provider, 'kms:aws');
    const blob = await kms.wrap(seed, context);
    assert.deepEqual(await kms.unwrap(blob, context), seed);
    assert.deepEqual(calls.map(([, input]) => input.EncryptionContext), [{ purpose: 'epoch-seed', env: 'test', mode: 'DEMO', epoch_start_ms: '86400000' }, { purpose: 'epoch-seed', env: 'test', mode: 'DEMO', epoch_start_ms: '86400000' }]);
    await assert.rejects(kms.wrap(seed, { purpose: 'bad value with spaces' }), /custody_context_invalid/);
});

test('the signing key survives only in wrapped form and signs domain-separated messages', async () => {
    const custody = new LocalCustody(randomBytes(32));
    const signer = Ed25519Signer.generate('key-2026-09');
    const wrapped = await signer.wrap(custody, 'test');
    const restored = await Ed25519Signer.unwrap(custody, 'test', wrapped);
    assert.deepEqual(restored.publicKey, signer.publicKey);
    const subject = randomBytes(32);
    const key = await crypto.subtle.importKey('raw', signer.publicKey, { name: 'Ed25519' }, false, ['verify']);
    const { signedMessage } = await import('../engine/v3/generator.mjs');
    assert.equal(await crypto.subtle.verify('Ed25519', key, restored.sign('checkpoint', subject), signedMessage('checkpoint', 'key-2026-09', subject)), true);
    assert.equal(await crypto.subtle.verify('Ed25519', key, restored.sign('checkpoint', subject), signedMessage('epoch-commitment', 'key-2026-09', subject)), false);
    await assert.rejects(Ed25519Signer.unwrap(custody, 'production', wrapped));
});

test('a production database refuses weakened thresholds, non-KMS custody and REAL cutovers', async () => {
    const { db, close } = await createRealDatabase();
    try {
        const configure = (settings) => asUser(db, 'ian', () => db.query(`select public.engine_v3_configure('production',$1::jsonb,'production environment setup')`, [JSON.stringify(settings)]));
        for (const weak of [{ min_commit_lead_ms: 0 }, { max_tick_lag_ms: 60000 }, { reveal_delay_ms: 0 }, { required_witnesses: ['digicert'] }, { max_clock_drift_ms: 5000 }]) {
            await assert.rejects(configure(weak), /engine_v3_threshold_below_policy/, JSON.stringify(weak));
        }
        await configure({});
        await db.exec(`create role prod_worker login password 'p' in role engine_tick_writer`);
        await db.exec(`set role prod_worker`);
        await assert.rejects(db.query(`select public.engine_v3_heartbeat('w1',$1,'local:aes-256-gcm','node')`, [Date.now()]), /engine_v3_custody_not_allowed/);
        await db.query(`select public.engine_v3_heartbeat('w1',$1,'kms:aws','node')`, [Date.now()]);
        await db.exec('reset role');
        await assert.rejects(asUser(db, 'ian', () => db.query(`select public.engine_v3_schedule_cutover('REAL','SPI10',0,'REAL is not permitted here')`)), /engine_v3_practice_only/);
    } finally { await close(); }
});
