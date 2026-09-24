// Schema and checks for operational evidence files in docs/evidence/ (production
// fix brief §5). This validates structure, artifact integrity and stated results;
// it is NOT cryptographic proof that people did the work. That rests on the
// named independent reviewer and the reviewed commit that adds the file.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';

const DAY_MS = 86_400_000;
const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;
const iso = (v) => nonEmpty(v) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/.test(v) && !Number.isNaN(Date.parse(v));

/** What each evidence file must show. `results` checks return an error string or null. */
export const EVIDENCE_TYPES = Object.freeze({
    // Independent review of the candidate commit's code (CODE_READY gate).
    'code-review': {
        environment: 'repository', minDays: 0,
        results: (r) => (!/^[0-9a-f]{40}$/.test(r.reviewed_commit || '') ? 'results.reviewed_commit must be the full candidate commit hash'
            : r.findings_resolved !== true ? 'results.findings_resolved must be true'
            : !Array.isArray(r.scope) || !r.scope.length ? 'results.scope must list what was reviewed' : null),
    },
    'kms-provisioning': {
        environment: 'production', minDays: 0,
        results: (r) => (!/^arn:aws:kms:[a-z0-9-]+:\d{12}:key\/[0-9a-f-]{36}$/.test(r.key_arn || '') ? 'results.key_arn must be a KMS key ARN'
            : r.admin_decrypt_denied !== true ? 'results.admin_decrypt_denied must be true (tested)'
            : r.foreign_decrypt_alert_fired !== true ? 'results.foreign_decrypt_alert_fired must be true (tested)'
            : r.cloudtrail_data_events !== true ? 'results.cloudtrail_data_events must be true' : null),
    },
    'worker-deployment': {
        environment: 'production', minDays: 0,
        results: (r, ctx) => (r.custody_provider !== 'kms:aws' ? 'results.custody_provider must be kms:aws'
            : r.separate_cloud_account !== true ? 'results.separate_cloud_account must be true'
            : r.attestor_separate_credentials !== true ? 'results.attestor_separate_credentials must be true'
            : r.preflight_passed !== true ? 'results.preflight_passed must be true'
            : !ctx.trustedKeys[r.published_key_id] ? `results.published_key_id ${r.published_key_id} is not in verifier/v3/trusted-keys.json` : null),
    },
    'shadow-run': {
        environment: 'production', minDays: 7,
        results: (r) => (r.sequence_gaps !== 0 ? 'results.sequence_gaps must be 0'
            : !(r.epochs_total > 0) || r.epochs_witnessed_before_deadline !== r.epochs_total ? 'every epoch must be witnessed before its deadline'
            : !(r.max_checkpoint_gap_ticks <= 300) ? 'results.max_checkpoint_gap_ticks must be <= 300'
            : !(r.lag_p99_seconds <= 6) ? 'results.lag_p99_seconds must be <= 6' : null),
    },
    'live-drills': {
        environment: 'staging', minDays: 0,
        results: (r) => {
            const drills = new Map((r.drills || []).map((d) => [d.name, d]));
            for (const name of ['kms_revoke', 'tsa_block', 'worker_kill', 'clock_skew', 'lost_reply']) {
                const d = drills.get(name);
                if (!d) return `drill ${name} missing`;
                if (d.outcome !== 'as_documented' || !nonEmpty(d.observed)) return `drill ${name} must record an observed outcome matching the runbook`;
            }
            return null;
        },
    },
    'practice-soak': {
        environment: 'production', minDays: 7,
        results: (r) => (!Array.isArray(r.volatility) || !r.volatility.length || r.volatility.some((v) => v.within_band !== true) ? 'every index must be within its volatility band'
            : r.settlement_reconciled !== true ? 'results.settlement_reconciled must be true'
            : r.browser_cli_verdicts_agree !== true ? 'results.browser_cli_verdicts_agree must be true'
            : r.cutover_effective_tick === undefined ? 'results.cutover_effective_tick must be recorded' : null),
    },
});

/**
 * @returns {string[]} problems; empty means the file passes structural validation.
 */
export function validateEvidence(name, evidence, { root = process.cwd(), trustedKeys = null } = {}) {
    const spec = EVIDENCE_TYPES[name];
    if (!spec) return [`unknown evidence type ${name}`];
    const e = evidence || {};
    const problems = [];
    for (const field of ['summary', 'performed_by', 'reviewed_by', 'environment']) if (!nonEmpty(e[field])) problems.push(`${field} is required`);
    if (!/^[0-9a-f]{40}$/.test(e.source_commit || '')) problems.push('source_commit must be a full 40-character commit hash');
    if (!iso(e.interval?.start) || !iso(e.interval?.end)) problems.push('interval.start and interval.end must be UTC ISO timestamps');
    if (!iso(e.reviewed_at)) problems.push('reviewed_at must be a UTC ISO timestamp');
    if (nonEmpty(e.performed_by) && nonEmpty(e.reviewed_by) && e.performed_by.trim().toLowerCase() === e.reviewed_by.trim().toLowerCase()) problems.push('reviewed_by must be a different person from performed_by');
    if (nonEmpty(e.environment) && e.environment !== spec.environment) problems.push(`environment must be ${spec.environment}`);
    if (iso(e.interval?.start) && iso(e.interval?.end)) {
        const span = Date.parse(e.interval.end) - Date.parse(e.interval.start);
        if (span < 0) problems.push('interval ends before it starts');
        if (span < spec.minDays * DAY_MS) problems.push(`interval must cover at least ${spec.minDays} complete days`);
        if (iso(e.reviewed_at) && Date.parse(e.reviewed_at) < Date.parse(e.interval.end)) problems.push('reviewed_at must be after the interval ends');
        if (Date.parse(e.interval.end) > Date.now()) problems.push('interval ends in the future');
    }
    if (!Array.isArray(e.artifacts) || !e.artifacts.length) problems.push('at least one artifact is required');
    for (const [i, a] of (e.artifacts || []).entries()) {
        if (nonEmpty(a.path)) {
            const file = resolve(root, normalize(a.path));
            if (!file.startsWith(resolve(root))) { problems.push(`artifacts[${i}].path escapes the repository`); continue; }
            if (!existsSync(file)) { problems.push(`artifacts[${i}] ${a.path} does not exist`); continue; }
            const digest = createHash('sha256').update(readFileSync(file)).digest('hex');
            if (a.sha256 !== digest) problems.push(`artifacts[${i}] ${a.path} sha256 does not match its contents`);
        } else if (nonEmpty(a.url)) {
            if (!/^https:\/\//.test(a.url)) problems.push(`artifacts[${i}].url must be https`);
            if (!/^[0-9a-f]{64}$/.test(a.sha256 || '') && !nonEmpty(a.immutable_ref)) problems.push(`artifacts[${i}] needs a sha256 or an immutable_ref (object version, log id)`);
            if (!nonEmpty(a.reviewed_by) || a.reviewed_by === e.performed_by) problems.push(`artifacts[${i}] external reference needs an independent reviewed_by`);
        } else problems.push(`artifacts[${i}] needs a path or a url`);
    }
    if (typeof e.results !== 'object' || e.results === null) problems.push('results with measured values are required');
    else {
        let trusted = trustedKeys;
        if (!trusted) { try { trusted = JSON.parse(readFileSync(join(root, 'verifier/v3/trusted-keys.json'), 'utf8')).keys || {}; } catch { trusted = {}; } }
        const failure = spec.results(e.results, { trustedKeys: trusted });
        if (failure) problems.push(failure);
    }
    return problems;
}

export function loadEvidence(name, root = process.cwd()) {
    const file = join(root, 'docs', 'evidence', `${name}.json`);
    if (!existsSync(file)) return { status: 'pending', text: `pending: docs/evidence/${name}.json not recorded` };
    let parsed;
    try { parsed = JSON.parse(readFileSync(file, 'utf8')); } catch (error) { return { status: 'invalid', text: `docs/evidence/${name}.json is not valid JSON: ${error.message}` }; }
    const problems = validateEvidence(name, parsed, { root });
    return problems.length
        ? { status: 'invalid', text: `docs/evidence/${name}.json rejected: ${problems.join('; ')}` }
        : { status: 'met', text: `docs/evidence/${name}.json (${parsed.interval.start} to ${parsed.interval.end}, reviewed by ${parsed.reviewed_by})` };
}
