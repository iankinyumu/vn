// Release status for engine v3 (production fix brief, decision 1 and §5):
//
//   CODE_READY      every automated gate passes on this commit (full suite on real
//                   PostgreSQL, production build, browser checks, fresh calibration)
//                   AND an independent code review is recorded.
//   PRACTICE_READY  CODE_READY AND every operational evidence file is recorded and valid.
//   REAL_READY      never set here; see docs/REAL_READINESS_CHECKLIST.md.
//
//   node scripts/engine-v3-acceptance.mjs              exit 0 only when CODE_READY
//   node scripts/engine-v3-acceptance.mjs --practice   exit 0 only when PRACTICE_READY
//   node scripts/engine-v3-acceptance.mjs --no-run     report from recorded state only (exits 1)
//
// Writes docs/ENGINE_V3_ACCEPTANCE.md. It never infers operational facts.
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEvidence } from './engine-v3-evidence.mjs';

const args = process.argv.slice(2);
const run = !args.includes('--no-run');
const practice = args.includes('--practice');
const results = new Map();
const git = (...a) => spawnSync('git', a, { encoding: 'utf8' }).stdout.trim();
const commit = git('rev-parse', 'HEAD');
const dirty = git('status', '--porcelain', '--', 'engine', 'verifier', 'supabase/migrations', 'assets/js', 'scripts', 'tests') !== '';

// A skip is not a pass. The only tolerated skip is one whose identical check has
// passed on real PostgreSQL in this run (brief: "a skipped test remains open until
// that run succeeds").
const COVERED_SKIPS = { 'engine advances deterministic ticks with the price-digit invariant': 'real-PostgreSQL replacement for PGlite skips' };
function check(name, command, commandArgs, env = {}) {
    if (!run) return results.set(name, { status: 'not run', detail: '--no-run' });
    const started = Date.now();
    // Log to a file, not a pipe: database child processes inherit pipe handles on Windows.
    const log = join(tmpdir(), `engine-v3-acceptance-${process.pid}-${results.size}.log`);
    const fd = openSync(log, 'w');
    const out = spawnSync(command, commandArgs, { stdio: ['ignore', fd, fd], shell: process.platform === 'win32' && command === 'npm', timeout: 1_800_000, env: { ...process.env, ...env } });
    closeSync(fd);
    const text = readFileSync(log, 'utf8');
    const skippedTitles = [...text.matchAll(/^﹣ (.+?) \([\d.]+ms\) # /gm)].map((m) => m[1]);
    const uncovered = skippedTitles.filter((title) => !(COVERED_SKIPS[title] && results.get(COVERED_SKIPS[title])?.status === 'pass'));
    const skipCount = Number(/ℹ skipped (\d+)/.exec(text)?.[1] || 0);
    const ok = out.status === 0 && skipCount === skippedTitles.length && uncovered.length === 0;
    const skipped = skipCount && !ok ? [null, skipCount] : null;
    const tail = ok ? '' : `: ${skipped ? `${skipped[1]} skipped (a skip is not a pass)` : text.trim().split('\n').filter((l) => /✖|Error|fail/i.test(l)).slice(0, 3).join(' | ')}`;
    results.set(name, { status: ok ? 'pass' : 'FAIL', detail: `${((Date.now() - started) / 1000).toFixed(0)} s${tail}` });
}

function calibration() {
    const current = createHash('sha256').update(readFileSync('engine/v3/generator.mjs', 'utf8').split('\r\n').join('\n')).digest('hex');
    const files = existsSync('docs/calibration') ? readdirSync('docs/calibration').filter((f) => /^engine-v3-.*\.json$/.test(f)) : [];
    const reports = files.map((f) => JSON.parse(readFileSync(`docs/calibration/${f}`, 'utf8')));
    const stale = reports.filter((r) => r.generator_sha256 !== current).length;
    const runs = reports.flatMap((r) => r.results);
    const failed = runs.filter((r) => !r.pass).length;
    const million = runs.filter((r) => r.metrics.ticks >= 1_000_000 && r.metrics.ticks < 15_768_000).length;
    const years = new Set(runs.filter((r) => r.metrics.ticks >= 15_768_000).map((r) => r.metrics.index)).size;
    const ok = reports.length && !stale && !failed && million >= 20 && years === 5;
    results.set('calibration (current generator)', { status: ok ? 'pass' : 'FAIL',
        detail: `${runs.length} runs (${million} x 1M, one-year for ${years}/5 indices), ${failed} outside bands, ${stale} report(s) from another generator revision` });
}

// ---- automated gates (CODE_READY) ----
const node = process.execPath;
check('production build', node, ['scripts/build-static.mjs']);
check('migration parity rules', node, ['scripts/check-parity.mjs']);
check('frozen vectors', node, ['scripts/engine-v3-vectors.mjs']);
check('SQL pgcrypto parity on real PostgreSQL', node, ['scripts/test-engine-postgres.mjs']);
check('real-PostgreSQL replacement for PGlite skips', node, ['--test', '--test-reporter=spec', 'tests/engine-core-realpg.test.mjs']);
const suites = {
    'v3 unit and vectors': ['tests/engine-v3.test.mjs'],
    'proof export and verifier': ['tests/engine-v3-proof.test.mjs'],
    'worker and publication (real PostgreSQL)': ['tests/engine-v3-service.test.mjs'],
    'witness attestation and purchase gate (real PostgreSQL)': ['tests/engine-v3-witness-gate.test.mjs'],
    'custody, KMS SDK, signing, production guards': ['tests/engine-v3-witness.test.mjs'],
    'migrations onto v1/v2 history': ['tests/engine-v3-migrations.test.mjs'],
    'real-browser checks (Edge)': ['tests/engine-v3-browser.test.mjs'],
    'evidence validator': ['tests/engine-v3-evidence.test.mjs'],
    'PGlite-skip replacement (listed so it is not rerun below)': ['tests/engine-core-realpg.test.mjs'],
};
for (const [name, files] of Object.entries(suites)) check(name, node, ['--test', '--test-concurrency=1', '--test-timeout=300000', ...files]);
const others = readdirSync('tests').filter((f) => f.endsWith('.test.mjs') && !Object.values(suites).flat().includes(`tests/${f}`)).map((f) => `tests/${f}`);
check('full regression suite (all other tests)', node, ['--test', '--test-reporter=spec', '--test-concurrency=1', ...others]);
calibration();

// ---- evidence ----
const evidence = Object.fromEntries(['code-review', 'kms-provisioning', 'worker-deployment', 'shadow-run', 'live-drills', 'practice-soak'].map((n) => [n, loadEvidence(n)]));

const MATRIX = [
    ['Cryptographic reproducibility', ['frozen vectors', 'SQL pgcrypto parity on real PostgreSQL', 'v3 unit and vectors'], []],
    ['Secret protection', ['worker and publication (real PostgreSQL)', 'custody, KMS SDK, signing, production guards'], ['kms-provisioning', 'worker-deployment']],
    ['Advance commitment', ['witness attestation and purchase gate (real PostgreSQL)', 'proof export and verifier'], ['shadow-run']],
    ['Price integrity', ['worker and publication (real PostgreSQL)', 'proof export and verifier'], ['shadow-run']],
    ['Contract integrity', ['worker and publication (real PostgreSQL)', 'witness attestation and purchase gate (real PostgreSQL)', 'full regression suite (all other tests)'], ['practice-soak']],
    ['Volatility', ['calibration (current generator)'], ['practice-soak']],
    ['Failure recovery', ['worker and publication (real PostgreSQL)', 'witness attestation and purchase gate (real PostgreSQL)'], ['live-drills']],
    ['Historical compatibility', ['migrations onto v1/v2 history', 'SQL pgcrypto parity on real PostgreSQL', 'full regression suite (all other tests)'], []],
    ['Permissions', ['worker and publication (real PostgreSQL)', 'witness attestation and purchase gate (real PostgreSQL)', 'custody, KMS SDK, signing, production guards'], ['kms-provisioning']],
    ['Verification UX', ['proof export and verifier', 'real-browser checks (Edge)', 'production build'], []],
];
const rows = MATRIX.map(([area, checks, external]) => {
    const auto = checks.map((n) => results.get(n));
    const autoOk = auto.every((r) => r.status === 'pass');
    const ext = external.map((n) => evidence[n]);
    const status = !autoOk ? (auto.some((r) => r.status === 'FAIL') ? 'FAILING' : 'NOT RUN')
        : ext.some((e) => e.status === 'invalid') ? 'EVIDENCE REJECTED'
        : ext.every((e) => e.status === 'met') ? 'MET' : 'CODE PASSES; OPERATIONAL EVIDENCE PENDING';
    return { area, status, auto: checks.map((n, i) => `${n}: ${auto[i].status}`), ext: ext.map((e) => e.text) };
});

const automatedOk = [...results.values()].every((r) => r.status === 'pass');
const codeReady = automatedOk && !dirty && evidence['code-review'].status === 'met';
const practiceReady = codeReady && rows.every((r) => r.status === 'MET');
const why = (ok, reasons) => (ok ? 'YES' : `NO: ${reasons.filter(Boolean).join('; ')}`);
const status = {
    CODE_READY: why(codeReady, [!automatedOk && 'an automated gate did not pass', dirty && 'engine, verifier, migration, UI, script or test files have uncommitted changes', evidence['code-review'].status !== 'met' && `independent code review ${evidence['code-review'].status}`]),
    PRACTICE_READY: why(practiceReady, [!codeReady && 'CODE_READY is not met', ...['kms-provisioning', 'worker-deployment', 'shadow-run', 'live-drills', 'practice-soak'].filter((n) => evidence[n].status !== 'met').map((n) => `${n} ${evidence[n].status}`)]),
    REAL_READY: 'NO: funded operation is a separate decision under docs/REAL_READINESS_CHECKLIST.md and is never enabled by this script',
};

const lines = [
    '# Engine v3 acceptance matrix', '',
    `Generated ${new Date().toISOString()} on commit \`${commit}\`${dirty ? ' (with uncommitted engine changes)' : ''} by \`node scripts/engine-v3-acceptance.mjs${run ? '' : ' --no-run'}\`.`, '',
    '## Release status', '',
    ...Object.entries(status).map(([k, v]) => `- **${k}**: ${v}`), '',
    'A row is MET only when its automated checks pass on this commit **and** every operational evidence file it needs passes `scripts/engine-v3-evidence.mjs` (artifact hashes, environment, window length, independent reviewer, measured results). That validation is structural. It is not cryptographic proof that the work was performed; that rests on the named reviewer and the reviewed commit adding the file. Nothing here enables an index or REAL.', '',
    '| Area | Status | Automated evidence | Operational evidence |', '| --- | --- | --- | --- |',
    ...rows.map((r) => `| ${r.area} | **${r.status}** | ${r.auto.join('<br>')} | ${r.ext.length ? r.ext.join('<br>') : 'none required'} |`), '',
    '## Automated gates', '', '| Gate | Result |', '| --- | --- |',
    ...[...results].map(([n, r]) => `| ${n} | ${r.status} (${r.detail}) |`), '',
    '## Recorded evidence', '',
    ...Object.entries(evidence).map(([n, e]) => `- \`${n}\`: ${e.text}`), '',
    'Evidence files are reviewed commits of `docs/evidence/<name>.json`. The schema and per-type thresholds are in `scripts/engine-v3-evidence.mjs`, and the procedures are in `docs/runbooks/engine-v3.md` §11. Record only work that happened, over real elapsed time.', '',
];
writeFileSync('docs/ENGINE_V3_ACCEPTANCE.md', lines.join('\n'));
for (const r of rows) console.log(`${r.status.padEnd(44)} ${r.area}`);
for (const [k, v] of Object.entries(status)) console.log(`${k}: ${v}`);
process.exitCode = (practice ? practiceReady : codeReady) ? 0 : 1;
