# Real mode and Daraja sandbox: Phase 1–2 handoff

**Plan:** `docs/CLAUDE_REAL_MODE_DARAJA_SANDBOX_AUDIT_PLAN.md`. **Performer:** Claude. **Reviewer:** Owner. Review is pending, and no status below is accepted until the Owner records their identity and review time.

## 1. Source and environment

- **Source:** branch `feat/restore-customer-ui`. The work starts from `9ea140c`, and the Phase 2 commit follows `edf5c47`. The exact commit hash is recorded in the git log entry that adds this file.
- **Deployed environment:** Supabase project `cdaxvkpmgqjfukbtrzys`. **Nothing from this work is deployed.**
  - No migration was pushed and no function was deployed. No Daraja secret exists in the project (Phase 0 §1).
  - The deployed Real-gate state, migration head and site deployment commit remain **unknown**. The read-only database query was not permitted in this session.

Everything below comes from the repository and local tests only.

## 2. Files changed and design decisions

| Area | Files |
| --- | --- |
| Baseline, F2 and design | `docs/REAL_MODE_PHASE0_BASELINE.md`, `docs/runbooks/legacy-function-decommission.md`, `docs/REAL_FUNDING_DESIGN.md` |
| Database | `supabase/migrations/20260926100000_funding_foundation.sql` (schema `funding`, immutable records, balanced sandbox USD ledger, KES clearing, treasury, two-person staff actions, `funding.read`/`funding.manage` capabilities) and `20260926110000_funding_rpc.sql` (state machine, customer, service and staff RPCs, grants) |
| Provider adapter | `supabase/functions/_shared/daraja.mjs`: environment-separated config, OAuth, STK Push, STK Push Query, callback parser |
| Flow | `supabase/functions/_shared/funding-flow.mjs`: initiate, callback, verify, sweep |
| Edge Functions | `funding-deposit` (JWT), `daraja-callback` (public, token-bound), `funding-reconcile` (cron secret). `supabase/config.toml` sets `verify_jwt = false` for the latter two |
| Errors | `supabase/functions/_shared/errors.mjs`: customer-safe funding codes |
| Tests | `tests/daraja-adapter.test.mjs`, `tests/funding-sandbox.test.mjs`. `tests/helpers/pg-real.mjs` adds `FUNDING_MIGRATIONS` and sets `io_method=sync` |
| Tests (updated) | `tests/engine-v2-cutover.test.mjs`: the pending migration set now includes the two funding migrations |
| Docs | `docs/runbooks/daraja-sandbox.md`, and `docs/ACCOUNT_TYPES.md` (one sentence corrected) |

**Test harness fix.** PostgreSQL 18 starts `io_worker` processes on demand. On Windows, `taskkill /t` sometimes missed one, and the orphan held the server's stdio pipes, so a real-PostgreSQL test process never exited. The funding suite hung in 2 of 5 runs before the fix and in 0 of 6 after it. Orphaned `postgres.exe --forkchild="io_worker"` processes from the hung runs are still running on this machine. Stopping them was not permitted in this session (see §7).

**Owner-owned files.** The plan file `docs/CLAUDE_REAL_MODE_DARAJA_SANDBOX_AUDIT_PLAN.md` was left unmodified and uncommitted.

## 3. Findings (ranked)

| # | Severity | Finding | Status |
| --- | --- | --- | --- |
| F1 | High (before any Real release) | `enable_real_accounts` checks only the format of evidence strings (`20260920500000_engine_permissions_hardening.sql:58-61`) | Open. Scheduled for Phase 3 per the plan. The gate stays closed |
| F2 | Medium | Legacy `refresh-market-quote` (deployed code **older** than the archive) lets any registered user make the platform write `market_snapshots` rows with the service role and call external APIs | Evidence captured. Deletion awaits Owner go-ahead (runbook) |
| P2-1 | Medium (open item) | The Daraja documentation revision could not be pinned: the portal is client-rendered | The Owner must confirm the contract (design §1) |
| P2-2 | Low | The Deno wrappers (`*/index.ts`) are not type-checked or run locally: Deno is not installed | Covered only through the shared `.mjs` modules they call |
| P2-3 | Low | The CBK rate is published manually. New quotes stop 72 h after the end of the rate date | By design. The runbook adds a daily owner task |

## 4. Tests run

**Environment:** Windows 11, Node v24.20.0, embedded-postgres 18.4.0-beta.17 (real PostgreSQL 18 with real pgcrypto). No PGlite was used for the funding tests.

| Command | Result |
| --- | --- |
| `node --test --test-concurrency=1 tests/daraja-adapter.test.mjs tests/funding-sandbox.test.mjs` | 24/24 pass: 9 adapter and 15 funding |
| `node --test --test-concurrency=1 tests/funding-sandbox.test.mjs`, 6 consecutive runs after the `io_method=sync` fix | 15/15 pass on each run. No hang. 19–47 s per run |
| `node --test tests/engine-core-realpg.test.mjs`, 3 runs (harness comparison, before the fix) | 1/1 pass on each run |
| `npm test` (full suite) | **Incomplete.** Claude Code stopped it for low system memory partway through. Before the stop, the parity and PostgreSQL vector harness passed and 72 tests passed with no assertion failure. The ~25 files listed as `✖ … (~30 ms) 'test failed'` were aborted when the runner was killed and never reached an assertion. **The full suite must be re-run**, in particular `tests/engine-v2-cutover.test.mjs`, whose pending migration set now includes the funding migrations (its CLI `db push` rehearsal will apply them) |

Not run: `npm ci`, `npm run build`, the browser checks, and any Deno type-check or run of `supabase/functions/*/index.ts`.

## 5. Daraja sandbox coverage

Automated coverage uses a scripted Daraja double on real PostgreSQL. No live sandbox call has been made: the credentials, test shortcode, passkey and MSISDN have not been configured.

| Scenario (plan) | Covered by |
| --- | --- |
| Valid initiation, valid callback, credit once | `happy path` |
| Replay / duplicate callback | `happy path` (3 replays, `duplicate_count` 3, one credit) |
| Forged callback, missing or wrong token | `forged callbacks…` |
| Malformed payload | `malformed callback…` |
| Altered amount, reused receipt, checkout conflict | `altered amount…` |
| Callback success vs status failure | `altered amount…` |
| Lost callback, status-only confirmation (`receipt_pending`) | `forged callbacks…` (sweep) |
| Timeout / unknown initiation, callback after client timeout | `ambiguous initiation…`, `time rules…` |
| Provider outage (query errors past 24 h) | `time rules…` |
| Provider rejection, OAuth failure | `provider rejection…`, adapter `OAuth failure` |
| Late / out-of-order facts after a final state | `late and conflicting…` |
| Idempotent retry, no re-push while uncertain | `repeated idempotency key…`, `ambiguous initiation…` |
| USD 5.00 minimum, whole-KES ceiling, rounding account, quote lock, stale rate, expired quote | `USD 5.00 quotes…`, `provider rejection…` |
| Treasury OK / ALERT / PAUSED / INCIDENT / UNKNOWN | `treasury coverage…`, `sandbox is closed…` |
| Reversal and resolution: two-person rule, reconciliation | `reversal and manual resolution…` |
| No client access to service RPCs or tables; immutability | `callers cannot reach…` |
| Production refused (DB and config) | `production payments…`, adapter config tests |
| No credit to a spendable or Real account | `happy path` (no REAL account; sandbox ledger only) |

**Not yet covered:**

- The live sandbox drill (runbook §2).
- An internal database outage during a callback. The code returns 500 so Daraja retries, but this has no automated test.
- An operator-resolved reconciliation difference against a real statement.

## 6. Statuses

| Status | Value | Basis |
| --- | --- | --- |
| `CODE_READY` | **Not ready** | The full suite did not complete (§4). Owner review pending |
| `PRACTICE_READY` | Not ready | Engine-v3 operational rows pending. This work does not change it |
| `DARAJA_SANDBOX_READY` | **Not ready** | No live sandbox run. Credentials not configured. No Owner review |
| `KES_USD_QUOTE_READY` | **Not ready** | Arithmetic and controls tested with fixtures only. No staging evidence or review |
| `DARAJA_PRODUCTION_READY` | **Not ready** | Production is refused in code (`PRODUCTION_RELEASED = false`, `production_payments_disabled`) |
| `REAL_READY` | **Not ready** | F1 open, checklist draft, no Real account path |

## 7. External dependencies and next actions

| Dependency | Next action |
| --- | --- |
| Owner review of Phase 0–2 | Review this packet and record identity and time |
| F2 decommission | Owner runs step 1 of `docs/runbooks/legacy-function-decommission.md`, then confirms deletion (Claude can run steps 2–3) |
| Deploy funding to the linked project | Owner-approved `db push` of the two migrations and deploy of the three functions (runbook §1) |
| Sandbox credentials | Owner sets the `DARAJA_SANDBOX_*`, `DARAJA_CALLBACK_BASE_URL` and `FUNDING_CRON_SECRET` secrets |
| Live drill | Owner runs runbook §2 with a sandbox test number. Claude prepares redacted evidence |
| Daraja doc pin and the KES 250,000 cap | Owner confirms against the portal |
| Deployed state unknowns | Owner runs the Phase 0 §6 read-only query |
| Orphaned local `postgres.exe` test processes | Owner ends them (Task Manager: the `postgres.exe` processes under `node_modules\@embedded-postgres`) |
| F1 gate replacement, Real account path, customer funding UI | Phase 3, after the sandbox review |
