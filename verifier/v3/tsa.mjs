// RFC 3161 time-stamp token verification with the Web Crypto API only
// (ADR 0002 D5). Checks: TSTInfo imprint = subject; CMS messageDigest and
// contentType attributes; the signature over the signed attributes; the ESS
// signing-certificate binding to the signer; and a certificate chain from the
// signer to a pinned root, each certificate valid at genTime, intermediates
// marked CA, and the signer holding the id-kp-timeStamping EKU.
// Revocation is NOT checked (ADR 0002 §9.6).

const subtle = globalThis.crypto.subtle;

const OID = {
    signedData: '1.2.840.113549.1.7.2', tstInfo: '1.2.840.113549.1.9.16.1.4',
    contentType: '1.2.840.113549.1.9.3', messageDigest: '1.2.840.113549.1.9.4',
    signingCertificate: '1.2.840.113549.1.9.16.2.12', signingCertificateV2: '1.2.840.113549.1.9.16.2.47',
    rsaEncryption: '1.2.840.113549.1.1.1', ecPublicKey: '1.2.840.10045.2.1',
    extKeyUsage: '2.5.29.37', basicConstraints: '2.5.29.19', subjectKeyIdentifier: '2.5.29.14', timeStamping: '1.3.6.1.5.5.7.3.8',
};
const HASHES = { '1.3.14.3.2.26': 'SHA-1', '2.16.840.1.101.3.4.2.1': 'SHA-256', '2.16.840.1.101.3.4.2.2': 'SHA-384', '2.16.840.1.101.3.4.2.3': 'SHA-512' };
const SIGNATURES = {
    '1.2.840.113549.1.1.11': ['RSA', 'SHA-256'], '1.2.840.113549.1.1.12': ['RSA', 'SHA-384'], '1.2.840.113549.1.1.13': ['RSA', 'SHA-512'],
    '1.2.840.10045.4.3.2': ['EC', 'SHA-256'], '1.2.840.10045.4.3.3': ['EC', 'SHA-384'], '1.2.840.10045.4.3.4': ['EC', 'SHA-512'],
};
const CURVES = { '1.2.840.10045.3.1.7': ['P-256', 32], '1.3.132.0.34': ['P-384', 48], '1.3.132.0.35': ['P-521', 66] };

class TsaError extends Error {}
const fail = (message) => { throw new TsaError(message); };

// ---------------------------------------------------------------- DER
function node(bytes, offset = 0) {
    if (offset + 2 > bytes.length) fail('truncated DER');
    const tag = bytes[offset];
    if ((tag & 0x1f) === 0x1f) fail('high-tag-number form not supported');
    let length = bytes[offset + 1], header = 2;
    if (length & 0x80) {
        const count = length & 0x7f;
        if (count === 0 || count > 4) fail('unsupported DER length');
        length = 0;
        for (let i = 0; i < count; i++) length = length * 256 + bytes[offset + 2 + i];
        header += count;
    }
    const start = offset + header, end = start + length;
    if (end > bytes.length) fail('truncated DER');
    return { tag, constructed: (tag & 0x20) !== 0, offset, start, end, bytes, get raw() { return bytes.subarray(offset, end); }, get value() { return bytes.subarray(start, end); } };
}
function children(parent) {
    const out = [];
    for (let at = parent.start; at < parent.end;) { const child = node(parent.bytes, at); out.push(child); at = child.end; }
    return out;
}
function expect(n, tag, what) { if (n?.tag !== tag) fail(`expected ${what}`); return n; }
function oid(n) {
    expect(n, 0x06, 'OID');
    const v = n.value, parts = [Math.floor(v[0] / 40), v[0] % 40];
    let acc = 0;
    for (let i = 1; i < v.length; i++) { acc = acc * 128 + (v[i] & 0x7f); if (!(v[i] & 0x80)) { parts.push(acc); acc = 0; } }
    return parts.join('.');
}
const ascii = (n) => String.fromCharCode(...n.value);
function time(n) {
    const text = ascii(n);
    let m;
    if (n.tag === 0x17 && (m = text.match(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/))) {
        const year = Number(m[1]) < 50 ? 2000 + Number(m[1]) : 1900 + Number(m[1]);
        return Date.UTC(year, m[2] - 1, m[3], m[4], m[5], m[6]);
    }
    if (n.tag === 0x18 && (m = text.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d{1,3})\d*)?Z$/))) {
        return Date.UTC(m[1], m[2] - 1, m[3], m[4], m[5], m[6], Number((m[7] || '0').padEnd(3, '0')));
    }
    return fail('invalid time');
}
const equalBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
async function digest(algorithm, data) { return new Uint8Array(await subtle.digest(algorithm, data)); }
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

// ---------------------------------------------------------------- X.509
export function parseCertificate(der) {
    const cert = node(der);
    const [tbs, sigAlg, sigValue] = children(expect(cert, 0x30, 'certificate'));
    const fields = children(expect(tbs, 0x30, 'tbsCertificate'));
    let i = fields[0].tag === 0xa0 ? 1 : 0;
    const serial = expect(fields[i++], 0x02, 'serial');
    i++; // signature algorithm inside tbs
    const issuer = expect(fields[i++], 0x30, 'issuer');
    const [notBefore, notAfter] = children(expect(fields[i++], 0x30, 'validity'));
    const subject = expect(fields[i++], 0x30, 'subject');
    const spki = expect(fields[i++], 0x30, 'subjectPublicKeyInfo');
    const extensions = {};
    for (; i < fields.length; i++) {
        if (fields[i].tag !== 0xa3) continue;
        for (const ext of children(children(fields[i])[0])) {
            const parts = children(ext);
            extensions[oid(parts[0])] = node(parts[parts.length - 1].value);
        }
    }
    const sigBits = expect(sigValue, 0x03, 'signature');
    return {
        der: cert.raw, tbs: tbs.raw, serial: serial.value, issuer: issuer.raw, subject: subject.raw, spki: spki.raw,
        notBefore: time(notBefore), notAfter: time(notAfter), sigAlg: oid(children(sigAlg)[0]), signature: sigBits.value.subarray(1), extensions,
    };
}
function isCa(cert) {
    const bc = cert.extensions[OID.basicConstraints];
    if (!bc) return false;
    const parts = children(bc);
    return parts.length > 0 && parts[0].tag === 0x01 && parts[0].value[0] !== 0;
}
function hasTimestampingEku(cert) {
    const eku = cert.extensions[OID.extKeyUsage];
    return Boolean(eku) && children(eku).some((item) => oid(item) === OID.timeStamping);
}

function ecdsaRaw(der, size) {
    const [r, s] = children(expect(node(der), 0x30, 'ECDSA signature'));
    const fit = (n) => {
        let v = n.value;
        while (v.length > size && v[0] === 0) v = v.subarray(1);
        if (v.length > size) fail('ECDSA integer too long');
        const out = new Uint8Array(size); out.set(v, size - v.length); return out;
    };
    const out = new Uint8Array(size * 2); out.set(fit(r)); out.set(fit(s), size); return out;
}
async function verifySignature(spkiDer, family, hash, signature, data) {
    const [algorithm, parameters] = children(node(spkiDer));
    const keyAlg = children(algorithm);
    const keyOid = oid(keyAlg[0]);
    if (family === 'RSA') {
        if (keyOid !== OID.rsaEncryption) return false;
        const key = await subtle.importKey('spki', spkiDer, { name: 'RSASSA-PKCS1-v1_5', hash }, false, ['verify']);
        return subtle.verify('RSASSA-PKCS1-v1_5', key, signature, data);
    }
    if (keyOid !== OID.ecPublicKey) return false;
    const curve = CURVES[oid(keyAlg[1])] || fail('unsupported curve');
    void parameters;
    const key = await subtle.importKey('spki', spkiDer, { name: 'ECDSA', namedCurve: curve[0] }, false, ['verify']);
    return subtle.verify({ name: 'ECDSA', hash }, key, ecdsaRaw(signature, curve[1]), data);
}
async function certSignedBy(cert, issuer) {
    if (!equalBytes(cert.issuer, issuer.subject)) return false;
    const [family, hash] = SIGNATURES[cert.sigAlg] || [];
    if (!family) return false;
    return verifySignature(issuer.spki, family, hash, cert.signature, cert.tbs).catch(() => false);
}

// ---------------------------------------------------------------- RFC 3161
function signerMatches(sid, cert) {
    if (sid.tag === 0x30) {
        const [issuer, serial] = children(sid);
        return equalBytes(issuer.raw, cert.issuer) && equalBytes(serial.value, cert.serial);
    }
    if (sid.tag === 0x80) {
        const ski = cert.extensions[OID.subjectKeyIdentifier];
        return Boolean(ski) && equalBytes(ski.value, sid.value);
    }
    return false;
}

/**
 * Verifies a DER TimeStampToken against a 32-byte SHA-256 subject.
 * `roots` is an array of pinned root certificates (DER bytes).
 * Returns { ok: true, genTimeMs, serial, signer } or { ok: false, error }.
 */
export async function verifyTimestampToken(token, { subject, roots }) {
    try {
        const contentInfo = children(expect(node(token), 0x30, 'ContentInfo'));
        if (oid(contentInfo[0]) !== OID.signedData) fail('not signedData');
        const signedData = children(expect(children(expect(contentInfo[1], 0xa0, '[0] content'))[0], 0x30, 'SignedData'));
        const encap = children(expect(signedData[2], 0x30, 'encapContentInfo'));
        if (oid(encap[0]) !== OID.tstInfo) fail('content is not TSTInfo');
        const eContent = expect(children(expect(encap[1], 0xa0, 'eContent'))[0], 0x04, 'eContent octets').value;
        let at = 3;
        const certs = [];
        if (signedData[at]?.tag === 0xa0) { for (const c of children(signedData[at])) if (c.tag === 0x30) certs.push(parseCertificate(c.raw)); at++; }
        if (signedData[at]?.tag === 0xa1) at++;
        const signerInfos = children(expect(signedData[at], 0x31, 'signerInfos'));
        if (signerInfos.length !== 1) fail('expected exactly one signer');
        const si = children(signerInfos[0]);
        const sid = si[1];
        const digestAlg = HASHES[oid(children(si[2])[0])] || fail('unsupported digest');
        // Strict: SignedData.digestAlgorithms must list the signer's digest (RFC 5652 §5.1).
        if (!children(expect(signedData[1], 0x31, 'digestAlgorithms')).some((alg) => HASHES[oid(children(alg)[0])] === digestAlg)) fail('digestAlgorithms does not list the signer digest');
        const signedAttrs = expect(si[3], 0xa0, 'signed attributes');
        const sigAlgOid = oid(children(si[4])[0]);
        const signature = expect(si[5], 0x04, 'signature').value;

        // TSTInfo
        const tst = children(expect(node(eContent), 0x30, 'TSTInfo'));
        const imprint = children(tst[2]);
        if (HASHES[oid(children(imprint[0])[0])] !== 'SHA-256') fail('imprint is not SHA-256');
        if (!equalBytes(expect(imprint[1], 0x04, 'hashedMessage').value, subject)) fail('imprint does not match subject');
        const genTimeMs = time(expect(tst[4], 0x18, 'genTime'));

        // Signed attributes
        const attrs = {};
        for (const attr of children(signedAttrs)) { const [type, values] = children(attr); attrs[oid(type)] = children(values)[0]; }
        if (!attrs[OID.contentType] || oid(attrs[OID.contentType]) !== OID.tstInfo) fail('contentType attribute mismatch');
        if (!attrs[OID.messageDigest] || !equalBytes(attrs[OID.messageDigest].value, await digest(digestAlg, eContent))) fail('messageDigest mismatch');

        // Signer certificate and ESS binding (first ESSCertID must be the signer).
        const signer = certs.find((cert) => signerMatches(sid, cert)) || fail('signer certificate not included');
        const essV2 = attrs[OID.signingCertificateV2], essV1 = attrs[OID.signingCertificate];
        if (essV2) {
            const first = children(children(essV2)[0])[0];
            const parts = children(first);
            const hashAlg = parts[0].tag === 0x30 ? HASHES[oid(children(parts[0])[0])] : 'SHA-256';
            const certHash = parts[0].tag === 0x30 ? parts[1] : parts[0];
            if (!hashAlg || !equalBytes(certHash.value, await digest(hashAlg, signer.der))) fail('ESS signing certificate mismatch');
        } else if (essV1) {
            const first = children(children(children(essV1)[0])[0])[0];
            if (!equalBytes(first.value, await digest('SHA-1', signer.der))) fail('ESS signing certificate mismatch');
        } else fail('no ESS signing certificate attribute');

        // Signature over DER(SET OF signed attributes).
        const signedBytes = new Uint8Array(signedAttrs.raw); signedBytes[0] = 0x31;
        let family, hash;
        if (sigAlgOid === OID.rsaEncryption) { family = 'RSA'; hash = digestAlg; }
        else if (SIGNATURES[sigAlgOid]) [family, hash] = SIGNATURES[sigAlgOid];
        else fail('unsupported signature algorithm');
        if (!await verifySignature(signer.spki, family, hash, signature, signedBytes)) fail('CMS signature invalid');

        // Chain to a pinned root.
        if (!hasTimestampingEku(signer)) fail('signer lacks id-kp-timeStamping');
        const pinned = roots.map((der) => parseCertificate(der instanceof Uint8Array ? der : new Uint8Array(der)));
        let current = signer;
        for (let depth = 0; depth < 6; depth++) {
            if (genTimeMs < current.notBefore || genTimeMs > current.notAfter) fail('certificate not valid at genTime');
            for (const root of pinned) {
                if (equalBytes(current.der, root.der)) return { ok: true, genTimeMs, signer: toHex(await digest('SHA-256', signer.der)) };
                if (await certSignedBy(current, root)) {
                    if (genTimeMs < root.notBefore || genTimeMs > root.notAfter) fail('root not valid at genTime');
                    return { ok: true, genTimeMs, signer: toHex(await digest('SHA-256', signer.der)) };
                }
            }
            let next = null;
            for (const candidate of certs) if (candidate !== current && isCa(candidate) && await certSignedBy(current, candidate)) { next = candidate; break; }
            if (!next) fail('chain does not reach a pinned root');
            current = next;
        }
        return fail('chain too long');
    } catch (error) {
        if (error instanceof TsaError) return { ok: false, error: error.message };
        return { ok: false, error: `malformed token: ${error.message}` };
    }
}

export function decodeBase64(text) {
    const binary = globalThis.atob(text);
    return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

/**
 * Canonical id of a pinned root bundle ({provider: [DER, ...]}): SHA-256 over
 * providers in byte order, each as u16 name length, name, u16 certificate
 * count, then u32 length and DER bytes per certificate. Independent of JSON
 * formatting and line endings.
 */
export async function rootBundleId(bundle) {
    const parts = [];
    const u16 = (n) => Uint8Array.of(n >> 8, n & 255);
    const u32 = (n) => Uint8Array.of(n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
    for (const name of Object.keys(bundle).sort()) {
        const bytes = Uint8Array.from(name, (ch) => ch.charCodeAt(0));
        parts.push(u16(bytes.length), bytes, u16(bundle[name].length));
        for (const der of bundle[name]) parts.push(u32(der.length), der);
    }
    const total = parts.reduce((n, p) => n + p.length, 0), out = new Uint8Array(total);
    let at = 0; for (const p of parts) { out.set(p, at); at += p.length; }
    return toHex(await digest('SHA-256', out));
}
