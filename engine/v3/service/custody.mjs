// Seed and signing-key custody (ADR 0002 D2). A provider wraps secrets bound to
// a context; the database only ever sees { provider, keyRef, ciphertext }.
//
// Provider names starting with "kms:" are the only ones the database accepts in
// env=production (engine_v3_heartbeat / engine_v3_commit_epoch).
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export function canonicalContext(context) {
    const keys = Object.keys(context).sort();
    for (const key of keys) if (!/^[a-z_]{1,32}$/.test(key) || !/^[A-Za-z0-9._:-]{1,128}$/.test(String(context[key]))) throw new Error('custody_context_invalid');
    return keys.map((key) => `${key}=${context[key]}`).join('\n');
}

/** Test/staging only: AES-256-GCM under a local 32-byte wrapping key. */
export class LocalCustody {
    constructor(wrappingKey) {
        if (!Buffer.isBuffer(wrappingKey) || wrappingKey.length !== 32) throw new Error('custody_key_invalid');
        this.key = wrappingKey;
        this.provider = 'local:aes-256-gcm';
        this.keyRef = `local-${createHash('sha256').update(wrappingKey).digest('hex').slice(0, 16)}`;
    }
    async wrap(plaintext, context) {
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', this.key, iv);
        cipher.setAAD(Buffer.from(canonicalContext(context)));
        const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        return { keyRef: this.keyRef, ciphertext: Buffer.concat([iv, cipher.getAuthTag(), body]) };
    }
    async unwrap({ keyRef, ciphertext }, context) {
        if (keyRef !== this.keyRef) throw new Error('custody_key_ref_mismatch');
        const decipher = createDecipheriv('aes-256-gcm', this.key, ciphertext.subarray(0, 12));
        decipher.setAAD(Buffer.from(canonicalContext(context)));
        decipher.setAuthTag(ciphertext.subarray(12, 28));
        return Buffer.concat([decipher.update(ciphertext.subarray(28)), decipher.final()]);
    }
}

/**
 * AWS KMS symmetric key. The key never leaves KMS; Encrypt/Decrypt bind the
 * encryption context, which CloudTrail records on every Decrypt. `client` is
 * anything with encrypt({KeyId,Plaintext,EncryptionContext}) and
 * decrypt({KeyId,CiphertextBlob,EncryptionContext}) returning the SDK shapes;
 * use awsKmsClient() in production.
 */
export class AwsKmsCustody {
    constructor({ keyId, client }) {
        if (!keyId || !client) throw new Error('custody_config_invalid');
        this.keyId = keyId; this.client = client; this.provider = 'kms:aws'; this.keyRef = keyId;
    }
    async wrap(plaintext, context) {
        const out = await this.client.encrypt({ KeyId: this.keyId, Plaintext: plaintext, EncryptionContext: stringContext(context) });
        return { keyRef: out.KeyId || this.keyId, ciphertext: Buffer.from(out.CiphertextBlob) };
    }
    async unwrap({ keyRef, ciphertext }, context) {
        const out = await this.client.decrypt({ KeyId: keyRef, CiphertextBlob: ciphertext, EncryptionContext: stringContext(context) });
        return Buffer.from(out.Plaintext);
    }
}
const stringContext = (context) => { canonicalContext(context); return Object.fromEntries(Object.entries(context).map(([k, v]) => [k, String(v)])); };

/** Loads the AWS SDK lazily so tests and other providers do not need it. */
export async function awsKmsClient(region) {
    const sdk = await import('@aws-sdk/client-kms');
    const kms = new sdk.KMSClient({ region });
    return {
        encrypt: (input) => kms.send(new sdk.EncryptCommand(input)),
        decrypt: (input) => kms.send(new sdk.DecryptCommand(input)),
    };
}

export const seedContext = ({ env, mode, epochStartMs }) => ({ purpose: 'epoch-seed', env, mode, epoch_start_ms: String(epochStartMs) });
export const signingKeyContext = ({ env, keyId }) => ({ purpose: 'signing-key', env, key_id: keyId });
