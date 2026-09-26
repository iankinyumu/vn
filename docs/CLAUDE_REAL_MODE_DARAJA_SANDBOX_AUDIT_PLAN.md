# Claude execution brief: Real mode readiness and Daraja sandbox audit

**Status:** EXECUTION PLAN — Codex owns design decisions and audit direction; Claude is the implementation executor. The project Owner reviews and accepts each deliverable. This document is not approval to enable production payments, Real accounts, or Real trading.

**Purpose:** Establish a reviewable, staged plan to assess the current site and build the Real-mode payment foundation against the owner’s Daraja sandbox. The sandbox flow is the first end-to-end implementation and test target; once the owner is satisfied with its behavior and independent checks pass, the same controlled integration can be prepared for real Daraja payments. Preserve Practice behavior and keep live payment and trading gates closed until the owner approves that later production step.

## Decisions Claude must implement

These are project decisions, not questions for Claude to reopen:

1. **Customer account and ledger currency: USD.** This is a hard product requirement. Real account balances, contract stakes, payouts, fees, refunds, and ledger entries remain USD-denominated, consistent with the current site and USD-only engine ledger. Daraja receives KES, so each deposit must have an explicit KES-to-USD conversion quote. Record the KES amount and USD credit together in the payment/reconciliation record, but post only USD to the account ledger. Never treat KES as USD or silently credit at 1:1. Practice remains unchanged.
2. **Payment product: STK Push deposits first.** Implement Daraja sandbox STK Push initiation and callback handling, with transaction-status query/reconciliation for ambiguous or missing callbacks. Do not include C2B paybill/till collection, B2C disbursement, or reversal initiation in the first release. Reversals/refunds are recorded through controlled accounting and a later provider workflow; no customer withdrawal is in scope.
3. **Callback host: Supabase Edge Function.** Use the linked Supabase project `cdaxvkpmgqjfukbtrzys` and a dedicated public callback function. The Vercel static site must not receive provider callbacks or hold Daraja credentials. Treat callbacks as untrusted notifications: authenticate only by supported provider mechanisms, bind them to a pending payment, deduplicate, and use provider status query/reconciliation before a USD ledger credit when callback authenticity is not cryptographically established.
4. **Real trading product: existing digit contracts.** Real-mode trading is the existing self-generated digit-contract product, not a broker/exchange order flow. Daraja funds accounts; it does not execute contracts. Keep Real purchase/settlement disabled until the engine’s Real gate and funded release requirements pass. External venue execution is out of scope.
5. **Legacy public endpoints: decommission.** The active `refresh-market-quote` and `cron-process-demo-orders` functions with `verify_jwt=false`, whose source is archived/disabled, are not supported product interfaces. Claude must verify there are no intended callers, capture relevant operational evidence, and remove/disable both deployed endpoints through a reviewed maintenance change before any public Real release. This work is independent of Daraja sandbox implementation and must not delete data or alter engine-v3 state.
6. **Review responsibility.** The project Owner is the independent reviewer for Claude’s implementation and evidence. Claude must never self-approve. Record the Owner’s actual identity and review timestamp when review occurs; do not fabricate either.

Claude proceeds using these decisions without asking routine design questions. Account-specific sandbox values (sandbox app enabled, test shortcode/passkey, and test MSISDN) are runtime setup inputs, not design blockers: implement and test with mocks/fixtures first, then run Daraja calls only when the sandbox secrets are supplied through the Supabase secret store. Never request or print those secret values in chat or repository artifacts.

## Current repository assessment

These are source-repository findings, not a claim about the deployed site or Supabase project:

- The customer product currently presents itself as Practice. `pages/trade.html` labels the order as Practice and virtual funds; `pages/dashboard.html` identifies the Practice dashboard and virtual balance.
- The account model has `DEMO` and `REAL` enum values, but `docs/ACCOUNT_TYPES.md` describes Real as structural readiness only. It explicitly says that Real account creation, deposit, withdrawal, conversion, KYC, and Daraja are not implemented.
- The account switcher recognizes a Real account as “Real — Not available yet” and disables it unless the server-provided configuration enables Real. This UI is not the security boundary.
- The trade page uses the engine-v3 contract path (`engine_quote_contract` then `engine_buy_contract`); `submit_demo_order` is confined to the archived crypto module. The server-side Real gate currently rejects Real quote/buy while disabled. No Real funding adapter or cashier was found in the active source paths.
- The Supabase functions tree contains shared helpers and an archived, disabled crypto-spot module. No Daraja/M-Pesa function or callback handler was found in the active function tree.
- `docs/REAL_READINESS_CHECKLIST.md` is explicitly a draft and unpublished. It requires evidence for seed custody, reconciled funding, Real policy limits, step-up authentication, conformance parity, and Owner sign-off.
- Engine v3 has a separate Practice acceptance track. `docs/ENGINE_V3_ACCEPTANCE.md` is generated historical output and shows operational rows awaiting evidence. Engine v3 or a Daraja sandbox payment does not by itself establish Real-money readiness.

Claude must re-check these statements against the source and deployed environment available to it before implementation. Do not inspect or print `.env.local`, `.env.redis.local`, access tokens, private keys, or sandbox secrets. Report only whether required configuration is present, absent, or invalid.

### Phase 0 report findings accepted into this plan

Claude’s report `docs/REAL_MODE_PHASE0_BASELINE.md` (commit `70a41a7`, observing source commit `9ea140c`) is an unreviewed baseline, not a readiness approval. Its correction that the active Trade page calls `engine_quote_contract` and `engine_buy_contract` is authoritative; the older `submit_demo_order` wording above applies only to archived crypto code. The linked Supabase project and two active unauthenticated legacy functions are recorded in that report. Deployed Real-gate state, migration head, production URL/commit, and Daraja app configuration remain unverified and must stay labeled unknown until read-only access establishes them.

F1 is a mandatory Real-release fix: the current `enable_real_accounts` evidence check accepts reference-shaped strings without validating artifact content, reviewer independence, or review identity. Replace that gate with server-verifiable evidence records and independent review enforcement before any Real release. Until then, the gate must remain closed; UI disablement is not sufficient.

F2 is a mandatory public-release remediation: establish whether the two deployed legacy functions have callers or write access, preserve relevant logs, then decommission them because they are unauthenticated public endpoints absent from active source. Validate removal and ensure there is no dependency from the current Practice site. This is a separate maintenance change and must not wait for the payment work or be mistaken for Real-mode implementation.

## Operating rules for the executor

1. Inspect the current worktree and deployment configuration before changing anything. Preserve owner changes. Do not report a repository review as a review of the deployed site; identify which environment and commit were observed.
2. Keep Practice enabled and unchanged in meaning. The server derives account mode from the authenticated, owned account. A browser mode flag, route, hidden button, or stale client state must never authorize Real activity.
3. Keep all Real account creation, funding, withdrawal, conversion, and order execution disabled by default. Sandbox credentials and endpoints must be distinct from production credentials and endpoints. No sandbox secret may enter browser code, logs, committed files, test fixtures, or screenshots.
4. Treat Daraja STK Push as the payment/funding integration for Real mode. Build and exercise the end-to-end KES funding lifecycle in sandbox first, using the same request, callback, idempotency, ledger-state, reconciliation, and user-status contracts intended for production. Daraja does not execute or price trades, prove trading profitability, or validate the digit engine. Sandbox records must remain explicitly marked and segregated; they must never be mistaken for actual customer funds or used to claim live settlement success.
5. During this plan, never send a real payment, use a live Daraja endpoint, place a Real trade, or change a production feature flag. Sandbox requests must use the owner’s sandbox environment and test numbers only. Production Daraja activation is a later, explicit Owner-approved release step after sandbox testing is satisfactory, reconciliation and security reviews pass, and production credentials/endpoints are configured separately.
6. Do not manufacture evidence, approvals, callback receipts, settlement results, elapsed soak windows, or review identities. An independent reviewer must be a different named person from the performer. A successful HTTP response is not proof of a reconciled payment.
7. Make changes in small, reviewable units. Before implementing a phase, add the test and evidence expectations for that phase to the issue/PR description. Keep the funded checklist separate from engine-v3 acceptance.

## Execution phases

### Phase 0 — Baseline and site audit

Claude records the source commit, clean/dirty worktree status, deployed URL/environment if available, deployment commit if available, and a short page-by-page UI review for registration, sign-in, dashboard, profile/account switcher, trade, funding entry points, withdrawal entry points, support, and fairness. Search server routes, database RPCs, migrations, RLS policies, scheduled jobs, and deployment variables for Real-mode and Daraja paths without revealing secret values.

Deliverables: a reviewed baseline report with source references; a list of existing Real-mode safeguards and bypass risks; an inventory of Daraja sandbox configuration using names/status only (never values); and an explicit list of unknowns. Incorporate the accepted corrections and F1/F2 actions above. Continue read-only checks for deployed state when credentials permit; a blocked query remains an unknown and must not stop source-level implementation.

Gate: there is no design gate on unknown account-specific sandbox values. Claude completes code, unit/integration fixtures, PostgreSQL work, and security review using the decisions above. Live sandbox requests remain pending until the sandbox secret names/values and test MSISDN are configured by the Owner in Supabase; report that as an external test blocker without stopping unrelated work.

### Phase 1 — Threat model and contract design

Document the user and operator flows before coding: Real account application/eligibility; required identity and step-up checks; deposit initiation; asynchronous Daraja callback; payment verification; pending/confirmed/failed/reversed/expired states; ledger posting; withdrawal review and execution; disputes/refunds; and Real order submission. Identify trust boundaries among browser, Supabase Auth, Edge Functions, Postgres, Daraja, and operations staff.

The Daraja design must establish callback authenticity/verification according to the current Daraja product documentation, replay/idempotency handling, amount/currency/account binding, duplicate and out-of-order callback handling, timeout reconciliation, reversal behavior, rate limits, audit history, and customer-safe status messages. Never trust a browser-supplied callback, transaction status, phone number, amount, or account ID as payment proof. Keep payment transaction identifiers and payload data to the minimum required; define retention and access controls.

Use Safaricom’s current [Daraja developer portal](https://developer.safaricom.co.ke/) as the primary API reference and pin the exact product/API documentation revision used in the implementation report. STK Push callback is a notification input, not independently sufficient ledger proof; use the transaction-status API or another provider-verifiable source to reconcile ambiguous outcomes before credit.

**Settlement policy (decided): USD account denomination; KES cash settlement.** USD is the customer-facing unit of account for balances, contract stakes, wins/losses, and the internal ledger. M-Pesa collects deposits in KES and any future cash withdrawals are paid in KES. The business does not convert each deposit into actual USD or promise a USD bank settlement. The USD ledger amount is calculated from a published USD/KES rate and represents the product balance denomination; actual cash remains KES. Customer terms and funding UI must state plainly that displayed USD is the account’s denomination, while cash deposits and any later withdrawals settle in KES at the disclosed rate. This removes the per-payment USD conversion/hedge dependency, but it does **not** remove FX exposure: the business holds KES against USD-denominated customer liabilities and bears the resulting treasury risk.

Use the latest published CBK daily USD/KES mean as the product’s disclosed reference rate, with no extra platform spread in v1. **Initial reference rate: USD 1 = KES 129.62, from the CBK rate posted 25 September 2026.** Treat this as the starting configuration; new quotes use the latest published daily rate, and each quote locks its rate and KES amount for five minutes. Updating the rate creates a new immutable rate version and never changes an issued quote or completed payment. CBK states that its rate is indicative, so customer terms and UI must say it is the platform’s daily reference for converting USD product amounts to KES payment amounts, not a promise that the company exchanged currency at that rate. **The minimum deposit is USD 5.00.** Reject a lower requested USD amount before creating a payment intent. Show USD amount, exact KES amount, rate, rate date, and any separately charged Daraja fee before payment authorization. The customer selects a USD deposit amount; the server computes `KES_due = ceil(USD_amount * KES_per_USD)` to a whole shilling with exact decimal/integer arithmetic. At the initial rate, a USD 5.00 deposit requires KES 649 (`ceil(5.00 × 129.62)`). On a confirmed callback/status result for that exact KES amount, credit the locked USD amount in the USD ledger. Never recalculate a completed payment using a newer rate. Persist the immutable rate value/date/source, policy version, quote ID, KES due, USD credit, quote expiry, provider IDs, and callback/status evidence.

Rates update to a new immutable version when CBK publishes a new daily rate; the quote is valid for initiating STK Push for five minutes. If the rate is missing, malformed, or older than 72 hours, fail closed for new payment intents. Once STK Push is initiated, its quote remains bound to that payment through final reconciliation. For an ambiguous outcome, query Daraja status and do not issue another push until the first is resolved. Failed or reversed payments create compensating USD ledger postings tied to the original KES payment; never edit history. Any rounding difference from whole-KES charging is disclosed and recorded in a named rounding account.

Keep KES cash/clearing records separate from USD customer ledger liabilities. Daily reconcile Daraja gross KES receipts and fees to the KES bank/merchant balance, and reconcile USD ledger liabilities using the same rate snapshot used by each deposit. Treasury must calculate KES coverage for all outstanding customer liabilities—including available balances, open-contract maximum payouts, pending refunds, and accepted but unpaid KES withdrawals—at the current rate plus an adverse 10% KES depreciation stress. Require KES liquid reserve of at least 110% of that stressed liability amount; alert below 120%, automatically pause new deposits and Real contract purchases below 110%, and trigger an incident with same-day treasury funding below 100%. These are the v1 control thresholds and must be independently tested before launch. Finance records period-end FX gains/losses and KES cash valuation under the company’s applicable accounting policy and auditor guidance. Withdrawals, when separately released, quote the KES payout for a requested USD amount using the then-current published rate and lock the USD debit/KES payout together; the business bears movement after quote acceptance and before payout completion. This is an internal denomination conversion, not an actual USD settlement.

This follows the common separation between customer-facing/presentment currency and provider settlement currency, while choosing KES as the actual merchant cash settlement currency. See the [Adyen currency-conversion model](https://docs.adyen.com/marketplaces/currency-conversion/payments), [Stripe currency and settlement model](https://docs.stripe.com/currencies), [IAS 21](https://www.ifrs.org/issued-standards/list-of-standards/ias-21-the-effects-of-changes-in-foreign-exchange-rates/), and [CBK rate explanation](https://www.centralbank.go.ke/rates/forex-exchange-rates/).

**Sandbox boundary:** Daraja sandbox proves only the KES request/callback/status/replay lifecycle and that the agreed reference-rate formula maps the test KES payment to the locked USD ledger credit. It does not prove production settlement cash, treasury coverage, financial statements, or Real trading readiness. Automated conversion arithmetic uses deterministic fixed test rates; never label those fixtures as an executed FX transaction.

Real execution uses the existing self-generated digit contracts. Daraja is only the KES funding rail. Real stake debits, payouts, fees, and refunds remain USD amounts in the USD ledger and require atomic posting, immutable account mode, account-scoped idempotency, reconciliation, limits, and controlled void/refund procedures. Before production activation, obtain the required legal/regulatory review for this product and jurisdiction; that review is a release evidence item, not a design question for Claude.

Deliverables: reviewed architecture/data-flow diagram; threat model; status/state transition tables; API and database contracts; scoped permissions; failure and recovery matrix; and unresolved product/legal/operations questions. No secrets or live endpoints in these artifacts.

### Phase 2 — Real-mode funding flow against Daraja sandbox (sandbox only)

Implement the Real-mode funding flow end-to-end against the server-side Daraja sandbox adapter using STK Push, callback, and transaction-status query/reconciliation. Prove the daily reference-rate snapshot, USD-to-whole-KES quote formula, quote lock, KES amount binding, USD ledger credit, expiry, rounding account, and daily KES cash/USD liability reconciliation using deterministic fixed test rates. Post USD only to the USD ledger and retain KES collection/clearing separately. Use production-shaped payment records and ledger state transitions, while marking the environment and resulting funds as sandbox/test and non-spendable. Keep all credentials in the platform secret store. Make sandbox vs production selection explicit and server-side; production mode must fail closed if any sandbox credential or endpoint is configured, and sandbox mode must refuse production credentials/endpoints. Callback handlers must treat callback contents as untrusted, bind them to a pending payment, deduplicate by provider transaction identity, reconcile via provider status where needed, and transition a payment through an explicit state machine.

Sandbox success may create a clearly labeled sandbox payment record or non-spendable test balance in the Real-mode test flow. It must not credit a spendable production Real customer wallet, set `REAL_READY`, or open the production Real gate. Test callback replay, forged/invalid callback, duplicate transaction, amount mismatch, wrong account reference, delayed callback, timeout, reversal, and reconciliation of provider records against internal records. Never attempt to trigger disbursement to a real recipient.

Deliverables: sandbox-only Real-mode funding flow evidence with redacted request/response artifacts, tests, reconciliation report, and independent review. Record actual environment, source commit, time interval, performer, reviewer, and artifact digests/references per the strengthened evidence schema. Owner acceptance of this sandbox phase is the prerequisite to preparing production Daraja configuration; it is not automatic permission to activate production payments.

### Phase 3 — Real-mode foundations, still disabled

Implement only after the design and sandbox review. Add Real funding and ledger foundations without enabling customer usage: immutable typed account mode; account ownership/status checks; payment-to-ledger transactional boundaries; suspense/pending funds; reversal/void accounting; funding and balance reconciliation; step-up authentication; staff approval separation; immutable audit trail; limits and restrictions; account-scoped idempotency; privacy/retention; and monitoring/incident controls. Real withdrawals require separately approved controls and must not be inferred from a successful deposit integration. Fix F1 in the database-enforced release gate and close F2 before public Real release.

For the selected digit-contract product, prove that each entry and settlement has valid scheduled witnesses, applicable policy, seed custody, independent verification, and deterministic USD ledger settlement. A Practice result or sandbox payment cannot satisfy this.

### Phase 4 — Independent verification and release decision

Run the full required test matrix using real PostgreSQL for migrations, cryptographic parity, access control, contract gate, and worker integration. PGlite may supplement but cannot replace PostgreSQL. Run `npm ci`, the repository test/build/browser checks required by the current executor brief, and any Daraja sandbox conformance tests. Distinguish code checks from elapsed operational evidence.

Update `docs/REAL_READINESS_CHECKLIST.md` only with explicit, independently reviewed evidence requirements and immutable published versions. Update the relevant runbook and ADR with deployment order, thresholds, alert routing, rollback/void procedure, key/root rotation, sandbox-to-production separation, provider outage handling, reconciliation, and the precise scope/limits of independent proof. Update `docs/ENGINE_V3_ACCEPTANCE.md` only from fresh final checks; do not combine it with the funded checklist.

The production Daraja payment decision remains closed until sandbox testing is satisfactory to the Owner, production-specific security and reconciliation controls are reviewed, production credentials and endpoints are configured separately, and the Owner explicitly authorizes activation. The Real trading decision remains separately closed until every published Real checklist item has valid evidence and separate Owner authorization. Claude may prepare a reviewable release packet but must not enable production payments or Real trading.

## Required gates and observable statuses

Maintain distinct statuses for:

- `CODE_READY`: required automated and real-PostgreSQL checks pass for the candidate commit.
- `PRACTICE_READY`: code gates plus deployed Practice operations and required witnessed/soak evidence pass.
- `DARAJA_SANDBOX_READY`: Daraja sandbox request/callback/status lifecycle passes; it makes no claim about FX conversion or live settlement.
- `KES_USD_QUOTE_READY`: Daraja sandbox lifecycle, daily reference-rate quote, KES collection/USD ledger posting, treasury exposure controls, and reconciliations pass in tests and independently reviewed staging evidence. No actual USD conversion is claimed.
- `DARAJA_PRODUCTION_READY`: sandbox acceptance, `KES_USD_QUOTE_READY`, production-specific security/reconciliation and treasury controls, real Daraja credentials and endpoint separation, operational readiness, independent Owner review, and explicit Owner authorization for KES production payments are complete.
- `REAL_READY`: every published Real-trading checklist item has been independently reviewed, and the Owner has explicitly authorized Real digit-contract trading. This is separate from payment-provider activation.

For every status, the project Owner reviews Claude’s evidence and records their actual identity and review time. Pending owner review means the status remains pending; Claude cannot set the accepted status alone.

Any pending required row keeps the relevant status non-ready and returns a failing command status. Never display a ready label while required rows are pending. Daraja sandbox success never implies `KES_USD_QUOTE_READY`, `DARAJA_PRODUCTION_READY`, or `REAL_READY`; enabling production deposits does not enable Real trading.

## Minimum review scenarios

### Account and trading isolation

- A Practice user cannot select, query, fund, trade, withdraw from, or infer data about another account.
- A Real account cannot be created or used while the gate is closed, including by direct RPC, forged request, stale session, or modified browser state.
- DEMO and REAL accounts, balances, ledger entries, orders, events, restrictions, policies, and limits cannot cross-link or be mode-switched.
- Currency: reject deposits below USD 5.00 and amount/currency mismatches; verify KES payment intents and callbacks reconcile to the exact KES amount; verify the USD amount is locked from the CBK reference-rate snapshot and the KES due rounds up to whole shillings; test stale rate, quote expiry, delayed payment, late callback, rate change, reversal, provider outage, KES coverage cap, and daily KES-cash/USD-liability reconciliation. This conversion is product accounting; assert that no actual USD conversion is claimed or required.
- Practice regressions are checked after every Real-foundation migration.

### Daraja sandbox funding

- Valid sandbox initiation; valid callback; delayed callback; callback before/after client timeout.
- Duplicate callback and replay; invalid signature/verification; altered amount/currency/reference; unknown or mismatched account; malformed payload.
- Reversal/refund; provider outage; internal database outage; retry after unknown outcome; reconciliation difference and operator resolution.
- No test case can credit a spendable Real account or execute an external payment.

### Real contract and operations

- Direct purchase attempt with gate closed; stale feed/worker; unwitnessed/late epoch; insufficient funds; limit breach; duplicate idempotency key; settlement retry; worker restart; reconciliation and void/refund.
- Role matrix across customer, support, staff, finance/reconciliation, worker, attestor, database owner, and key administrator.
- Alert delivery and response drill for provider, database, worker, key, callback, reconciliation, and suspicious access outages.

## Reviewer audit checklist for Claude’s output

The reviewer should reject the implementation packet if it:

- calls the current site production-Real-ready based on UI controls, enum presence, Daraja sandbox success, or historical engine-v3 output;
- exposes keys, secrets, personal data, or callback payloads in browser assets, committed files, test logs, or evidence;
- accepts a payment callback without provider verification, durable deduplication, binding to the initiated payment, and ledger reconciliation;
- credits spendable balance before the server has established the payment state;
- uses payment provider status as proof of a trading fill or contract outcome;
- trusts client-supplied execution mode, account, amount, beneficiary, provider status, or trade price;
- uses sandbox credentials/endpoints for production or production credentials/endpoints in sandbox;
- retries an uncertain payment or trade with a new idempotency identity;
- allows a single operator to approve their own evidence or financial adjustment;
- marks a readiness status as passed while required evidence, real-PostgreSQL checks, operational intervals, or independent reviews are missing.

## Final report format

Claude’s handoff must include:

1. Exact source commit and observed deployment environment/commit, with repository-only vs deployed-site findings separated.
2. Files changed and design decisions, including any owner-owned pre-existing changes preserved.
3. Findings ranked by severity, with file/function/policy references and concrete impact.
4. Tests run with exact commands, database type/version, environment, results, and failures.
5. Daraja sandbox coverage and reconciliation evidence, with all identifiers/secrets appropriately redacted.
6. `CODE_READY`, `PRACTICE_READY`, `DARAJA_SANDBOX_READY`, `KES_USD_QUOTE_READY`, `DARAJA_PRODUCTION_READY`, and `REAL_READY` statuses, each supported by explicit evidence or pending blockers.
7. Remaining external dependencies and the specific next action needed to close each one.
