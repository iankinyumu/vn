// Minimal DER encoder for RFC 3161 requests (and the test TSA).
const length = (n) => {
    if (n < 0x80) return Buffer.from([n]);
    const bytes = [];
    for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
    return Buffer.from([0x80 | bytes.length, ...bytes]);
};
export const tlv = (tag, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([Buffer.from([tag]), length(body.length), body]); };
export const seq = (...parts) => tlv(0x30, ...parts);
export const set = (...parts) => tlv(0x31, ...parts);
export const octets = (bytes) => tlv(0x04, Buffer.from(bytes));
export const nullValue = () => Buffer.from([0x05, 0x00]);
export const bool = (value) => Buffer.from([0x01, 0x01, value ? 0xff : 0x00]);
export const explicit = (n, ...parts) => tlv(0xa0 + n, ...parts);
export function integer(value) {
    let hex = BigInt(value).toString(16);
    if (hex.length % 2) hex = `0${hex}`;
    let bytes = Buffer.from(hex, 'hex');
    if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
    return tlv(0x02, bytes);
}
export function oid(text) {
    const parts = text.split('.').map(Number);
    const out = [parts[0] * 40 + parts[1]];
    for (const part of parts.slice(2)) {
        const stack = [part & 0x7f];
        for (let v = Math.floor(part / 128); v > 0; v = Math.floor(v / 128)) stack.unshift((v & 0x7f) | 0x80);
        out.push(...stack);
    }
    return tlv(0x06, Buffer.from(out));
}
export function generalizedTime(ms) {
    const iso = new Date(ms).toISOString(); // 2026-09-24T19:29:16.123Z
    return tlv(0x18, Buffer.from(`${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}.${iso.slice(20, 23)}Z`, 'ascii'));
}
export const SHA256 = '2.16.840.1.101.3.4.2.1';
export const sha256AlgorithmIdentifier = () => seq(oid(SHA256), nullValue());
