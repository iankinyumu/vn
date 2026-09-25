# Real-mode funding design: Daraja STK Push (Phase 1)

**Plan:** `docs/CLAUDE_REAL_MODE_DARAJA_SANDBOX_AUDIT_PLAN.md`. **Baseline:** `docs/REAL_MODE_PHASE0_BASELINE.md`.
**Performer:** Claude. **Reviewer:** Owner (pending). The design is unreviewed and does not authorize production payments or Real trading.

The decisions this design implements were fixed in the plan and are not reopened here: USD ledger with KES cash settlement, STK Push first, Supabase Edge Function callback, and the existing digit contracts.

## 1. Provider reference

The contract follows Safaricom Daraja 3.0 **M-Pesa Express** (STK Push, and STK Push Query) and **Authorization** (OAuth client credentials). The portal (<https://developer.safaricom.co.ke/>) is client-rendered and could not be fetched and pinned on 2026-09-25, so **the documentation revision is UNVERIFIED**. The Owner must compare the contract below with the portal and record the page and date in §12 before Phase 2 sandbox evidence is accepted.

| Call | Sandbox | Production (not used) |
| --- | --- | --- |
| OAuth | `GET https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials` (Basic `key:secret`) | `https://api.safaricom.co.ke/...` |
| STK Push | `POST /mpesa/stkpush/v1/processrequest` | same path |
| STK Push Query | `POST /mpesa/stkpushquery/v1/query` | same path |

- **Request fields:** `BusinessShortCode`, `Password = base64(ShortCode + Passkey + Timestamp)`, `Timestamp` (`YYYYMMDDHHmmss`, Africa/Nairobi), `TransactionType` (`CustomerPayBillOnline` or `CustomerBuyGoodsOnline`), `Amount` (whole KES), `PartyA` (MSISDN), `PartyB`, `PhoneNumber`, `CallBackURL`, `AccountReference` (≤ 12 characters) and `TransactionDesc` (≤ 13 characters).
- **Callback body:** `Body.stkCallback{MerchantRequestID, CheckoutRequestID, ResultCode, ResultDesc, CallbackMetadata.Item[Amount, MpesaReceiptNumber, TransactionDate, PhoneNumber]}`.
- **Callback security:** Daraja does not sign callbacks. **A callback is therefore an untrusted notification.**

## 2. Trust boundaries

```
Browser ──(Supabase JWT)──▶ Postgres RPC: rate, quote, my deposits (read)
Browser ──(Supabase JWT)──▶ Edge fn funding-deposit ──(service role)──▶ Postgres funding_svc_*
                                   └──(OAuth, TLS)──▶ Daraja STK Push
Daraja ──(public HTTPS, ?t=<per-payment token>)──▶ Edge fn daraja-callback ──▶ Postgres funding_svc_*
                                                          └──▶ Daraja STK Push Query (verification)
Scheduler ──(X-Funding-Cron-Secret)──▶ Edge fn funding-reconcile ──▶ Daraja STK Push Query ──▶ Postgres
Staff (owner, aal2, fresh TOTP) ──▶ Postgres RPC: rates, treasury snapshots, testers, reversals (two-person)
```

- **Browser:** trusted for nothing except the user's own choices (USD amount, phone number). It never supplies account mode, KES amount, rate, status, receipt or callback data.
- **Edge Functions:** hold Daraja credentials, which live only in the Supabase secret store. The Vercel site holds no credentials and receives no callbacks. Engine cron jobs and engine functions never read funding credentials (`indices build.md:81`).
- **Postgres:** the authority for state. Every state transition and ledger posting happens inside one SQL function under row locks. Edge Functions only relay provider facts into those functions.
- **Daraja:** trusted when Claude's code calls it over TLS with OAuth (STK Push Query). It is **not** trusted when it calls in (callbacks).

## 3. Money model

- **Unit of account:** USD for every customer balance, stake, payout, fee and refund. **Cash:** KES. No real currency exchange takes place.
- **Reference rate:** the CBK daily USD/KES mean, published as immutable versions in `funding.fx_rate_versions`. The initial version is **129.62 KES per USD, dated 2026-09-25**. A rate older than 72 hours, or a missing or malformed rate, makes new quotes fail closed (`rate_stale`, `rate_unavailable`).
- **Quote:** the customer picks a USD amount of at least 5.00, with at most 2 decimal places. The server computes `kes_due = ceil(usd × rate)` in exact `numeric`, and `kes_rounding = kes_due − usd × rate` (≥ 0 and < 1 KES). The quote locks the rate version, amounts and policy version for **300 seconds**. At the initial rate, USD 5.00 gives KES 649 with KES 0.90 of rounding.
- **Credit:** a confirmed payment posts exactly the locked `usd_amount` to the USD ledger. Nothing recalculates it later.
- **KES side:** `funding.kes_clearing_entries` records RECEIPT (= `kes_due`), ROUNDING (the named rounding account, informational), and REVERSAL (−`kes_due`). KES amounts never enter the USD ledger.
- **USD side (sandbox):** `funding.usd_ledger_transactions` and `funding.usd_ledger_entries`, with a balanced-per-transaction constraint. The accounts are `CUSTOMER_TEST_BALANCE` (per user, **non-spendable**, never read by the engine) and `DEPOSIT_CLEARING`. This ledger is separate from `public.ledger_*`, so a sandbox credit cannot reach a trading wallet.
- **USD side (production, not enabled):** a later reviewed migration posts to the owned REAL trading account's `AVAILABLE` against a funding counterpart through `engine_post_ledger`, with the same idempotency key `deposit-<payment id>`. In this release every production path raises `production_payments_disabled`.
- **Policy v1** (`funding.deposit_policy_versions`): minimum USD 5.00, maximum KES 250,000 per payment, quote TTL 300 s, rate staleness 72 h, spread 0. *The KES 250,000 cap is the M-Pesa per-transaction limit as understood. The Owner must verify it.*

## 4. Payment state machine

| State | Meaning | Entered by | Next states |
| --- | --- | --- | --- |
| `INITIATING` | Payment row exists and the quote is consumed. STK Push is about to be sent | `funding_svc_begin_payment` | `PENDING`, `REJECTED`, `UNKNOWN`, `VERIFYING` (callback raced ahead) |
| `PENDING` | Daraja accepted the push (`ResponseCode 0`) and the CheckoutRequestID is stored | `funding_svc_record_initiation` | `VERIFYING`, `CONFIRMED`, `FAILED`, `MANUAL_REVIEW` |
| `UNKNOWN` | The initiation outcome is ambiguous (timeout, 5xx or network error) and no CheckoutRequestID is known | `funding_svc_record_initiation` | `VERIFYING` (token-bound callback), `EXPIRED` |
| `VERIFYING` | A callback arrived and is waiting for provider status confirmation | `funding_svc_record_callback` | `CONFIRMED`, `FAILED`, `MANUAL_REVIEW` |
| `CONFIRMED` | STK Push Query returned `ResultCode 0` and the amounts bind. USD is credited in the same transaction | `funding_svc_record_status` | `REVERSED` |
| `FAILED` | The provider reports a final non-success (cancelled 1032, unreachable 1037, insufficient funds 1, wrong PIN 2001, expired 1019, …) | `funding_svc_record_status` | — |
| `REJECTED` | Daraja refused the initiation (`ResponseCode ≠ 0` or 4xx). No money moved | `funding_svc_record_initiation` | — |
| `EXPIRED` | `UNKNOWN` for 24 h with no token-bound callback. Queued for the operator to check against the M-Pesa statement | `funding_svc_expire_stale` | `MANUAL_REVIEW` |
| `MANUAL_REVIEW` | A conflict: amount mismatch, callback success with query failure (or the reverse), a callback after a final state, or query errors past 24 h | several | `CONFIRMED` or `FAILED` (owner resolution) |
| `REVERSED` | A compensating posting was made after two-person approval | `funding_approve_action` (REVERSE) | — |

Rules:

1. **Only `funding_svc_record_status` credits,** and only when the query says `ResultCode 0`, the payment is `PENDING`/`VERIFYING`, and any callback amount equals `kes_due`. A callback success alone never credits. A query success with no callback still credits, because the amount was fixed by the push itself. `receipt_pending` is then set for statement reconciliation.
2. **Idempotency.** The ledger key is `deposit-<payment id>`. Initiation is idempotent per `(user, idempotency_key)`. Provider events are unique on `dedupe_key = sha256(source|checkout id|result code|receipt)`, so a replay is stored once and counted.
3. **One open payment per user.** While a payment is `INITIATING`/`PENDING`/`UNKNOWN`/`VERIFYING`, `begin_payment` refuses a new one (`payment_in_progress`). An ambiguous push is never retried under a new identity.
4. **Final states are sticky.** An event arriving after a final state is recorded with verdict `LATE` or `CONFLICT`. A conflicting success after `FAILED` moves the payment to `MANUAL_REVIEW` and never auto-credits.
5. **Reversal:** a request from one staff owner and approval by a **different** owner. The compensating USD entries and the KES REVERSAL entry are tied to the original payment, and history is never edited.

## 5. Callback binding and authenticity

- Every payment gets a 256-bit random token generated in the Edge Function. Only `sha256(token)` is stored. The token appears only inside the `CallBackURL` query string sent to Daraja, so the callback is bound to exactly one payment even when the initiation response was lost.
- **A missing or unknown token** gives HTTP 200 `Accepted` with nothing written. A per-IP event count goes to the logs, so a forger learns nothing.
- **A known token with a mismatched CheckoutRequestID** gives verdict `CONFLICT` and `MANUAL_REVIEW`.
- **Verification:** every well-formed, token-bound callback triggers STK Push Query from the server. The query result, not the callback, decides the state.
- **Minimization:** stored fields are CheckoutRequestID, MerchantRequestID, ResultCode, ResultDesc (truncated), amount, receipt, and a masked phone number (`2547•••••123`). The raw body is not stored, only its sha256. The phone number sent to Daraja is kept masked, with a sha256 hash for matching.
- **Retention:** provider events are kept for 7 years, the finance-record default. The Owner must confirm this against legal advice. Staff read them through `funding.read`, and customers see only their own payment status.

## 6. Environment separation

The environment is chosen server-side from `DARAJA_ENV`, which must be `sandbox`. Sandbox secret names are `DARAJA_SANDBOX_CONSUMER_KEY`, `DARAJA_SANDBOX_CONSUMER_SECRET`, `DARAJA_SANDBOX_SHORTCODE`, `DARAJA_SANDBOX_PASSKEY`, `DARAJA_SANDBOX_TRANSACTION_TYPE` (optional) and `DARAJA_CALLBACK_BASE_URL`. Production would use `DARAJA_PRODUCTION_*`.

- **In sandbox mode**, the config loader refuses: any `DARAJA_PRODUCTION_*` variable, a base URL other than `https://sandbox.safaricom.co.ke`, and a callback base that is not `https://<ref>.supabase.co/functions/v1`.
- **In production mode**, it would refuse any `DARAJA_SANDBOX_*` variable and a sandbox host. In this release production mode always throws `production_not_released`.
- **In the database**, every payment carries `environment`. The value is `SANDBOX` only, while module `daraja_production` stays off with no enabling function.
- **Who may use the sandbox:** module `daraja_sandbox` must be on (owner RPC) **and** the user must be on `funding.sandbox_testers` (owner RPC, audited). Ordinary customers cannot reach sandbox payments.

## 7. Treasury coverage (v1 controls)

- **Snapshot:** `funding.treasury_snapshots` holds the environment, KES liquid reserve, the time it was recorded, the recording staff member, and a note.
- **Liability:** USD customer balances + open Real contract maximum payouts + pending refunds + accepted unpaid withdrawals. Only the first term exists today. Real contracts and withdrawals are closed, so the other terms are 0, and the function sums them so they take effect when those features exist.
- **Stress:** `stressed_kes = liability_usd × current rate × 1.10`, and `coverage = reserve / stressed_kes`. A zero liability counts as full coverage.
- **Levels:**

  | Coverage | Status | Effect |
  | --- | --- | --- |
  | ≥ 1.20 | `OK` | — |
  | < 1.20 | `ALERT` | — |
  | < 1.10 | `PAUSED` | New payments refused with `treasury_paused` |
  | < 1.00 | `INCIDENT` | New payments refused |

- **Fail closed:** no snapshot, or a snapshot older than 24 h, refuses new payments (`treasury_unknown`).
- **Real purchases:** pausing Real contract purchases on `PAUSED` is a Phase 3 hook into `engine_buy_contract`. Real purchase is already refused by the gate today.

## 8. Reconciliation

`funding_svc_reconcile(environment, day)` writes an immutable `funding.reconciliation_runs` row with `MATCHED` or `DIFFERENCES`. It checks:

1. Every `CONFIRMED` or `REVERSED` payment has exactly one ledger credit of `usd_amount`, and a reversal has the matching debit.
2. KES RECEIPT for the day equals the sum of `kes_due` over the day's confirmed payments.
3. The customer test balance equals confirmed credits minus reversals.
4. No payment is stuck in a non-final state past its window.
5. Every `receipt_pending` credit is listed for comparison with the statement.

A provider statement comparison needs the M-Pesa org portal statement, entered by finance as daily totals through `funding_record_statement_total`. Differences are resolved by an owner note, and the resolver must differ from whoever entered the statement.

## 9. API contracts

**Customer RPCs** (authenticated; they read `auth.uid()` and take no account or mode argument):

| RPC | Returns |
| --- | --- |
| `funding_reference_rate()` | `{kes_per_usd, rate_date, source, version, stale}` |
| `funding_create_deposit_quote(p_usd_amount numeric)` | `{quote_id, usd_amount, kes_due, kes_per_usd, rate_date, expires_at, environment}` |
| `funding_my_payments()` | Own payments with a customer-safe `status_message` |

**Edge Function `funding-deposit`** (JWT verified): `POST {quote_id, phone, idempotency_key}` returns `{payment_id, state, status_message}`. Errors use stable codes, for example `quote_expired`, `payment_in_progress`, `sandbox_not_enabled`, `treasury_paused` and `provider_unavailable`.

**Edge Function `daraja-callback`** (public): always returns `200 {"ResultCode":0,"ResultDesc":"Accepted"}`.

**Edge Function `funding-reconcile`** (`X-Funding-Cron-Secret`) queries stale open payments, expires `UNKNOWN`, and runs the daily reconciliation.

**Service RPCs** (`service_role` only): `funding_svc_begin_payment`, `funding_svc_record_initiation`, `funding_svc_record_callback`, `funding_svc_record_status`, `funding_svc_open_payments`, `funding_svc_expire_stale`, `funding_svc_reconcile`.

**Staff RPCs:**

| Capability | Role | RPCs |
| --- | --- | --- |
| `funding.manage` | owner, aal2, fresh TOTP | `funding_publish_rate`, `funding_record_treasury_snapshot`, `funding_set_sandbox_module`, `funding_set_sandbox_tester`, `funding_record_statement_total`, `funding_resolve_reconciliation`, `funding_request_action` and `funding_approve_action` (see below) |
| `funding.read` | owner, administrator | `funding_staff_overview` (read-only) |

Every financial decision (`REVERSE`, `RESOLVE_CONFIRMED`, `RESOLVE_FAILED`) is a `funding.staff_actions` row. One owner requests it and a **different** owner approves it. A check constraint enforces this, and so does `second_approver_required`.

## 10. Failure and recovery matrix

| Failure | Behavior |
| --- | --- |
| Daraja OAuth or STK Push times out | The payment goes to `UNKNOWN`. The customer sees "checking with M-Pesa". No new push is sent while it is unresolved. A token-bound callback or the operator statement check resolves it |
| Callback lost | `funding-reconcile` queries `PENDING` payments after 60 s. The query decides |
| Callback duplicated or replayed | Unique `dedupe_key`. The state machine and ledger key block a double credit |
| Callback forged without a token | Ignored |
| Callback forged with a stolen token | It cannot credit: the credit requires the server's own STK Push Query result |
| Amount altered in the callback | `MANUAL_REVIEW` with no credit |
| Query errors (provider outage) | The payment stays open. After 24 h it goes to `MANUAL_REVIEW` |
| Database outage during a callback | The Edge Function returns 500 so Daraja may retry. The next reconcile run queries anyway |
| Rate stale | New quotes are refused. Issued quotes and open payments are unaffected |
| Treasury below 110% | New payments are refused. Open payments are finalized normally |
| Customer paid but the credit failed | The ledger post is in the same transaction as the state change, so both happen or neither does. The next reconcile run retries through the query |

## 11. Threat model (STRIDE summary)

| Threat | Control |
| --- | --- |
| Spoofed callback | Per-payment token plus server-side STK Push Query before any credit |
| Tampered amount, account or phone | Binding to the locked quote. The browser never supplies money fields |
| Repudiation by staff | `admin_audit_events` on every staff RPC. Reversals need two people |
| Information disclosure | No secrets in browser, repository, logs or fixtures. Masked phone numbers only. Payload hashes, not payloads |
| Denial of service on the callback | Unknown tokens cost one hash lookup. Rate limits come from the Supabase platform |
| Elevation (a customer crediting themselves) | All writes go through `service_role` or staff-gated definer functions. The funding schema has no grants to `anon` or `authenticated` |
| Sandbox funds mistaken for real | A separate ledger, `environment` on every row, a non-spendable account, and labels on every view |

## 12. Open items (not design questions for Claude)

- The Owner must confirm the pinned Daraja doc revision (§1) and the KES 250,000 cap.
- Legal and regulatory review of the product and jurisdiction (a release evidence item).
- The retention period (§5).
- The production counterpart account and the deposit posting migration (Phase 3).
- The treasury pause hook in `engine_buy_contract` (Phase 3).
- F1 gate replacement (Phase 3).
- Customer funding UI and disclosure copy, to follow once the sandbox flow is accepted.
- The CBK rate is published manually by the owner each business day. Automated CBK fetching is out of scope for v1.
