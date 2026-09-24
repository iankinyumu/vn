// One trust policy for browser and CLI: the published signing-key manifest
// (trusted-keys.json) and the pinned RFC 3161 root bundle (tsa-roots.json).
// Both front ends pass the parsed documents here, so the same package and the
// same documents always give the same verdict.
import { decodeBase64 } from './tsa.mjs';

export const DEFAULT_REQUIRED_WITNESSES = Object.freeze(['digicert', 'sectigo']);

/** @returns {{ trustedKeys: object|null, tsaRoots: Record<string, Uint8Array[]>, requiredWitnesses: string[], label: string }} */
export function trustFromDocuments(keysDocument, rootsDocument) {
    const keys = keysDocument?.keys || {};
    const providers = rootsDocument?.providers || {};
    return {
        // An empty manifest means no key is pinned: signatures are "unpinned", never trusted.
        trustedKeys: Object.keys(keys).length ? { ...keys } : null,
        tsaRoots: Object.fromEntries(Object.entries(providers).map(([name, entry]) => [name, entry.certificates.map(decodeBase64)])),
        requiredWitnesses: Array.isArray(rootsDocument?.required) && rootsDocument.required.length ? [...rootsDocument.required] : [...DEFAULT_REQUIRED_WITNESSES],
        label: rootsDocument?.label || 'published',
    };
}

/** Exit codes shared by the CLI and scripts. */
export const EXIT = Object.freeze({ fully_verified: 0, invalid: 1, partial: 2, usage: 64 });
