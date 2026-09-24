// Issues genuine RFC 3161 tokens signed by the TEST-ONLY PKI in
// tests/fixtures/test-tsa.json, so worker and verifier tests exercise the same
// CMS and chain code that checks DigiCert and Sectigo tokens.
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { explicit, generalizedTime, integer, octets, oid, seq, set, sha256AlgorithmIdentifier, tlv, nullValue } from '../../engine/v3/service/der.mjs';
import { parseCertificate, verifyTimestampToken } from '../../verifier/v3/tsa.mjs';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/test-tsa.json', import.meta.url), 'utf8'));
export const TEST_TSA_ROOT = Buffer.from(fixture.root, 'base64');
const SIGNER = Buffer.from(fixture.signer, 'base64');
const KEY = createPrivateKey({ key: Buffer.from(fixture.signer_key_pkcs8, 'base64'), format: 'der', type: 'pkcs8' });
let serial = 1n;

export function issueTestToken(subject, genTimeMs = Date.now()) {
    const cert = parseCertificate(new Uint8Array(SIGNER));
    const tstInfo = seq(integer(1), oid('1.2.3.4.1'), seq(sha256AlgorithmIdentifier(), octets(subject)), integer(serial++), generalizedTime(genTimeMs));
    const attrs = [
        seq(oid('1.2.840.113549.1.9.3'), set(oid('1.2.840.113549.1.9.16.1.4'))),
        seq(oid('1.2.840.113549.1.9.4'), set(octets(createHash('sha256').update(tstInfo).digest()))),
        seq(oid('1.2.840.113549.1.9.16.2.47'), set(seq(seq(seq(octets(createHash('sha256').update(SIGNER).digest())))))),
    ];
    const signature = sign('sha256', set(...attrs), KEY);
    const signerInfo = seq(integer(1), seq(Buffer.from(cert.issuer), tlv(0x02, Buffer.from(cert.serial))), sha256AlgorithmIdentifier(),
        tlv(0xa0, ...attrs), seq(oid('1.2.840.113549.1.1.1'), nullValue()), octets(signature));
    const signedData = seq(integer(3), set(sha256AlgorithmIdentifier()), seq(oid('1.2.840.113549.1.9.16.1.4'), explicit(0, octets(tstInfo))),
        tlv(0xa0, SIGNER), set(signerInfo));
    return seq(oid('1.2.840.113549.1.7.2'), explicit(0, signedData));
}

/** Witness provider backed by the test TSA; `fail` simulates an outage. */
export class TestWitness {
    constructor(name, { clock = () => Date.now() } = {}) { this.name = name; this.clock = clock; this.fail = false; this.calls = 0; }
    async witness(subject) {
        this.calls++;
        if (this.fail) throw new Error(`tsa_unreachable_${this.name}`);
        const token = issueTestToken(subject, this.clock());
        const checked = await verifyTimestampToken(new Uint8Array(token), { subject: new Uint8Array(subject), roots: [new Uint8Array(TEST_TSA_ROOT)] });
        if (!checked.ok) throw new Error(`test_tsa_invalid: ${checked.error}`);
        return { provider: this.name, token, genTimeMs: checked.genTimeMs };
    }
}
