# Real mode and Daraja sandbox: Phase 1–2 handoff (updated for the supervisor review)

**Plan:** `docs/CLAUDE_REAL_MODE_DARAJA_SANDBOX_AUDIT_PLAN.md`. **Review answered:** `docs/REAL_MODE_PHASE2_SUPERVISOR_REVIEW.md` (candidate `145514b` + `c47dcf4`, status CHANGES REQUIRED). **Performer:** Claude. **Reviewer:** Owner / supervisor, pending. No status below is accepted until the reviewer records identity and review time.

This handoff does not approve or perform any deployment. Nothing was deployed, no secret was read, and no live Daraja request was made.

## 1. Source and environment

- **Branch:** `feat/restore-customer-ui`. **Fix commit:** `db118e3` (code, migrations and tests). The docs commit that adds this file follows it; its hash is in `git log`.
- **Deployed environment:** Supabase project `cdaxvkpmgqjfukbtrzys`. **Nothing from this work is deployed.** No migration push, no function deploy, no Daraja secret in the project. The Owner's sandbox key and secret in the ignored local file `.env.redis.local` were **not opened, printed or used**.
- **Migrations were fixed in place.** `20260926100000_funding_foundation.sql` and `20260926110000_funding_rpc.sql` have never been applied anywhere, so no follow-up migration was added and the vulnerable callback logic does not remain in history. `FUNDING_MIGRATIONS` and the cutover rehearsal still name exactly these two files.
- **Not modified:** the plan and the supervisor review (owner files, uncommitted), and the supervisor's `.env.redis.local` paragraph in `docs/runbooks/daraja-sandbox.md` (left unstaged for its author).

## 2. Findings R1–R5: what changed

| # | Finding | Fix | Evidence (tests) |
| --- | --- | --- | --- |
| R1 | A callback could supply the checkout id that STK Query then "verified" | `checkout_request_id` is written only from the synchronous STK Push response, together with `initiated_at` (a check constraint ties them). A callback for a payment without a bound checkout (`UNKNOWN`, `INITIATING`, `EXPIRED`, `REJECTED`) is recorded as `UNBOUND`, keeps its claimed id in `callback_checkout_request_id`, and sends the payment to `MANUAL_REVIEW` (`callback_without_initiation_checkout`) with no query. `funding_svc_record_status` and the sweep require the bound checkout. Manual credit needs statement evidence (R3) | `a leaked token with another customer's successful checkout id never credits an ambiguous initiation` (the Daraja double would answer 0 for any query, and no query is made); `…on a pending payment cannot redirect verification…`; `a callback that beats the initiation response goes to review…`; `time rules…` (EXPIRED + callback) |
| R2 | Treasury admission ignored the new liability | `funding.coverage(env, extra_usd, floor_rate)` projects coverage at the higher of the current and locked rate. At payment start it counts liabilities + every open deposit + this quote, under an environment advisory lock. `funding.confirm_and_credit` re-checks it (and the limits) in the crediting transaction, under the same lock, immediately before posting. A paid deposit that fails is held in **funded suspense**: KES booked, no USD, `MANUAL_REVIEW`, never resolvable as `FAILED` | `sandbox is closed…` (KES 0 reserve + first deposit refused while the status view says OK); `projected coverage: one deposit that would cross the pause threshold…`; `…concurrent deposits cannot both use the same headroom` (two connections, lock contention); `…a rate rise after the quote holds the paid money in funded suspense`; `stale treasury snapshots refuse admission and hold a paid credit`; the no-snapshot case in `sandbox is closed…` |
| R3 | Manual confirmation not tied to provider evidence | Immutable `funding.provider_statement_items` (receipt unique per environment, exact KES, shortcode, transaction time and business date, account reference and/or phone hash, evidence kind, reference and SHA-256; production only `PROVIDER_DOWNLOAD`). `RESOLVE_CONFIRMED` must cite one that binds (environment, exact KES, shortcode, reference/phone, time window, callback receipt, not used elsewhere), checked at request and at approval. Requester ≠ approver ≠ recorder. Payments now store the shortcode they were pushed to | `manual confirmation needs a binding provider statement item and three different people` (each binding field refused, reuse refused, duplicate receipt, recorder can neither request nor approve, approval re-checks coverage and changes nothing when refused, production evidence rules, immutability) |
| R4 | Reconciliation did not reconcile net KES cash or fees | Statement totals now carry opening, gross, reversals/refunds, fees, net settlement and closing KES, plus evidence kind, reference and digest. The run checks each provider-confirmed payment's KES receipt, gross and reversals against the books, the roll-forward, the opening against the previous close, day gaps, and unmatched statement lines. A missing statement is a difference. The summary reports funded-suspense KES and whether the statement is `simulated`. The resolver may not have recorded the day's statement or items | `reversal needs two owners; reconciliation rolls the KES statement forward and keeps differences open` |
| R5 | Deno wrappers never checked | Request handling moved to `supabase/functions/_shared/funding-handlers.mjs`; each `index.ts` is a thin Deno wrapper. Bodies are read with a hard byte cap (chunked uploads included; the old callback trusted `Content-Length`). Methods restricted (405). A missing bearer token is refused before any work. supabase-js pinned to `npm:@supabase/supabase-js@2.117.1` (was a floating `esm.sh …@2`) | `tests/funding-edge-handlers.test.mjs` (12 tests: methods, declared and chunked oversize, missing config, missing/invalid JWT, cron secret, CORS, database failure, safe error bodies, no secret or token in bodies or logs), run in Node **and** Deno; `deno check`; a boot smoke of each entry point (§4) |

**Product limits (Decision 3).** Policy v1: USD 5.00 minimum, **USD 500 per deposit, USD 1,000 and three successful deposits per customer per rolling 24 hours**, KES 250,000 provider ceiling (a check constraint stops a policy row from raising it). They are enforced on locked USD amounts at quote, at payment start (counting still-open payments) and again at credit. A missing policy fails closed. Evidence: `policy v1 limits hold server-side…`. It checks the shipped v1 row, refuses 4.99 and 500.01 at quote, refuses forged quote rows of USD 4 and 600 at payment start, refuses a fourth deposit and a deposit beyond USD 1,000 (at quote and at payment start), shows the window rolling after 24 h, applies the KES ceiling independently, holds a paid deposit in suspense when the policy tightens mid-payment, and fails closed without a policy. The remaining state-machine tests then run under a test policy that relaxes only the rolling limits.

**Other changes.** The design (`docs/REAL_FUNDING_DESIGN.md` §1, §3, §4, §5, §7–§12) and the runbook (`docs/runbooks/daraja-sandbox.md`) no longer claim that a stolen callback token cannot lead to credit merely because STK Query succeeds. They describe the bound checkout, the limits, the projected coverage, funded suspense, the statement evidence and the three-person resolution. The KES 250,000 ceiling is pinned to Safaricom's press release, with its URL, access date and page digest (design §1).

## 3. Clean-process evidence (review item 5)

Before any test run in this session, the following `postgres.exe` processes were found. Each was an `--forkchild="io_worker"` child whose parent process no longer existed, owned by `IAN\ianwa`, and ran from `C:/Users/ianwa/OneDrive/Desktop/VN2/node_modules/@embedded-postgres/windows-x64/native/bin/postgres.exe`. They were created between 00:03 and 00:34 EAT on 2026-09-26, before the `io_method=sync` harness fix, and are the orphans reported in the previous handoff:

| PID | Parent PID (dead) | Created (EAT) |
| --- | --- | --- |
| 11800 | 1468 | 00:03:17 |
| 8328 | 1376 | 00:10:18 |
| 8200 | 7396 | 00:15:34 |
| 5036 | 3320 | 00:19:34 |
| 5464 | 4412 | 00:22:52 |
| 4600 | 10340 | 00:23:52 |
| 10856 | 7848 | 00:28:13 |
| 6180 | 10872 | 00:32:29 |
| 7916 | 9324 | 00:34:19 |

Only these nine were stopped (`Stop-Process` by PID, after re-checking the command line and dead parent); afterwards no `postgres.exe` was running. All test runs below started from that clean state. After the full `npm test` run, 0 `postgres.exe` processes remained: the `io_method=sync` fix held.

## 4. Verification

**Environment:** Windows 11 Pro 10.0.26200, Node v24.20.0, npm 11.19.0, embedded-postgres 18.4.0-beta.17 (real PostgreSQL 18, real pgcrypto), Deno 2.9.6 (installed from npm into a temporary directory, not the repository), Microsoft Edge for browser checks.

| # (review list) | Command | Result |
| --- | --- | --- |
| 2 | `npm ci` (clean reinstall after removing the orphans) | Exit 0. 90 packages, 0 vulnerabilities. npm skipped `@embedded-postgres/windows-x64`'s postinstall (`hydrate-symlinks.js`) under its install-script policy; every real-PostgreSQL test below still ran |
| 2 | `npm test` (parity, PostgreSQL vector harness, then all 39 `tests/*.test.mjs` files; uninterrupted, 2026-09-26 00:38:15–00:52:10 UTC) | **Exit 0. 275 tests: 274 pass, 0 fail, 0 cancelled, 1 skipped.** The skip is the existing by-design PGlite case `engine advances deterministic ticks…` (PGlite has no pgcrypto HMAC; the same behavior is covered on real PostgreSQL). Parity and both pgcrypto vector sets: PASS |
| 1 | inside `npm test`: `tests/funding-sandbox.test.mjs` | 23/23 on real PostgreSQL (also 23/23 when run alone, about 27 s) |
| 1, 4 | inside `npm test`: `tests/funding-edge-handlers.test.mjs` | 12/12 |
| 1 | inside `npm test`: `tests/daraja-adapter.test.mjs` | 9/9 |
| 3 | inside `npm test`, and separately before the commit: `tests/engine-v2-cutover.test.mjs` | 4/4. The pending set is `20260920560000` + the four v3 migrations + **both funding migrations**, including the `supabase db push` rehearsal while a tick is in flight |
| 2 | `npm run build` | Exit 0. "Built 19 pages with shared assets in dist/" |
| 2 | `BROWSER_EVIDENCE=1 node --test tests/engine-v3-browser.test.mjs` (Microsoft Edge 153.0.4234.48, built `dist/`, fake backend) | 8/8. `docs/browser-checks/browser-check-log.json` and the screenshots were re-recorded at commit `db118e3` |
| 4 | `deno check --no-config --node-modules-dir=none` on `supabase/functions/funding-deposit/index.ts`, `daraja-callback/index.ts`, `funding-reconcile/index.ts` (Deno 2.9.6, TypeScript 6.0.3, empty `DENO_DIR`) | Exit 0, all three checked |
| 4 | `deno test -A --no-config tests/funding-edge-handlers.test.mjs` | 12/12 in the Deno runtime |
| 4 | Boot smoke: `deno run --allow-net --allow-env --allow-read <fn>/index.ts` with no funding secrets in the environment, then HTTP probes | `funding-deposit`: OPTIONS 204, POST without JWT 401. `daraja-callback`: GET 405, POST 500 `Retry` (no service config). `funding-reconcile`: POST without secret 401, GET 405 |
| 7 | Limits evidence | `policy v1 limits hold server-side…` (§2) |

## 5. Daraja sandbox coverage

All automated coverage uses a scripted Daraja double on real PostgreSQL. **No live sandbox call has been made.**

| Scenario | Covered by |
| --- | --- |
| Valid initiation, callback, provider status, one credit; replays | `happy path…` |
| Idempotent retry, no re-push, one open payment | `a repeated idempotency key…` |
| Forged callback without a token; lost callback confirmed by the sweep | `forged callbacks…` |
| Malformed payload | `a malformed callback…` |
| Altered amount, reused receipt, checkout conflict, callback/status disagreement | `altered amount…` |
| **Leaked token + another customer's successful checkout** (UNKNOWN, PENDING, EXPIRED, callback before initiation) | R1 tests (§2) |
| Late and conflicting facts after a final state | `late and conflicting…` |
| Abandoned initiation, 24 h expiry, provider outage | `time rules…` |
| Provider rejection, stale rate, expired or foreign quote, bad phone | `provider rejection…` |
| Limits (min, per deposit, per 24 h amount and count, KES ceiling, fail closed) | `policy v1 limits…` |
| Treasury status bands; projected coverage; concurrency; rate change; stale or missing snapshot; funded suspense | R2 tests (§2) |
| Manual confirmation with statement evidence; three-person rule | R3 test (§2) |
| Two-person reversal; net KES reconciliation; independent resolution | `reversal needs two owners; reconciliation…` |
| No client access to service RPCs or tables; immutability | `callers cannot reach…` |
| Production refused (database and config) | `production payments…`, adapter and handler config tests |
| Wrapper behavior (HTTP) | `tests/funding-edge-handlers.test.mjs` |

**Not covered:** the live sandbox drill (runbook §2), an operator-resolved reconciliation against a real downloaded statement, and a refund path for funded-suspense money (not built: Phase 3).

## 6. Statuses

| Status | Value | Basis |
| --- | --- | --- |
| `CODE_READY` | **Not ready** | R1–R5 fixed and the verification in §4 recorded. Awaiting supervisor re-review |
| `PRACTICE_READY` | Unchanged | Engine-v3 operational evidence is separate |
| `DARAJA_SANDBOX_READY` | **Not ready** | No deployment approval, no secrets configured, no live drill |
| `KES_USD_QUOTE_READY` | **Not ready** | Projected coverage and reconciliation fixed in source; not deployed or reviewed |
| `DARAJA_PRODUCTION_READY` | **Not ready** | Production refused in code and database |
| `REAL_READY` | **Not ready** | F1 open (R6), no Real account path, funded checklist incomplete |

## 7. Open items and next actions

| Item | Owner of the action | Next action |
| --- | --- | --- |
| Re-review of this handoff | Supervisor | Review `db118e3` and this report, and record identity and time |
| Funding deployment | Owner, after approval | `db push` of the two migrations; `deno check`, then deploy the three functions (runbook §1). Enter only the `DARAJA_SANDBOX_*`, `DARAJA_CALLBACK_BASE_URL` and `FUNDING_CRON_SECRET` values in the Supabase secret store. Never upload `.env.redis.local` |
| Live sandbox drill | Claude and Owner, after deployment | Runbook §2, cases 1–10 |
| Daraja endpoint/field contract revision | Owner | Pin the portal page and date (design §1). The transaction ceiling is now pinned |
| R6 / F1 Real enablement evidence gate | Phase 3 | Unchanged: blocks production payments, Real accounts and Real trading |
| Refund path for funded suspense | Phase 3 | Design and build a reviewed refund flow |
| Legacy crypto functions (F2) | Owner | Run the runbook's live cron and log checks, then authorize deletion separately |
