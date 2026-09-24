# Engine v3 acceptance matrix

Generated 2026-09-24T10:47:32.021Z by `node scripts/engine-v3-acceptance.mjs`. Rows are MET only when automated checks pass **and** the operational evidence the plan requires has been recorded and reviewed in `docs/evidence/`. This file does not enable any index or REAL.

| Area | Status | Automated evidence | Operational evidence |
| --- | --- | --- | --- |
| Cryptographic reproducibility | **MET** | unit: engine-v3: pass<br>vectors: frozen: pass<br>sql: pgcrypto parity: pass | none required |
| Secret protection | **BUILT, awaiting operational evidence** | integration: worker + publication: pass<br>witness, custody, production guards: pass | pending (docs/evidence/kms-provisioning.json)<br>pending (docs/evidence/worker-deployment.json) |
| Advance commitment | **BUILT, awaiting operational evidence** | integration: worker + publication: pass<br>witness, custody, production guards: pass | pending (docs/evidence/shadow-run.json) |
| Price integrity | **BUILT, awaiting operational evidence** | integration: worker + publication: pass | pending (docs/evidence/shadow-run.json) |
| Contract integrity | **BUILT, awaiting operational evidence** | integration: worker + publication: pass<br>regression: engine suites: pass | pending (docs/evidence/practice-soak.json) |
| Volatility | **BUILT, awaiting operational evidence** | calibration: pass | pending (docs/evidence/practice-soak.json) |
| Failure recovery | **BUILT, awaiting operational evidence** | integration: worker + publication: pass | pending (docs/evidence/live-drills.json) |
| Historical compatibility | **MET** | sql: pgcrypto parity: pass<br>regression: engine suites: pass | none required |
| Permissions | **BUILT, awaiting operational evidence** | integration: worker + publication: pass<br>witness, custody, production guards: pass | pending (docs/evidence/kms-provisioning.json) |
| Verification UX | **MET** | unit: engine-v3: pass<br>integration: worker + publication: pass<br>ui: fairness v3: pass | none required |

## Automated checks

| Check | Result |
| --- | --- |
| unit: engine-v3 | pass (3 s) |
| vectors: frozen | pass (0 s) |
| sql: pgcrypto parity | pass (36 s) |
| integration: worker + publication | pass (86 s) |
| witness, custody, production guards | pass (21 s) |
| ui: fairness v3 | pass (1 s) |
| regression: engine suites | pass (95 s) |
| calibration | pass (25 runs, 0 outside bands, one-year runs for 5/5 indices) |

## Operational evidence files

Each is a reviewed commit of `docs/evidence/<name>.json` with `completed_at`, `performed_by`, `reviewed_by`, `summary` and `artifacts` (links to logs, dashboards or reports). Record only work that happened.

- `kms-provisioning`: KMS key created with the ADR 0002 D2 policy; administrator Decrypt denied (tested); CloudTrail alert on foreign Decrypt fired in a test.
- `worker-deployment`: Worker running in a cloud account separate from the database, custody provider kms:aws, session-mode connection, signing key published in verifier/v3/trusted-keys.json.
- `shadow-run`: At least 7 days of shadow ticks for every index: no sequence gaps, both witnesses on every epoch before its first tick, checkpoints within 300 ticks, lag within policy.
- `live-drills`: Staging drills performed and logged: KMS permission revoked, both TSAs blocked, worker killed mid-cycle, clock skewed; each produced the documented outcome.
- `practice-soak`: At least 7 days after Practice cutover: observed volatility within the pre-registered bands (scripts/engine-v3-soak-report.mjs output attached), settlement reconciled.

## Not covered by this matrix

- Phase 4 REAL readiness (external cryptographic and quantitative review, custody penetration test, multi-operator incident procedure, accounting reconciliation) stays a separate decision under `docs/REAL_READINESS_CHECKLIST.md`.
