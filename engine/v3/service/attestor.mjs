// Witness attestor (brief decision 6). Runs under its own database role
// (engine_witness_attestor) and credentials, separate from the tick writer. It
// re-verifies each submitted RFC 3161 token against the pinned roots and the
// canonical subject, takes genTime from the token itself (never from the
// submitter), and records a verdict bound to the root bundle id.
import { rootBundleId, verifyTimestampToken } from '../../../verifier/v3/tsa.mjs';

export class WitnessAttestor {
    /** @param {{db:{query:Function}, roots:Record<string,Uint8Array[]>, attestorId?:string, log?:Function}} o */
    constructor({ db, roots, attestorId = 'engine-v3-attestor', log = () => {} }) {
        Object.assign(this, { db, roots, attestorId, log });
    }

    async bundleId() { this.bundle ??= Buffer.from(await rootBundleId(this.roots), 'hex'); return this.bundle; }

    async cycle(limit = 50) {
        const report = { valid: 0, late: 0, invalid: 0 };
        const { rows } = await this.db.query('select * from public.engine_v3_pending_witnesses($1)', [limit]);
        for (const row of rows) {
            const roots = this.roots[row.provider];
            const checked = roots?.length
                ? await verifyTimestampToken(new Uint8Array(row.token), { subject: new Uint8Array(row.subject_hash), roots })
                : { ok: false, error: `no pinned roots for provider ${row.provider}` };
            const verdict = checked.ok ? 'valid' : 'invalid';
            const { rows: [out] } = await this.db.query('select public.engine_v3_attest_witness($1,$2,$3,$4,$5,$6) r',
                [row.submission_id, verdict, checked.ok ? 'token verified against pinned roots' : checked.error, checked.ok ? String(checked.genTimeMs) : null, await this.bundleId(), this.attestorId]);
            report[out.r]++;
            if (out.r !== 'valid') this.log('warn', 'witness receipt not usable', { submission: String(row.submission_id), provider: row.provider, outcome: out.r, reason: checked.error });
        }
        return report;
    }
}
