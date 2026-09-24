// Evaluates the plan's minimum acceptance matrix (docs/CLAUDE_SYNTHETIC_ENGINE_PLAN.md)
// and writes docs/ENGINE_V3_ACCEPTANCE.md.
//
//   node scripts/engine-v3-acceptance.mjs            run the automated evidence, then report
//   node scripts/engine-v3-acceptance.mjs --no-run   report from evidence files only
//
// A row is MET only when every automated check passes AND every operational
// evidence file it needs exists in docs/evidence/ with sign-off fields. This
// script never infers operational facts; it only reads what people recorded.
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = !process.argv.includes('--no-run');
const results = new Map();
function check(name, command, args) {
    if (!run) return results.set(name, { status: 'not run', detail: 'use without --no-run' });
    const started = Date.now();
    // Log to a file, not a pipe: on Windows, database child processes inherit
    // pipe handles and can hold them open after the test process exits.
    const log = join(tmpdir(), `engine-v3-acceptance-${process.pid}-${results.size}.log`);
    const fd = openSync(log, 'w');
    const out = spawnSync(command, args, { stdio: ['ignore', fd, fd], shell: false, timeout: 1_200_000 });
    closeSync(fd);
    const ok = out.status === 0;
    const tail = ok ? '' : `: ${readFileSync(log, 'utf8').trim().split('\n').filter((line) => /✖|Error|fail/i.test(line)).slice(0, 3).join(' | ')}`;
    results.set(name, { status: ok ? 'pass' : 'FAIL', detail: `${((Date.now() - started) / 1000).toFixed(0)} s${tail}` });
}
function calibration() {
    const files = existsSync('docs/calibration') ? readdirSync('docs/calibration').filter((f) => f.startsWith('engine-v3-') && f.endsWith('.json')) : [];
    const runs = files.flatMap((f) => JSON.parse(readFileSync(`docs/calibration/${f}`, 'utf8')).results);
    const failed = runs.filter((r) => !r.pass);
    const years = runs.filter((r) => r.metrics.ticks >= 15_768_000).map((r) => r.metrics.index);
    const ok = runs.length >= 25 && !failed.length && new Set(years).size === 5;
    results.set('calibration', { status: ok ? 'pass' : 'FAIL', detail: `${runs.length} runs, ${failed.length} outside bands, one-year runs for ${new Set(years).size}/5 indices` });
}

const EVIDENCE = {
    'kms-provisioning': 'KMS key created with the ADR 0002 D2 policy; administrator Decrypt denied (tested); CloudTrail alert on foreign Decrypt fired in a test.',
    'worker-deployment': 'Worker running in a cloud account separate from the database, custody provider kms:aws, session-mode connection, signing key published in verifier/v3/trusted-keys.json.',
    'shadow-run': 'At least 7 days of shadow ticks for every index: no sequence gaps, both witnesses on every epoch before its first tick, checkpoints within 300 ticks, lag within policy.',
    'live-drills': 'Staging drills performed and logged: KMS permission revoked, both TSAs blocked, worker killed mid-cycle, clock skewed; each produced the documented outcome.',
    'practice-soak': 'At least 7 days after Practice cutover: observed volatility within the pre-registered bands (scripts/engine-v3-soak-report.mjs output attached), settlement reconciled.',
};
function evidence(name) {
    const file = `docs/evidence/${name}.json`;
    if (!existsSync(file)) return { ok: false, text: `pending (${file})` };
    const e = JSON.parse(readFileSync(file, 'utf8'));
    const missing = ['completed_at', 'performed_by', 'reviewed_by', 'summary'].filter((k) => !e[k]);
    return missing.length ? { ok: false, text: `${file} incomplete (${missing.join(', ')})` } : { ok: true, text: `${file} (${e.completed_at}, reviewed by ${e.reviewed_by})` };
}

check('unit: engine-v3', process.execPath, ['--test', 'tests/engine-v3.test.mjs']);
check('vectors: frozen', process.execPath, ['scripts/engine-v3-vectors.mjs']);
check('sql: pgcrypto parity', process.execPath, ['scripts/test-engine-postgres.mjs']);
check('integration: worker + publication', process.execPath, ['--test', '--test-timeout=180000', 'tests/engine-v3-service.test.mjs']);
check('witness, custody, production guards', process.execPath, ['--test', 'tests/engine-v3-witness.test.mjs']);
check('ui: fairness v3', process.execPath, ['--test', 'tests/fairness-v3-ui.test.mjs']);
check('regression: engine suites', process.execPath, ['--test', '--test-concurrency=1', 'tests/engine-core.test.mjs', 'tests/engine-permissions.test.mjs', 'tests/fairness-ui.test.mjs', 'tests/engine-guardrails.test.mjs']);
calibration();

const MATRIX = [
    ['Cryptographic reproducibility', ['unit: engine-v3', 'vectors: frozen', 'sql: pgcrypto parity'], []],
    ['Secret protection', ['integration: worker + publication', 'witness, custody, production guards'], ['kms-provisioning', 'worker-deployment']],
    ['Advance commitment', ['integration: worker + publication', 'witness, custody, production guards'], ['shadow-run']],
    ['Price integrity', ['integration: worker + publication'], ['shadow-run']],
    ['Contract integrity', ['integration: worker + publication', 'regression: engine suites'], ['practice-soak']],
    ['Volatility', ['calibration'], ['practice-soak']],
    ['Failure recovery', ['integration: worker + publication'], ['live-drills']],
    ['Historical compatibility', ['sql: pgcrypto parity', 'regression: engine suites'], []],
    ['Permissions', ['integration: worker + publication', 'witness, custody, production guards'], ['kms-provisioning']],
    ['Verification UX', ['unit: engine-v3', 'integration: worker + publication', 'ui: fairness v3'], []],
];

const rows = MATRIX.map(([area, checks, external]) => {
    const auto = checks.map((name) => results.get(name));
    const autoOk = auto.every((r) => r.status === 'pass');
    const ext = external.map(evidence);
    const extOk = ext.every((e) => e.ok);
    const status = autoOk && extOk ? 'MET' : !autoOk ? (auto.some((r) => r.status === 'FAIL') ? 'FAILING' : 'NOT RUN') : 'BUILT, awaiting operational evidence';
    return { area, status, auto: checks.map((name, i) => `${name}: ${auto[i].status}`), ext: ext.map((e) => e.text) };
});

const lines = [
    '# Engine v3 acceptance matrix', '',
    `Generated ${new Date().toISOString()} by \`node scripts/engine-v3-acceptance.mjs${run ? '' : ' --no-run'}\`. Rows are MET only when automated checks pass **and** the operational evidence the plan requires has been recorded and reviewed in \`docs/evidence/\`. This file does not enable any index or REAL.`, '',
    '| Area | Status | Automated evidence | Operational evidence |', '| --- | --- | --- | --- |',
    ...rows.map((r) => `| ${r.area} | **${r.status}** | ${r.auto.join('<br>')} | ${r.ext.length ? r.ext.join('<br>') : 'none required'} |`), '',
    '## Automated checks', '', '| Check | Result |', '| --- | --- |',
    ...[...results].map(([name, r]) => `| ${name} | ${r.status} (${r.detail}) |`), '',
    '## Operational evidence files', '',
    'Each is a reviewed commit of `docs/evidence/<name>.json` with `completed_at`, `performed_by`, `reviewed_by`, `summary` and `artifacts` (links to logs, dashboards or reports). Record only work that happened.', '',
    ...Object.entries(EVIDENCE).map(([name, need]) => `- \`${name}\`: ${need}`), '',
    '## Not covered by this matrix', '',
    '- Phase 4 REAL readiness (external cryptographic and quantitative review, custody penetration test, multi-operator incident procedure, accounting reconciliation) stays a separate decision under `docs/REAL_READINESS_CHECKLIST.md`.', '',
];
writeFileSync('docs/ENGINE_V3_ACCEPTANCE.md', lines.join('\n'));
for (const r of rows) console.log(`${r.status.padEnd(38)} ${r.area}`);
process.exitCode = rows.some((r) => r.status === 'FAILING') ? 1 : 0;
