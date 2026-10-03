// Ed25519 signer for commitments and checkpoints (ADR 0002 D4). The private key
// is stored only as a custody-wrapped PKCS#8 blob.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign } from 'node:crypto';
import { signedMessage } from '../generator.mjs';
import { signingKeyContext } from './custody.mjs';

export class Ed25519Signer {
    constructor({ keyId, privateKey }) {
        if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyId)) throw new Error('signing_key_id_invalid');
        this.keyId = keyId;
        this.privateKey = privateKey;
        // SPKI DER for Ed25519 is a fixed 12-byte prefix plus the 32-byte key.
        this.publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).subarray(12);
    }
    sign(kind, subject) { return edSign(null, signedMessage(kind, this.keyId, subject), this.privateKey); }

    static generate(keyId) { return new Ed25519Signer({ keyId, privateKey: generateKeyPairSync('ed25519').privateKey }); }

    async wrap(custody, env) {
        const pkcs8 = this.privateKey.export({ type: 'pkcs8', format: 'der' });
        try { return { keyId: this.keyId, provider: custody.provider, ...(await custody.wrap(pkcs8, signingKeyContext({ env, keyId: this.keyId }))) }; }
        finally { pkcs8.fill(0); }
    }

    static async unwrap(custody, env, wrapped) {
        const pkcs8 = await custody.unwrap({ keyRef: wrapped.keyRef, ciphertext: Buffer.from(wrapped.ciphertext) }, signingKeyContext({ env, keyId: wrapped.keyId }));
        try { return new Ed25519Signer({ keyId: wrapped.keyId, privateKey: createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' }) }); }
        finally { pkcs8.fill(0); }
    }
}
