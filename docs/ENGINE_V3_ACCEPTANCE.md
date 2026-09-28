# Engine v3 acceptance matrix

Generated 2026-09-28T02:32:59.777Z on commit `9f8d0e42674af0df6656d3f182fa6c74bd29feb7` by `node scripts/engine-v3-acceptance.mjs`.

## Release status

- **CODE_READY**: NO: independent code review pending
- **PRACTICE_READY**: NO: CODE_READY is not met; kms-provisioning pending; worker-deployment pending; shadow-run pending; live-drills pending; practice-soak pending
- **REAL_READY**: NO: funded operation is a separate decision under docs/REAL_READINESS_CHECKLIST.md and is never enabled by this script

A row is MET only when its automated checks pass on this commit **and** every operational evidence file it needs passes `scripts/engine-v3-evidence.mjs` (artifact hashes, environment, window length, independent reviewer, measured results). That validation is structural. It is not cryptographic proof that the work was performed; that rests on the named reviewer and the reviewed commit adding the file. Nothing here enables an index or REAL.

| Area | Status | Automated evidence | Operational evidence |
| --- | --- | --- | --- |
| Cryptographic reproducibility | **MET** | frozen vectors: pass<br>SQL pgcrypto parity on real PostgreSQL: pass<br>v3 unit and vectors: pass | none required |
| Secret protection | **CODE PASSES; OPERATIONAL EVIDENCE PENDING** | worker and publication (real PostgreSQL): pass<br>custody, KMS SDK, signing, production guards: pass | pending: docs/evidence/kms-provisioning.json not recorded<br>pending: docs/evidence/worker-deployment.json not recorded |
| Advance commitment | **CODE PASSES; OPERATIONAL EVIDENCE PENDING** | witness attestation and purchase gate (real PostgreSQL): pass<br>proof export and verifier: pass | pending: docs/evidence/shadow-run.json not recorded |
| Price integrity | **CODE PASSES; OPERATIONAL EVIDENCE PENDING** | worker and publication (real PostgreSQL): pass<br>proof export and verifier: pass | pending: docs/evidence/shadow-run.json not recorded |
| Contract integrity | **CODE PASSES; OPERATIONAL EVIDENCE PENDING** | worker and publication (real PostgreSQL): pass<br>witness attestation and purchase gate (real PostgreSQL): pass<br>full regression suite (all other tests): pass | pending: docs/evidence/practice-soak.json not recorded |
| Volatility | **CODE PASSES; OPERATIONAL EVIDENCE PENDING** | calibration (current generator): pass | pending: docs/evidence/practice-soak.json not recorded |
| Failure recovery | **CODE PASSES; OPERATIONAL EVIDENCE PENDING** | worker and publication (real PostgreSQL): pass<br>witness attestation and purchase gate (real PostgreSQL): pass | pending: docs/evidence/live-drills.json not recorded |
| Historical compatibility | **MET** | migrations onto v1/v2 history: pass<br>SQL pgcrypto parity on real PostgreSQL: pass<br>full regression suite (all other tests): pass | none required |
| Permissions | **CODE PASSES; OPERATIONAL EVIDENCE PENDING** | worker and publication (real PostgreSQL): pass<br>witness attestation and purchase gate (real PostgreSQL): pass<br>custody, KMS SDK, signing, production guards: pass | pending: docs/evidence/kms-provisioning.json not recorded |
| Verification UX | **MET** | proof export and verifier: pass<br>real-browser checks (Edge): pass<br>production build: pass | none required |

## Automated gates

| Gate | Result |
| --- | --- |
| production build | pass (1 s) |
| migration parity rules | pass (11 s) |
| frozen vectors | pass (6 s) |
| SQL pgcrypto parity on real PostgreSQL | pass (19 s) |
| real-PostgreSQL replacement for PGlite skips | pass (25 s) |
| v3 unit and vectors | pass (2 s) |
| proof export and verifier | pass (4 s) |
| worker and publication (real PostgreSQL) | pass (63 s) |
| witness attestation and purchase gate (real PostgreSQL) | pass (38 s) |
| custody, KMS SDK, signing, production guards | pass (19 s) |
| migrations onto v1/v2 history | pass (22 s) |
| real-browser checks (Edge) | pass (47 s) |
| evidence validator | pass (1 s) |
| PGlite-skip replacement (listed so it is not rerun below) | pass (16 s) |
| full regression suite (all other tests) | pass (510 s) |
| calibration (current generator) | pass (25 runs (20 x 1M, one-year for 5/5 indices), 0 outside bands, 0 report(s) from another generator revision) |

## Recorded evidence

- `code-review`: pending: docs/evidence/code-review.json not recorded
- `kms-provisioning`: pending: docs/evidence/kms-provisioning.json not recorded
- `worker-deployment`: pending: docs/evidence/worker-deployment.json not recorded
- `shadow-run`: pending: docs/evidence/shadow-run.json not recorded
- `live-drills`: pending: docs/evidence/live-drills.json not recorded
- `practice-soak`: pending: docs/evidence/practice-soak.json not recorded

Evidence files are reviewed commits of `docs/evidence/<name>.json`. The schema and per-type thresholds are in `scripts/engine-v3-evidence.mjs`, and the procedures are in `docs/runbooks/engine-v3.md` §11. Record only work that happened, over real elapsed time.
