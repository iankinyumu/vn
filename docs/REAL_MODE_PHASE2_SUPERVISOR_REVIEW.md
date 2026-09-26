# Supervisor review: Real funding Phase 0–2

**Reviewed candidate:** `f9fb1e6` on `vn/feat/restore-customer-ui`
**Executor:** Claude
**Review status:** SANDBOX DEPLOYMENT AND LIVE TESTING APPROVED
**Deployment decision:** Deploy candidate `f9fb1e6` now and continue through the live Daraja sandbox drill without another Owner decision. Production payments, spendable Real balances, Real accounts, and Real trading remain closed.

This review covers repository source and Claude's reports. It does not approve production payments, Real accounts, or Real trading. No live Daraja request was made during this review.

## Owner standing authorization for sandbox execution

The Owner directs Claude to complete the sandbox integration now. Claude does not need another decision or approval to interact with the linked Supabase project, the Owner's Daraja sandbox, the repository remote, or Vercel for this sandbox release. This authorization includes:

- fixing R7 and any defect discovered while verifying the same sandbox flow;
- safely stopping only confirmed orphaned test processes after recording their executable path, parent state, and repository association;
- reading only the named Daraja sandbox variables from the ignored local `.env.redis.local` file, without printing or logging their values, and writing those variables individually to the Supabase secret store;
- applying the two reviewed funding migrations, deploying the three funding Edge Functions, configuring the sandbox callback and scheduler, and running database smoke checks;
- adding a sandbox-only customer deposit interface, deploying the site to Vercel, and checking the deployed flow in a browser;
- using the official Daraja sandbox test MSISDN and simulator to initiate STK Push tests; and
- committing and pushing all task-related source and documentation changes and leaving no task-related uncommitted or untracked files.

Claude must never commit `.env.redis.local`, print secret values, upload the whole environment file, configure a production Daraja credential or endpoint, use a real customer MSISDN, send real money, enable a spendable Real balance, or open the Real trading gate. These are scope boundaries rather than approval pauses.

### Explicit permission grant for the executor session

The Owner grants Claude full external-action permission within this sandbox scope. This explicitly authorizes the permission prompts for:

- `supabase db push` against linked project `cdaxvkpmgqjfukbtrzys`, limited to the two pending funding migrations `20260926100000` and `20260926110000`;
- `supabase secrets set` for the named sandbox variables and a newly generated cron secret, with values kept out of command output and reports;
- `supabase functions deploy` for `funding-deposit`, `daraja-callback`, and `funding-reconcile`;
- linked database writes needed to configure the one Owner tester, sandbox treasury snapshot, current sandbox FX rate, sandbox scheduler, and `daraja_sandbox` module;
- Vercel preview and production deployment of the sandbox-gated UI for linked project `smartprofitbinaryv2`;
- live calls to Safaricom's Daraja sandbox endpoints using only the official sandbox shortcode and test MSISDN;
- `git push` of the resulting reviewed commits; and
- read-only Supabase, Vercel, Daraja sandbox, GitHub, browser, log, and deployment inspections needed to verify the result.

This authorization should be supplied directly in every required escalation request. If the execution platform's automatic policy still rejects an action, Claude must identify the rejected command and policy reason. It must not reinterpret a policy rejection as missing Owner authorization. Broad production Daraja access, real-money transfers, destructive database resets, and Real trading activation are outside this grant.

## Second-pass review of `db118e3` and `0c1c666`

Claude's R1-R5 changes are materially present in the candidate. The authoritative checkout ID now comes only from the synchronous STK Push response; ambiguous initiations go to manual review. Deposit admission includes projected liabilities under a treasury lock and credit repeats the coverage check. Manual confirmation requires an immutable matching statement item and three distinct actors. Reconciliation now records the KES cash roll-forward. The Edge Function handlers have bounded bodies, authentication and configuration failure handling, wrapper tests, and pinned imports.

The executor reports a complete passing verification run: 274 of 275 repository tests passed with one documented in-memory database skip, funding passed 23/23 on real PostgreSQL, Edge handlers passed 12/12 in Node and Deno, cutover passed 4/4, and build, browser, Deno checks, and function boot checks passed. This remains executor evidence until independently reproduced.

The supervisor's focused rerun on 2026-09-26 passed all 21 adapter and Edge handler tests. The PostgreSQL fixture failed before its first test because Windows returned `ENOMEM` from `uv_os_get_passwd`; the resulting 23 database test failures are setup failures, not observed assertion failures. At that time only about 885 MB physical memory was available and no `postgres`, project `node`, or `deno` process was visible through the permitted process query. The database portion is therefore inconclusive and must be rerun after memory is freed. No process was terminated.

### R1-R5 disposition

| Finding | Second-pass decision |
| --- | --- |
| R1 authoritative checkout binding | Accepted in source, subject to R7 below |
| R2 projected treasury coverage | Accepted in source and executor tests |
| R3 provider evidence for manual confirmation | Accepted in source and executor tests |
| R4 KES cash reconciliation | Accepted in source; production still needs real provider and bank evidence |
| R5 Edge Function runtime checks | Accepted from executor evidence and the supervisor's 21 passing non-database tests |

### R7 - Closed in `5125fb9`: callback receipt remains a claim

The callback is explicitly untrusted, but a successful callback currently writes its claimed `MpesaReceiptNumber` into `funding.payments.mpesa_receipt`. If the later STK Query returns success, `receipt_pending` becomes false merely because that callback-supplied value exists. The implemented STK Query response does not independently verify the receipt. A leaked callback token paired with the correct checkout ID and expected amount can therefore attach a fabricated receipt to a legitimate payment. The USD credit corresponds to a successful checkout, but the stored receipt and later reconciliation identity can be corrupted.

**Accepted implementation:**

- Keep callback receipt, phone and amount as immutable provider-event claims. Do not promote a callback receipt to the authoritative payment receipt merely because STK Query succeeds.
- An automatic status-confirmed credit may remain non-spendable in sandbox, but it must remain `receipt_pending` until a provider statement or another documented authoritative provider response binds the actual receipt to the payment.
- A statement item that supplies the authoritative receipt must retain the existing exact KES amount, shortcode, account reference or phone, environment, transaction window, unique receipt, immutable evidence, and independent actor checks.
- Add a negative test in which a leaked token sends the correct authoritative checkout ID and expected amount with a fabricated receipt. The fabricated receipt must never become authoritative or make reconciliation appear complete.
- Update the design, threat model, runbook, and Phase 2 report to distinguish callback claims, queried checkout status, and statement-verified transaction identity.

### R8 - Closed for sandbox deployment

Both deployment prerequisites have been completed:

1. The focused funding suite passed 24/24 on real PostgreSQL 18. Funding, Edge handler, adapter, page, copy, and secret checks later passed 56/56; cutover passed 4/4; all three Deno entry points checked successfully.
2. The current STK Push, callback, OAuth, and STK Query contract was pinned from the official Safaricom portal data with access time and response digests. The ambiguous `500.001.1001` result is handled as non-crediting processing and ultimately manual review.

The later full `npm test` run was stopped by host memory pressure after 72 passes and no failures. This keeps the global `CODE_READY` status pending, but it does not block this isolated, gated, non-spendable sandbox deployment because the directly affected real-PostgreSQL, Edge, Deno, migration, browser, and Daraja adapter checks passed.

### Accelerated executor sequence — continue automatically

Claude owns this sequence from start to finish and must not stop after a successful intermediate step to request routine approval.

1. Implement R7. Keep callback receipt, phone, and amount as claims; make provider statement evidence the authority for the receipt identity. Add the forged-receipt negative test and update the design, threat model, runbook, and Phase 2 report.
2. Free enough memory for verification by stopping only confirmed orphaned processes. Run the funding real-PostgreSQL tests, Daraja adapter tests, Edge handler tests, cutover rehearsal, Deno checks, production build, and relevant browser checks. Fix failures in scope and repeat until clean. Do not deploy a failing candidate.
3. Pin the exact current Daraja sandbox OAuth, STK Push, callback, and STK Query endpoints and fields from the official portal. The live sandbox response may be used as additional conformance evidence, with credentials and personal identifiers redacted.
4. Add the customer-facing sandbox deposit flow to the site. It must be visible only to an authenticated allowlisted sandbox tester and clearly labelled `Daraja Sandbox - test funds only`. The user enters a USD amount from USD 5.00 to USD 500.00 and an approved sandbox phone number; the server returns the locked whole-KES amount, KES/USD rate, rounding amount, and five-minute expiry before initiation. Show pending, confirmed, failed, expired, and manual-review states. A confirmed amount must appear only in the separate non-spendable sandbox test balance and must never be presented as a Real trading balance.
5. Commit and push the R7, UI, test, and documentation changes. Include the previously untracked plan and supervisor review and the authorized runbook change. Never add local environment files, generated secret material, or unredacted transaction evidence.
6. Apply `20260926100000_funding_foundation.sql` and `20260926110000_funding_rpc.sql` to Supabase. Confirm both production modules and the Real gate remain closed. Deploy `funding-deposit`, `daraja-callback`, and `funding-reconcile` to project `cdaxvkpmgqjfukbtrzys`.
7. Read only these local sandbox inputs if present: `DARAJA_SANDBOX_CONSUMER_KEY`, `DARAJA_SANDBOX_CONSUMER_SECRET`, `DARAJA_SANDBOX_SHORTCODE`, `DARAJA_SANDBOX_PASSKEY`, optional transaction type and Party B. Set them individually in Supabase with `DARAJA_ENV=sandbox` and `DARAJA_CALLBACK_BASE_URL=https://cdaxvkpmgqjfukbtrzys.supabase.co/functions/v1`. Generate a new random `FUNDING_CRON_SECRET` directly into the secret store without displaying it. Remove or refuse any `DARAJA_PRODUCTION_*` value.
8. Deploy the sandbox UI to Vercel, verify the deployed commit, sign-in flow, access restriction, quote presentation, CORS, safe errors, and that Practice trading still works. Configure only public Supabase client values in Vercel; no Daraja or service-role secret may enter Vercel browser configuration.
9. Identify the existing Owner test user from the linked project, add only that user to `funding.sandbox_testers`, record a fictional sandbox treasury snapshot of KES 250,000, and publish a current CBK USD/KES rate if 129.62 dated 2026-09-25 is stale. Then enable only `daraja_sandbox`.
10. Configure the one-minute sweep and daily reconciliation schedule. Run one valid minimum USD 5 sandbox deposit through the deployed site using the official sandbox test MSISDN, then run cancellation, timeout, idempotent retry, wrong token, and status-recovery checks. No real MSISDN or real money is authorized.
11. Reconcile the sandbox payment using clearly marked simulated sandbox evidence, verify the USD 5 credit is non-spendable, confirm Practice and Real isolation, and exercise the emergency stop. Re-enable the sandbox only if the stop/recovery checks pass.
12. Commit and push the final redacted reports and evidence manifest, confirm the worktree is clean, and report the deployed Supabase functions, deployed Vercel URL and commit, migrations, test results, sandbox payment states, reconciliation result, and remaining blockers. Set `DARAJA_SANDBOX_READY` and `KES_USD_QUOTE_READY` only if their complete evidence passes. Keep `DARAJA_PRODUCTION_READY` and `REAL_READY` false.

If a required credential name, Daraja product, test MSISDN, authenticated platform session, or account permission is genuinely absent, Claude must finish every independent step, leave gates closed, record the exact missing item by name without exposing values, and report that single external blocker. A missing item is not permission to substitute production credentials or real funds.

## Decisions

1. The account and contract ledger remains USD. M-Pesa cash settlement remains KES. A payment quote locks the USD credit, reference rate, and whole-KES STK amount for that payment.
2. Minimum deposit remains USD 5.00. At the current initial reference rate of KES 129.62/USD this is KES 649. The KES 0.90 difference is disclosed whole-shilling rounding, not a fee.
3. Safaricom's current provider ceiling is KES 250,000 per transaction. The initial product limit is lower: **USD 500 per deposit, USD 1,000 total successful deposits per rolling 24 hours, and at most three successful deposits per rolling 24 hours per customer.** Enforce these server-side using the locked USD amounts. Keep the KES 250,000 provider limit as a second hard ceiling. Limits are versioned policy and fail closed.
4. Callback data is an untrusted notification. A successful STK Query proves only the queried checkout's status; in the implemented contract it does not independently bind that checkout to the intended customer, phone, KES amount, or account reference.
5. The two legacy crypto Edge Functions are approved for decommission only after the runbook's live cron-job and invocation-log checks show no intended callers. Their deletion and verification remain a separate maintenance change.
6. Phase 2 sandbox deployment is approved for `f9fb1e6` because R1-R8 and the directly affected verification matrix passed. Phase 3 Real-gate work may continue in source, but nothing may enable a production payment or spendable Real balance.

## Original findings against `145514b` (historical)

R1-R5 below explain the first rejection. Their required changes are satisfied in the second-pass disposition above; R6 remains open for any Real release.

### R1 — High: an ambiguous initiation can be credited using a checkout not proven to belong to the payment

`funding_svc_record_callback` accepts a callback-supplied `CheckoutRequestID` when the payment has no stored checkout ID, including `UNKNOWN`. It writes that ID to the payment and asks Daraja STK Query for its status. `funding_svc_record_status` then credits on query result `0` if the callback's claimed amount does not conflict.

The callback is unauthenticated. The URL token is a useful correlation secret, but it is carried in a query string and must be assumed observable in provider/platform access logs. Even without log leakage, the design claim that a stolen token cannot credit is too strong. An attacker with the token can supply a different successful checkout ID and claim the expected amount; STK Query, as consumed here, returns status but not authoritative phone, amount, account reference, or receipt binding.

**Required change:**

- A callback must never establish the authoritative checkout ID for an `UNKNOWN`/abandoned initiation.
- Only the checkout ID returned directly by the synchronous STK initiation response may enter the automatic query-and-credit path.
- A callback received for a payment without that authoritative ID may be recorded, but it must go to `MANUAL_REVIEW` without automatic credit.
- Manual resolution requires a provider statement/transaction record that binds the receipt, exact KES amount, shortcode, phone/account reference where available, and business date to this payment. Store an immutable evidence reference and independent approver.
- Update the threat model and negative tests for a leaked callback token paired with another customer's successful checkout ID.

### R2 — High: treasury admission ignores the liability created by the proposed deposit

`funding_svc_begin_payment` checks current treasury status before the payment is credited. `funding.treasury_status` treats zero current liability as healthy if a fresh snapshot exists, even when the reserve is KES 0. The first deposit can therefore pass and create an uncovered USD liability. Later deposits can also pass when current coverage is acceptable but projected post-credit coverage is below the pause threshold.

**Required change:**

- Add a server-side projected coverage check using current liabilities plus the quote's USD credit at the current conservative rate/stress policy.
- Run it when consuming the quote and again in the same database transaction immediately before posting the USD credit.
- A projected result below the pause threshold rejects initiation or sends an already-paid item to funded suspense/manual handling; customer money must not disappear and the system must not create an unbacked spendable balance.
- Test zero reserve/zero liability plus first deposit, threshold crossing by one deposit, concurrent deposits, rate change between quote and credit, and stale/missing treasury snapshots.

### R3 — High before any spendable balance: manual confirmation is not tied to provider evidence

Two different owners can approve `RESOLVE_CONFIRMED`, but the database does not require a provider statement row, receipt, exact KES match, or immutable evidence reference before credit. Two-person approval reduces insider risk but does not establish that money was received.

**Required change:** require a matching immutable provider-statement transaction/evidence record before `RESOLVE_CONFIRMED`. Enforce unique receipt/provider transaction identity, exact KES amount, environment and business date. The requester and approver must be distinct, and neither may be the person who imported/recorded the supporting statement item.

### R4 — Medium: reconciliation does not yet reconcile net KES cash or fees

The reconciliation compares confirmed KES receipts to an entered gross statement total. `kes_fees` is stored but not used, and no merchant/bank closing balance or settlement movement is reconciled. Calling this full KES cash reconciliation is premature.

**Required change:** report and reconcile gross receipts, reversals/refunds, provider fees, net settlement movement, and closing KES merchant/bank balance. Differences remain open until independently resolved. Sandbox evidence must distinguish simulated statement totals from downloaded provider evidence.

### R5 — Medium: production wrappers have not been checked in their actual runtime

The shared modules passed Node tests, but the three Deno Edge Function entry points were not type-checked. These wrappers contain authentication, secret handling, service-role construction, public callback behavior, and cron authorization.

**Required change:** run `deno check` (or the Supabase-supported equivalent) on all three entry points in a clean compatible environment. Add wrapper-level tests for HTTP methods, oversized/chunked callback bodies, missing configuration, missing/invalid JWT, cron authorization, CORS, database failure, and safe error responses. Do not deploy unchecked wrappers.

### R6 — High before Real release: the Real enablement evidence gate remains weak

F1 remains open. `enable_real_accounts` accepts reference-shaped strings rather than verified evidence with an independent reviewer. This does not block isolated, non-spendable sandbox testing, but it blocks production payment activation, Real account creation, and Real trading.

## Required verification before sandbox deployment approval

The original R1-R5 verification requirements were:

1. Fixes and negative tests for R1–R5 on real PostgreSQL where applicable.
2. A clean `npm ci`, full `npm test`, production build, and browser checks. An interrupted run is not a pass.
3. Successful `tests/engine-v2-cutover.test.mjs` with both funding migrations included in the migration rehearsal.
4. Deno/runtime checks for all three Edge Function entry points.
5. A clean-process test run after removing only the confirmed orphaned embedded-PostgreSQL worker processes; record process ownership and paths before termination.
6. Updated design, threat model, runbooks and Phase 2 report that no longer claim a stolen callback token cannot lead to credit merely because STK Query succeeds.
7. Evidence that the product limits are enforced server-side: USD 5 minimum, USD 500 per deposit, USD 1,000 per rolling 24 hours, maximum three successful deposits per rolling 24 hours, and KES 250,000 provider ceiling.

Claude supplied executor evidence for all seven items. R7 and R8 are now closed for the sandbox deployment as recorded above.

## External actions and approvals

- **Legacy functions:** perform the read-only cron/log caller check first. If it passes, the Owner may explicitly authorize deletion. Do not delete based on repository search alone.
- **Funding deployment:** approved now for candidate `f9fb1e6`. A linked read-only check on 2026-09-26 confirmed only `20260926100000` and `20260926110000` are pending remotely.
- **Sandbox secrets:** the local ignored file contains `DARAJA_CONSUMER_KEY` and `DARAJA_CONSUMER_SECRET`. Claude is authorized to map those two values to `DARAJA_SANDBOX_CONSUMER_KEY` and `DARAJA_SANDBOX_CONSUMER_SECRET` in the Supabase secret store without displaying them. Use Safaricom's official sandbox sample shortcode `174379` and its official sample passkey for the sandbox-only variables. Generate the cron secret without displaying it. Never upload the local file or unrelated Redis/environment values.
- **Tester:** use Owner account `1d180b1b-eff7-4b4f-a571-30d710e1fb32` for the first controlled drill. A signed-in browser session for that account may be created or used without another approval.
- **Live sandbox drill:** approved immediately after successful migration, secret, function, scheduler, tester, rate, treasury, and UI deployment smoke checks. It is required for `DARAJA_SANDBOX_READY`.
- **Daraja cap:** KES 250,000 per transaction is supported by Safaricom's published M-Pesa limit and PayBill tariff material. Pin the exact Safaricom source and access date in the design. The product limits above remain lower.
- **Daraja contract:** pinned by Claude from the official portal data feed on 2026-09-26 with response digests recorded in the design.

## Status after review

| Status | Decision |
| --- | --- |
| `CODE_READY` | Not ready — the later global suite was interrupted by host memory pressure; focused sandbox checks passed |
| `PRACTICE_READY` | Unchanged; engine-v3 operational evidence remains separate |
| `DARAJA_SANDBOX_READY` | Pending execution — deployment and live sandbox drill are now approved |
| `KES_USD_QUOTE_READY` | Pending execution — deploy, create a fresh rate/treasury snapshot, and complete the live quote drill |
| `DARAJA_PRODUCTION_READY` | Not ready — production intentionally refused and F1 open |
| `REAL_READY` | Not ready — funded checklist, Real account path and independent evidence incomplete |
