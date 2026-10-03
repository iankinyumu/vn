// RFC 3161 witness client (ADR 0002 D5). Every token is verified against the
// pinned roots before the worker records it.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { decodeBase64, verifyTimestampToken } from '../../../verifier/v3/tsa.mjs';
import { bool, integer, octets, seq, sha256AlgorithmIdentifier } from './der.mjs';

export const DEFAULT_TSAS = Object.freeze({
    digicert: 'http://timestamp.digicert.com',
    sectigo: 'http://timestamp.sectigo.com',
    freetsa: 'https://freetsa.org/tsr',
});

export function pinnedRoots() {
    const list = JSON.parse(readFileSync(new URL('../../../verifier/v3/tsa-roots.json', import.meta.url), 'utf8')).providers;
    return Object.fromEntries(Object.entries(list).map(([name, entry]) => [name, entry.certificates.map(decodeBase64)]));
}

export function timestampRequest(subject, nonce = randomBytes(8)) {
    return seq(integer(1), seq(sha256AlgorithmIdentifier(), octets(subject)), integer(BigInt(`0x${nonce.toString('hex')}`)), bool(true));
}

// TimeStampResp ::= SEQUENCE { status PKIStatusInfo, timeStampToken ContentInfo OPTIONAL }
export function tokenFromResponse(response) {
    const bytes = new Uint8Array(response);
    const read = (at) => {
        let len = bytes[at + 1], header = 2;
        if (len & 0x80) { const n = len & 0x7f; len = 0; for (let i = 0; i < n; i++) len = len * 256 + bytes[at + 2 + i]; header += n; }
        return { start: at + header, end: at + header + len };
    };
    const outer = read(0);
    const status = read(outer.start);
    const code = read(status.start); // PKIStatus INTEGER, first field of PKIStatusInfo
    if (bytes[status.start] !== 0x02 || code.end - code.start !== 1) throw new Error('tsa_malformed_status');
    const statusValue = bytes[code.start];
    if (statusValue > 1) throw new Error(`tsa_rejected_status_${statusValue}`); // 0 granted, 1 grantedWithMods
    if (status.end >= outer.end) throw new Error('tsa_missing_token');
    return Buffer.from(bytes.subarray(status.end, outer.end));
}

export class Rfc3161Witness {
    constructor({ name, url, roots, fetchImpl = globalThis.fetch, timeoutMs = 15000 }) {
        this.name = name; this.url = url; this.roots = roots; this.fetch = fetchImpl; this.timeoutMs = timeoutMs;
    }
    async witness(subject) {
        const response = await this.fetch(this.url, {
            method: 'POST', headers: { 'content-type': 'application/timestamp-query' }, body: timestampRequest(subject), signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!response.ok) throw new Error(`tsa_http_${response.status}`);
        const token = tokenFromResponse(Buffer.from(await response.arrayBuffer()));
        const checked = await verifyTimestampToken(new Uint8Array(token), { subject: new Uint8Array(subject), roots: this.roots });
        if (!checked.ok) throw new Error(`tsa_token_invalid: ${checked.error}`);
        return { provider: this.name, token, genTimeMs: checked.genTimeMs };
    }
}
