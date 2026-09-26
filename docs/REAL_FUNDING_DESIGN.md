# Real-mode funding design: Daraja STK Push (Phase 1)

**Plan:** `docs/CLAUDE_REAL_MODE_DARAJA_SANDBOX_AUDIT_PLAN.md`. **Baseline:** `docs/REAL_MODE_PHASE0_BASELINE.md`.
**Performer:** Claude. **Reviewer:** Owner (pending). The design is unreviewed and does not authorize production payments or Real trading.
**Revision:** updated for the Phase 2 supervisor review (`docs/REAL_MODE_PHASE2_SUPERVISOR_REVIEW.md`, findings R1–R5): callback binding (§5), limits (§3), projected coverage and funded suspense (§7), net KES reconciliation (§8), statement evidence and wrapper contracts (§9).

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
- **STK Push Query** returns the status of the queried `CheckoutRequestID` only. As consumed here it does not return an authoritative amount, phone, account reference or receipt, so a successful query proves that *someone* completed *that* checkout, not that it belongs to a given payment. The binding comes from where the checkout id came from (§5).
- **Provider ceiling (pinned 2026-09-26):** KES 250,000 per transaction for Send Money, Lipa Na M-PESA BuyGoods, PayBill and all other transactions, per Safaricom's press release "Safaricom Gets Approval To Increase M-PESA Transaction Limits to KSh. 250,000" (<https://www.safaricom.co.ke/media-center-landing/press-releases/safaricom-gets-approval-to-increase-m-pesa-transaction-limits-to-ksh-250-000>, accessed 2026-09-26, page SHA-256 `bb9ebb7c18d089c04d11756b190291ce04e3300337545d1eb4ababe338f54994`). The same page cites a KES 500,000 daily limit. The PayBill tariff form (<https://www.safaricom.co.ke/images/Downloads/one-account-tariff-form.pdf>, accessed 2026-09-26, SHA-256 `60200b9aaecb95687bd56031b3c4e12f84172058142567e01e1501e99288b1f3`) was downloaded but its band table was not machine-extracted. The product limits in §3 are far lower, and the provider ceiling stays a second hard limit.

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
- **Policy v1** (`funding.deposit_policy_versions`): minimum USD 5.00; **USD 500 per deposit; USD 1,000 of successful deposits and at most three successful deposits per customer per rolling 24 hours**; KES 250,000 per payment (provider ceiling, §1, which a policy row cannot raise); quote TTL 300 s; rate staleness 72 h; spread 0.
- **Limit enforcement** (`funding.limit_refusal`) uses the locked USD amounts, server-side, three times: at quote, at payment start (counting this customer's credits in the last 24 h plus every payment of theirs that could still be credited: `INITIATING`, `PENDING`, `UNKNOWN`, `VERIFYING`, `MANUAL_REVIEW`, `EXPIRED`), and again in the crediting transaction (credits in the last 24 h plus this one). A successful deposit is one with a deposit credit, dated by that credit. The latest policy version applies; no version, or a version without limits, fails closed with `deposit_policy_unavailable`. Policy changes ship as reviewed migrations. Refusals: `amount_below_minimum`, `amount_above_maximum`, `deposit_limit_reached`.

## 4. Payment state machine

| State | Meaning | Entered by | Next states |
| --- | --- | --- | --- |
| `INITIATING` | Payment row exists and the quote is consumed. STK Push is about to be sent | `funding_svc_begin_payment` | `PENDING`, `REJECTED`, `UNKNOWN`, `MANUAL_REVIEW` (a callback arrived before the initiation response) |
| `PENDING` | Daraja accepted the push (`ResponseCode 0`). The CheckoutRequestID from that synchronous response is stored with `initiated_at`: the payment's **bound checkout** | `funding_svc_record_initiation` | `VERIFYING`, `CONFIRMED`, `FAILED`, `MANUAL_REVIEW` |
| `UNKNOWN` | The initiation outcome is ambiguous (timeout, 5xx or network error) and no checkout is bound | `funding_svc_record_initiation` | `MANUAL_REVIEW` (any callback), `EXPIRED` |
| `VERIFYING` | A callback for the bound checkout arrived and is waiting for provider status confirmation | `funding_svc_record_callback` | `CONFIRMED`, `FAILED`, `MANUAL_REVIEW` |
| `CONFIRMED` | The provider confirmed the money and the USD credit posted in the same transaction | `funding.confirm_and_credit` (from `funding_svc_record_status` or an approved `RESOLVE_CONFIRMED`) | `REVERSED` |
| `FAILED` | The provider reports a final non-success (cancelled 1032, unreachable 1037, insufficient funds 1, wrong PIN 2001, expired 1019, …) | `funding_svc_record_status` | `MANUAL_REVIEW` |
| `REJECTED` | Daraja refused the initiation (`ResponseCode ≠ 0` or 4xx). No money moved | `funding_svc_record_initiation` | — |
| `EXPIRED` | `UNKNOWN` for 24 h with no callback. Queued for the operator to check against the M-Pesa statement | `funding_svc_expire_stale` | `MANUAL_REVIEW` |
| `MANUAL_REVIEW` | A conflict (amount mismatch, callback/query disagreement, a callback after a final state, query errors past 24 h), an **unbound callback** (§5), or **funded suspense** (§7) | several | `CONFIRMED` (owner resolution with statement evidence, §9) or `FAILED` (owner resolution, only if the provider never confirmed the money) |
| `REVERSED` | A compensating posting was made after two-person approval | `funding_approve_action` (REVERSE) | — |

Rules:

1. **Automatic credit** happens only in `funding_svc_record_status`, and only when: the queried checkout is the payment's bound checkout; the query says `ResultCode 0`; the payment is `PENDING`/`VERIFYING`; any callback amount equals `kes_due`; and, re-checked in the same transaction, the customer limits (§3) and the projected treasury coverage (§7) hold. A callback success alone never credits. A query success with no callback still credits, because the amount was fixed by the push itself and the checkout came from our own push. `receipt_pending` is then set for statement reconciliation.
2. **Manual credit** happens only through an approved `RESOLVE_CONFIRMED` that cites a binding provider statement item (§9), with the same limit and coverage re-check. If that check fails, the approval is refused and the payment stays in review.
2. **Idempotency.** The ledger key is `deposit-<payment id>`. Initiation is idempotent per `(user, idempotency_key)`. Provider events are unique on `dedupe_key = sha256(source|checkout id|result code|receipt)`, so a replay is stored once and counted.
3. **One open payment per user.** While a payment is `INITIATING`/`PENDING`/`UNKNOWN`/`VERIFYING`, `begin_payment` refuses a new one (`payment_in_progress`). An ambiguous push is never retried under a new identity.
4. **Final states are sticky.** An event arriving after a final state is recorded with verdict `LATE` or `CONFLICT`. A conflicting success after `FAILED` moves the payment to `MANUAL_REVIEW` and never auto-credits.
5. **Reversal:** a request from one staff owner and approval by a **different** owner. The compensating USD entries and the KES REVERSAL entry are tied to the original payment, and history is never edited.

## 5. Callback binding and authenticity

- Every payment gets a random token (two v4 UUIDs, 244 random bits) generated in the Edge Function. Only `sha256(token)` is stored. The token is sent to Daraja inside the `CallBackURL` query string. **It is a correlation secret, not an authenticator:** a query string must be assumed observable in provider and platform access logs, so the design gives a token holder no path to credit.
- **The bound checkout.** The only CheckoutRequestID the server ever queries is the one returned in the synchronous STK Push response, stored with `initiated_at` by `funding_svc_record_initiation`. A callback never writes `checkout_request_id`.
- **A missing or unknown token** gives HTTP 200 `Accepted` with nothing written, so a forger learns nothing.
- **A known token, payment with a bound checkout, different CheckoutRequestID** gives verdict `CONFLICT` and `MANUAL_REVIEW`. The claimed checkout is never queried.
- **A known token, payment with no bound checkout** (`UNKNOWN`, `INITIATING` whose response has not arrived or never will, `EXPIRED`, `REJECTED`) gives verdict `UNBOUND`. The claimed id is kept in `callback_checkout_request_id`, the payment goes to `MANUAL_REVIEW` (`callback_without_initiation_checkout`), nothing is queried, and nothing is credited automatically. This closes the attack in which a leaked token is paired with another customer's successful checkout id: STK Push Query of that id would succeed, but it proves only that someone paid. Such a payment can be credited only by a two-person `RESOLVE_CONFIRMED` citing a provider statement line that binds to it (§9). A callback that beats a slow initiation response lands in the same place; the later response records the bound checkout but does not reopen automatic crediting.
- **Verification:** a well-formed callback for the bound checkout triggers STK Push Query of the bound checkout. The query result, not the callback, decides the state.
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
- **Stress:** `stressed_kes = liability_usd × rate × 1.10`, and `coverage = reserve / stressed_kes`. The status view (`treasury_status`) uses current liabilities at the current rate, and a zero liability reads as full coverage there. **Admission and credit never use it; they use the projection below.**
- **Projected coverage** (`funding.coverage(env, extra_usd, floor_rate)`) adds the new liability and converts at the higher of the current rate and the quote's locked rate:
  - **At payment start** (`funding_svc_begin_payment`): current liabilities + every open, uncredited deposit in the environment + this quote. The check runs under an environment-wide advisory lock, so concurrent admissions cannot both spend the same headroom. A KES 0 reserve projects to `INCIDENT` for the first deposit.
  - **At credit** (`funding.confirm_and_credit`): current liabilities + this credit, re-checked with the customer limits in the same transaction, under the same lock, immediately before the USD posting.
- **Funded suspense:** if the provider has confirmed the money but the credit-time check fails (projected coverage below the pause level, a stale or missing snapshot, or a customer limit), the KES is booked as received, no USD is posted, `provider_confirmed_at` is set and the payment goes to `MANUAL_REVIEW` with `funded_suspense_<reason>`. A payment whose money was received can never be resolved `FAILED` (`payment_funds_received`). It is credited by `RESOLVE_CONFIRMED` once coverage is restored (the approval re-checks it). A refund path for money that must go back does not exist yet: it is a Phase 3 item, and until then the payment stays in suspense and appears in reconciliation as `funded_suspense`.
- **Levels:**

  | Coverage | Status | Effect |
  | --- | --- | --- |
  | ≥ 1.20 | `OK` | — |
  | < 1.20 | `ALERT` | — |
  | < 1.10 (projected) | `PAUSED` | New payments refused with `treasury_paused`; a paid credit goes to funded suspense |
  | < 1.00 (projected) | `INCIDENT` | Same as `PAUSED` |

- **Fail closed:** no snapshot, a snapshot older than 24 h, or no rate refuses new payments (`treasury_unknown`) and holds paid credits in funded suspense.
- **Real purchases:** pausing Real contract purchases on `PAUSED` is a Phase 3 hook into `engine_buy_contract`. Real purchase is already refused by the gate today.

## 8. Reconciliation

`funding_svc_reconcile(environment, day)` writes an immutable `funding.reconciliation_runs` row with `MATCHED` or `DIFFERENCES`. It checks:

1. **USD:** every `CONFIRMED` or `REVERSED` payment has exactly one ledger credit of `usd_amount`, a reversal has the matching debit, and no other payment has a ledger entry. The customer test balance equals confirmed credits minus reversals.
2. **KES per payment:** every provider-confirmed payment (credited or in funded suspense) has exactly its `kes_due` booked as RECEIPT, and no other payment has a RECEIPT.
3. **KES statement for the day** (`funding.statement_totals`, entered by finance with `funding_record_statement_total`): opening balance, gross receipts, reversals and refunds, provider fees, net settlement moved to the bank, and closing balance of the merchant account, with `evidence_kind` (`PROVIDER_DOWNLOAD`, or `SANDBOX_SIMULATED` in sandbox only), an evidence reference and the evidence file's SHA-256. The run checks that:
   - gross equals the day's booked RECEIPTs, and reversals equal the day's booked REVERSALs;
   - the statement rolls forward: `opening + gross − reversals − fees − net_settlement = closing`;
   - the opening equals the previous day's closing, and there is no gap between statement days.
   A day without a statement is a difference (`statement_missing`), never a match.
4. **Statement lines:** every provider statement item of the day belongs to a payment (bound item or matching receipt). An unmatched line is money on the statement that is not in the books.
5. **Attention:** payments stuck past their window, `MANUAL_REVIEW` (including funded suspense) and `EXPIRED` are listed. The summary reports gross, reversals, funded-suspense KES, the statement figures, whether they are simulated, and `receipt_pending` credits.

A run with differences stays `DIFFERENCES` until an owner resolves it with a note. The resolver may not have recorded the day's statement or any of the day's statement items. Sandbox evidence must say `SANDBOX_SIMULATED` unless it really is a downloaded provider statement; the summary's `statement.simulated` makes the distinction visible in every run.

## 9. API contracts

**Customer RPCs** (authenticated; they read `auth.uid()` and take no account or mode argument):

| RPC | Returns |
| --- | --- |
| `funding_reference_rate()` | `{kes_per_usd, rate_date, source, version, stale, min_usd, max_usd_per_deposit, max_usd_rolling_24h, max_deposits_rolling_24h, policy_version}` |
| `funding_create_deposit_quote(p_usd_amount numeric)` | `{quote_id, usd_amount, kes_due, kes_per_usd, rate_date, expires_at, environment}` |
| `funding_my_payments()` | Own payments with a customer-safe `status_message` |

The three Edge Functions share their request handling in `supabase/functions/_shared/funding-handlers.mjs`; each `index.ts` only wires `Deno.env`, `npm:@supabase/supabase-js@2.117.1` and `EdgeRuntime.waitUntil`. Bodies are read with a hard byte limit whether or not `Content-Length` is sent (chunked uploads included).

**Edge Function `funding-deposit`** (JWT verified; POST and OPTIONS only; body ≤ 4 KiB): `POST {quote_id, phone, idempotency_key}` returns `{payment_id, environment, state, status_message, usd_amount, kes_due}`. A missing bearer token is refused before any work, and the user id comes only from `auth.getUser()`. Errors use stable codes with customer-safe text and a request id, never exception text: `unauthorized` 401, `method_not_allowed` 405, `payload_too_large` 413, `validation_failed` 400, `quote_expired`, `payment_in_progress`, `deposit_limit_reached` 409, `sandbox_not_enabled` 403, `treasury_paused`/`treasury_unknown`/`payments_unavailable` 503, `internal` 500. Every response carries the CORS allowlist headers.

**Edge Function `daraja-callback`** (public; POST only, else 405; body ≤ 16 KiB): returns `200 {"ResultCode":0,"ResultDesc":"Accepted"}` for anything handled or ignored, including an oversized body. It returns `500 {"ResultCode":1,"ResultDesc":"Retry"}` only when the database could not record a callback (or the service configuration is missing), so Daraja retries. Neither the token nor the body is logged.

**Edge Function `funding-reconcile`** (`X-Funding-Cron-Secret`, compared in constant time against a configured secret of at least 32 characters; POST only; body ≤ 1 KiB): `{"action":"sweep"}` (default) queries stale open payments with a bound checkout and expires `UNKNOWN`; `{"action":"daily","business_date":"YYYY-MM-DD"}` runs the reconciliation. An unknown action or malformed date is refused with 400.

**Service RPCs** (`service_role` only): `funding_svc_begin_payment(user, quote, phone, idempotency_key, callback_token_hash, shortcode)`, `funding_svc_record_initiation`, `funding_svc_record_callback`, `funding_svc_record_status`, `funding_svc_open_payments`, `funding_svc_expire_stale`, `funding_svc_reconcile`.

**Staff RPCs:**

| Capability | Role | RPCs |
| --- | --- | --- |
| `funding.manage` | owner, aal2, fresh TOTP | `funding_publish_rate`, `funding_record_treasury_snapshot`, `funding_set_sandbox_module`, `funding_set_sandbox_tester`, `funding_record_statement_item`, `funding_record_statement_total`, `funding_resolve_reconciliation`, `funding_request_action` and `funding_approve_action` (see below) |
| `funding.read` | owner, administrator | `funding_staff_overview` (read-only) |

Every financial decision (`REVERSE`, `RESOLVE_CONFIRMED`, `RESOLVE_FAILED`) is a `funding.staff_actions` row. One owner requests it and a **different** owner approves it. A check constraint enforces this, and so does `second_approver_required`.

**Provider evidence for a manual confirmation.** `funding_record_statement_item(environment, receipt, kes_amount, shortcode, transaction_at, account_reference, msisdn, evidence_kind, evidence_reference, evidence_sha256, note)` records one line of the M-Pesa or bank statement as an immutable `funding.provider_statement_items` row. The receipt is unique per environment; at least one of account reference or phone is required, and the phone is stored only as a hash and a masked form. Production accepts only `PROVIDER_DOWNLOAD` evidence. `RESOLVE_CONFIRMED` must cite one item (`funding_request_action(payment, kind, reason, statement_item)`), and `funding.statement_binding_refusal` must find no mismatch, both at request and at approval:

- same environment, exact KES (`kes_amount = kes_due`), and same shortcode;
- the account reference and/or phone on the line match the payment;
- the transaction time is between 10 minutes before and 24 hours after the payment was created (the business date follows from it);
- the callback receipt, if one was bound, equals the line's receipt;
- the item and its receipt are not already used by another payment.

The requester, the approver, and whoever recorded the statement item must be three different people (`independent_reviewer_required`). On approval the item and receipt are tied to the payment, the KES receipt is booked on the statement's business date, and the credit goes through the same limit and coverage re-check as an automatic credit.

## 10. Failure and recovery matrix

| Failure | Behavior |
| --- | --- |
| Daraja OAuth or STK Push times out | The payment goes to `UNKNOWN`. The customer sees "checking with M-Pesa". No new push is sent while it is unresolved. Any later callback sends it to `MANUAL_REVIEW`, and only statement evidence plus two owners can credit it |
| Callback lost | `funding-reconcile` queries `PENDING` payments with a bound checkout after 60 s. The query decides |
| Callback duplicated or replayed | Unique `dedupe_key`. The state machine and ledger key block a double credit |
| Callback forged without a token | Ignored |
| Callback with a leaked token and another customer's successful checkout id | Payment with a bound checkout: `CONFLICT`, `MANUAL_REVIEW`, the claimed id is never queried. Payment without one: `UNBOUND`, `MANUAL_REVIEW`, never queried. Neither credits. A leaked token can at most push a payment into review, which the statement check then resolves |
| Callback with a leaked token and the payment's own bound checkout | The server queries the bound checkout, which our own push created for this payment's amount, phone and account reference; the callback's claims must also agree. This is the normal success path, and a token holder cannot redirect it |
| Amount altered in the callback | `MANUAL_REVIEW` with no credit |
| Query errors (provider outage) | The payment stays open. After 24 h it goes to `MANUAL_REVIEW` |
| Database outage during a callback | The Edge Function returns 500 so Daraja may retry. The next reconcile run queries anyway |
| Rate stale | New quotes are refused. Issued quotes and open payments are unaffected |
| Projected treasury coverage below 110%, or snapshot stale or missing | New payments are refused. A paid payment is held in funded suspense (KES booked, no USD) |
| Rate rises between quote and credit | The credit-time projection uses the higher rate. If coverage fails, funded suspense |
| Concurrent deposits | Admission is serialized on an environment lock and counts every open deposit |
| Customer limit reached after payment (policy tightened) | Funded suspense with `funded_suspense_deposit_limit_reached` |
| Customer paid but the credit failed | The ledger post is in the same transaction as the state change, so both happen or neither does. The next reconcile run retries through the query |

## 11. Threat model (STRIDE summary)

| Threat | Control |
| --- | --- |
| Spoofed callback without a token | Ignored. Nothing is written |
| Spoofed callback with a leaked token (the token travels in a URL query string and is assumed observable in logs) | The token only correlates. Only the checkout id from our own synchronous STK Push response is ever queried. A callback cannot set or replace it, and an unbound callback goes to `MANUAL_REVIEW` without a query. A successful STK Query proves only the queried checkout's status, so it is used only for that bound checkout |
| Tampered amount, account or phone | Binding to the locked quote. The browser never supplies money fields. The pushed amount, phone and account reference come from the database |
| Staff crediting without money received | `RESOLVE_CONFIRMED` needs an immutable statement line that binds exact KES, shortcode, reference/phone, time window and receipt, and three distinct people (recorder, requester, approver). Two-person approval alone is not treated as proof of payment |
| Unbacked liability | Projected coverage at admission and again at credit, under a lock. Failures hold paid money in suspense instead of creating a balance |
| Repudiation by staff | `admin_audit_events` on every staff RPC, including statement items and totals with their evidence digests. Reversals need two people |
| Information disclosure | No secrets in browser, repository, logs or fixtures. Masked phone numbers only. Payload hashes, not payloads |
| Denial of service on the callback | Unknown tokens cost one hash lookup. Rate limits come from the Supabase platform |
| Elevation (a customer crediting themselves) | All writes go through `service_role` or staff-gated definer functions. The funding schema has no grants to `anon` or `authenticated` |
| Sandbox funds mistaken for real | A separate ledger, `environment` on every row, a non-spendable account, and labels on every view |

## 12. Open items (not design questions for Claude)

- The Owner must confirm the pinned Daraja doc revision (§1). The KES 250,000 cap is pinned to Safaricom's press release (§1).
- A refund path for funded-suspense money that must be returned (Phase 3).
- Legal and regulatory review of the product and jurisdiction (a release evidence item).
- The retention period (§5).
- The production counterpart account and the deposit posting migration (Phase 3).
- The treasury pause hook in `engine_buy_contract` (Phase 3).
- F1 gate replacement (Phase 3).
- Customer funding UI and disclosure copy, to follow once the sandbox flow is accepted.
- The CBK rate is published manually by the owner each business day. Automated CBK fetching is out of scope for v1.
