// Negative and positive tests for the operational evidence validator.
// The "valid" fixtures here are synthetic and live only in a temp directory:
// they test the validator and are never written to docs/evidence/.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadEvidence, validateEvidence } from '../scripts/engine-v3-evidence.mjs';

function sandbox() {
    const root = mkdtempSync(join(tmpdir(), 'v3-evidence-'));
    mkdirSync(join(root, 'artifacts'));
    const body = 'shadow report: 7 days, 0 gaps';
    writeFileSync(join(root, 'artifacts', 'report.txt'), body);
    return { root, sha: createHash('sha256').update(body).digest('hex') };
}
const shadow = (sha, overrides = {}) => ({
    summary: 'Seven-day shadow run of all five indices', environment: 'production', performed_by: 'Operator A', reviewed_by: 'Reviewer B',
    source_commit: 'a'.repeat(40), interval: { start: '2026-01-01T00:00:00Z', end: '2026-01-08T00:00:00Z' }, reviewed_at: '2026-01-09T10:00:00Z',
    artifacts: [{ path: 'artifacts/report.txt', sha256: sha }],
    results: { sequence_gaps: 0, epochs_total: 7, epochs_witnessed_before_deadline: 7, max_checkpoint_gap_ticks: 150, lag_p99_seconds: 2.1 }, ...overrides,
});

test('a complete, internally consistent record passes structural validation', () => {
    const { root, sha } = sandbox();
    assert.deepEqual(validateEvidence('shadow-run', shadow(sha), { root }), []);
});

test('empty, fabricated, mismatched, short, wrong-environment and self-reviewed records are rejected', () => {
    const { root, sha } = sandbox();
    const cases = {
        'empty strings': shadow(sha, { summary: '', performed_by: '  ', reviewed_by: '' }),
        'missing artifact': shadow(sha, { artifacts: [{ path: 'artifacts/does-not-exist.txt', sha256: sha }] }),
        'fabricated hash': shadow(sha, { artifacts: [{ path: 'artifacts/report.txt', sha256: 'f'.repeat(64) }] }),
        'no artifacts': shadow(sha, { artifacts: [] }),
        'path escape': shadow(sha, { artifacts: [{ path: '../../etc/hosts', sha256: sha }] }),
        'too short': shadow(sha, { interval: { start: '2026-01-01T00:00:00Z', end: '2026-01-06T00:00:00Z' } }),
        'wrong environment': shadow(sha, { environment: 'staging' }),
        'self review': shadow(sha, { reviewed_by: 'operator a' }),
        'review before end': shadow(sha, { reviewed_at: '2026-01-07T00:00:00Z' }),
        'future interval': shadow(sha, { interval: { start: '2099-01-01T00:00:00Z', end: '2099-01-09T00:00:00Z' }, reviewed_at: '2099-01-10T00:00:00Z' }),
        'short commit': shadow(sha, { source_commit: 'abc123' }),
        'failing results': shadow(sha, { results: { sequence_gaps: 3, epochs_total: 7, epochs_witnessed_before_deadline: 7, max_checkpoint_gap_ticks: 150, lag_p99_seconds: 2 } }),
        'unwitnessed epoch': shadow(sha, { results: { sequence_gaps: 0, epochs_total: 7, epochs_witnessed_before_deadline: 6, max_checkpoint_gap_ticks: 150, lag_p99_seconds: 2 } }),
        'no results': shadow(sha, { results: null }),
        'unreviewed external link': shadow(sha, { artifacts: [{ url: 'https://example.com/log', immutable_ref: 'v1' }] }),
        'external link without integrity': shadow(sha, { artifacts: [{ url: 'https://example.com/log', reviewed_by: 'Reviewer B' }] }),
    };
    for (const [name, record] of Object.entries(cases)) assert.ok(validateEvidence('shadow-run', record, { root }).length > 0, `${name} must be rejected`);
});

test('type-specific rules: drills, deployment key publication and KMS proof', () => {
    const { root, sha } = sandbox();
    const base = { summary: 's', performed_by: 'A', reviewed_by: 'B', source_commit: 'b'.repeat(40), interval: { start: '2026-01-01T00:00:00Z', end: '2026-01-01T06:00:00Z' },
        reviewed_at: '2026-01-02T00:00:00Z', artifacts: [{ path: 'artifacts/report.txt', sha256: sha }] };
    const drills = ['kms_revoke', 'tsa_block', 'worker_kill', 'clock_skew', 'lost_reply'].map((name) => ({ name, outcome: 'as_documented', observed: 'purchases failed closed; recovered' }));
    assert.deepEqual(validateEvidence('live-drills', { ...base, environment: 'staging', results: { drills } }, { root }), []);
    assert.ok(validateEvidence('live-drills', { ...base, environment: 'staging', results: { drills: drills.slice(1) } }, { root }).some((p) => /kms_revoke missing/.test(p)));
    const deployment = { ...base, environment: 'production', results: { custody_provider: 'kms:aws', separate_cloud_account: true, attestor_separate_credentials: true, preflight_passed: true, published_key_id: 'ed25519-2026-10-1' } };
    assert.ok(validateEvidence('worker-deployment', deployment, { root, trustedKeys: {} }).some((p) => /not in verifier\/v3\/trusted-keys.json/.test(p)), 'the key must really be published');
    assert.deepEqual(validateEvidence('worker-deployment', deployment, { root, trustedKeys: { 'ed25519-2026-10-1': 'ab'.repeat(32) } }), []);
    assert.ok(validateEvidence('kms-provisioning', { ...base, environment: 'production', results: { key_arn: 'not-an-arn', admin_decrypt_denied: true, foreign_decrypt_alert_fired: true, cloudtrail_data_events: true } }, { root }).length > 0);
});

test('the repository holds no operational evidence yet, so every external row is pending, not met', () => {
    for (const name of ['kms-provisioning', 'worker-deployment', 'shadow-run', 'live-drills', 'practice-soak']) assert.equal(loadEvidence(name).status, 'pending', name);
});
