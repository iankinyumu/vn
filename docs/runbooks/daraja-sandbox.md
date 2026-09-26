# Runbook: Daraja sandbox deposits (Phase 2)

**Design:** `docs/REAL_FUNDING_DESIGN.md`. **Plan:** `docs/CLAUDE_REAL_MODE_DARAJA_SANDBOX_AUDIT_PLAN.md`.

This runbook covers **sandbox only**. Nothing in it enables production payments, Real accounts or Real trading. A sandbox credit lands in a separate, non-spendable USD test ledger (`funding.usd_ledger_entries`), never in a trading wallet.

## 1. Authorized executor setup

Never paste a secret value into chat, a commit, a ticket or a screenshot.

The Owner confirms the Daraja sandbox app credentials are stored locally in the ignored file `.env.redis.local` as `DARAJA_CONSUMER_KEY` and `DARAJA_CONSUMER_SECRET` and authorizes Claude to complete the sandbox setup without another approval. Treat that file as a local sandbox input only. Read only those two values and map them to the hosted sandbox names below. Do not print values, source unrelated variables, upload the file, commit it, or copy the whole file into Supabase. Hosted Edge Functions do not receive local environment files. Write each required value individually to the Supabase secret store and verify presence by variable name only. Use shortcode `174379` and the corresponding passkey only from Safaricom's official sandbox sample; never reuse either value for production.

1. **Apply the migrations** `20260926100000_funding_foundation.sql` and `20260926110000_funding_rpc.sql` through the normal reviewed deployment. They add the `daraja_sandbox` and `daraja_production` modules, both off.
2. **Set the Edge Function secrets** in the dashboard or with `supabase secrets set`. Claude is authorized to transfer the named sandbox values directly without displaying them.

   | Name | Value |
   | --- | --- |
   | `DARAJA_ENV` | `sandbox` |
   | `DARAJA_SANDBOX_CONSUMER_KEY`, `DARAJA_SANDBOX_CONSUMER_SECRET` | From the Daraja sandbox app |
   | `DARAJA_SANDBOX_SHORTCODE`, `DARAJA_SANDBOX_PASSKEY` | The M-Pesa Express sandbox test credentials |
   | `DARAJA_SANDBOX_TRANSACTION_TYPE` | Optional. `CustomerPayBillOnline` (default) or `CustomerBuyGoodsOnline` |
   | `DARAJA_SANDBOX_PARTY_B` | Optional. Defaults to the shortcode |
   | `DARAJA_CALLBACK_BASE_URL` | `https://cdaxvkpmgqjfukbtrzys.supabase.co/functions/v1` |
   | `FUNDING_CRON_SECRET` | At least 32 random characters |

   Do **not** set any `DARAJA_PRODUCTION_*` value. The sandbox loader refuses to start if one is present.
3. **Check, then deploy the functions.** Before deploying, type-check the entry points in a clean Deno 2 environment, and do not deploy an unchecked wrapper:
   ```
   deno check --no-config supabase/functions/funding-deposit/index.ts supabase/functions/daraja-callback/index.ts supabase/functions/funding-reconcile/index.ts
   ```
   Then deploy:
   ```
   npx supabase functions deploy funding-deposit daraja-callback funding-reconcile --project-ref cdaxvkpmgqjfukbtrzys
   ```
   `config.toml` sets `verify_jwt = false` for `daraja-callback` and `funding-reconcile` only.
4. **Open the sandbox for yourself.** In an owner session with fresh TOTP, run these in the SQL editor as the owner, or through the console once it has a funding panel:
   - `select public.funding_set_sandbox_module(true, '<reason>')`
   - `select public.funding_set_sandbox_tester('<your user id>', true, '<reason>')`
   - `select public.funding_record_treasury_snapshot('SANDBOX', <test float KES>, 'Sandbox test float, not real cash')`. A reserve of 0 admits no deposit: admission projects coverage *after* the new deposit. Record a fresh snapshot at least every 24 hours, or deposits pause (`treasury_unknown`) and paid credits are held in funded suspense.
5. **Rate:** the migration seeds CBK 129.62 dated 2026-09-25. A rate goes stale 72 hours after the end of its date. On each business day, publish the CBK mean with `select public.funding_publish_rate(<rate>, '<date>', '<CBK page>', '<reason>')`.
6. **Schedule the sweep:** every minute, `POST .../funding-reconcile` with `{"action":"sweep"}`, and daily at 00:30 EAT, `{"action":"daily"}`. Both send the header `X-Funding-Cron-Secret`. Use an external scheduler, or pg_cron with the secret stored in Vault. Never put the secret in a migration.

## 2. Owner drill (evidence for `DARAJA_SANDBOX_READY`)

Use only the Daraja sandbox test MSISDN. For each case, record the time, the payment id and the resulting state, and check that nothing credits except where stated.

| # | Case | How | Expected |
| --- | --- | --- | --- |
| 1 | Valid deposit | `funding_create_deposit_quote(5)`, then `POST funding-deposit {quote_id, phone, idempotency_key}`, then approve on the simulator | `CONFIRMED`. Test balance +5.00. RECEIPT KES 649 and ROUNDING 0.90 at 129.62 |
| 2 | Cancelled on phone | Decline the prompt | `FAILED`, no credit |
| 3 | Callback replay | The per-payment token is never stored or logged, so an operator cannot replay a callback. Replays are covered by `tests/funding-sandbox.test.mjs`, and any Daraja retry shows up as `duplicate_count` on the provider event | No second credit |
| 4 | Forged callback | POST a success body with no or a wrong `t` | 200 `Accepted`, no provider event, no state change |
| 5 | Timeout / no answer | Let the prompt time out | The sweep queries and the payment ends `FAILED` (1037 or 1019) |
| 6 | Repeat request | Re-send case 1's `funding-deposit` request with the same idempotency key | Same payment returned, no second push |
| 7 | Daily reconciliation | Record the day's statement first: `funding_record_statement_total('SANDBOX', '<day>', <opening>, <gross>, <reversals>, <fees>, <net settlement>, <closing>, 'SANDBOX_SIMULATED', '<where the figures came from>', '<sha256 of the evidence file>', '<reason>')`. Use `PROVIDER_DOWNLOAD` only for a statement actually downloaded from the M-Pesa org portal. Then `{"action":"daily","business_date":"<day>"}` | `MATCHED`, or differences an independent owner explains. Without a statement the run shows `statement_missing`. The summary shows `statement.simulated` |
| 8 | Reversal | Owner A: `funding_request_action(<id>,'REVERSE',…)`. Owner B: `funding_approve_action` | `REVERSED`, balance back. The same owner approving is refused |
| 9 | Limits | Quote USD 500.01; complete deposits to reach three, or USD 1,000, in 24 h; then quote again | `amount_above_maximum`, then `deposit_limit_reached` |
| 10 | Callback with a wrong checkout id | Only with a sandbox payment of your own: POST a success callback carrying that payment's token but another sandbox checkout id. This needs the token, which is never logged, so run it only through the test harness or a deliberately instrumented drill build | `MANUAL_REVIEW` (`callback_checkout_conflict` or `callback_without_initiation_checkout`), no STK Query of the claimed id, no credit |

**Evidence per case:** environment `SANDBOX`, project ref, source commit, UTC interval, performer, reviewer (the Owner, a different person from the performer), and digests of the redacted artifacts. Redact the MSISDN to `2547*****XXX`, and never record tokens or secrets.

## 3. Operations

- **Needs attention:** `funding_staff_overview('SANDBOX')` lists `MANUAL_REVIEW`, `EXPIRED` and attention reasons.
- **Resolving a payment as received** needs three different owners:
  1. **Recorder:** downloads the statement, computes its SHA-256 and records the matching line with `funding_record_statement_item('SANDBOX', '<receipt>', <exact KES>, '<shortcode>', '<transaction time>', '<account reference or null>', '<2547… MSISDN or null>', 'SANDBOX_SIMULATED' | 'PROVIDER_DOWNLOAD', '<evidence reference>', '<sha256>', '<note>')`.
  2. **Requester:** `funding_request_action(<payment>, 'RESOLVE_CONFIRMED', '<reason>', <statement item id>)`.
  3. **Approver:** `funding_approve_action(<action>, '<reason>')`.

  A line that does not bind is refused with `statement_evidence_invalid: <field>`. Two-person approval without a statement line is not accepted as proof of payment.
- **Resolving a payment as failed** (`RESOLVE_FAILED`) is refused once the provider has confirmed the money (`payment_funds_received`).
- **Funded suspense** (`funded_suspense_treasury_paused`, `_treasury_unknown` or `_deposit_limit_reached`): the customer paid, the KES is booked, and no USD was credited. Restore coverage (a fresh snapshot) and resolve with `RESOLVE_CONFIRMED` as above; the approval re-checks coverage and limits. There is no refund path yet: escalate to the Owner.
- **Unbound callbacks** (`callback_without_initiation_checkout`): never trust the callback's checkout id or receipt. Resolve only from the statement.
- **Unverified receipts** (`receipt_pending`, reconciliation `receipt_unverified`): every automatic credit starts here, because a callback receipt is only a claim and STK Query returns no receipt. Bind the real receipt from the statement with the same three people: recorder `funding_record_statement_item`, requester `funding_request_action(<payment>, 'BIND_RECEIPT', '<reason>', <statement item id>)`, approver `funding_approve_action`. Binding moves no money. Never copy a receipt from a callback or the customer into a statement line.
- **Sandbox test numbers:** sandbox prompts go only to MSISDNs in `funding.sandbox_msisdns` (seeded with the Daraja sandbox test number), or to the paying tester's own numbers. Adding a global number is a reviewed migration, and a real customer number must never be added. The official test number never answers a prompt: every push ends `1037`, as the live drill on 2026-09-26 showed. To reach success and cancellation, an enabled tester adds a Safaricom number they hold under "Your test phone" on the tester page (`funding_set_my_sandbox_msisdn`). That number is stored in `funding.sandbox_tester_msisdns`, bound to that tester only and invisible to others. A tester may have at most two enabled numbers. A number is switched off, never deleted, and its audit keeps only the masked form. The number is never written into a migration or the repository.
- **Tester page (Real mode only):** Daraja sandbox testing lives in Real mode, and Practice mode stays strictly virtual. For an enabled tester, while `daraja_sandbox` is on, the header account switcher offers **Real — Sandbox (test funds)**, which opens `sandbox-deposit.html` ("Real mode · Daraja Sandbox - test funds only"). That page selects no trading account, and its footer states that no real money moves. Choosing Practice returns to the dashboard. There is no sandbox entry anywhere in Practice, and Profile no longer links to it. Everyone else sees only Practice, and the page itself shows "not available".
- **Emergency stop:** `funding_set_sandbox_module(false, '<reason>')`. Open payments still finalize through the sweep.
- **Rollback:** turn the module off and remove the Daraja secrets. The funding tables are append-only and are kept.
