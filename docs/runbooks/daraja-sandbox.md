# Runbook: Daraja sandbox deposits (Phase 2)

**Design:** `docs/REAL_FUNDING_DESIGN.md`. **Plan:** `docs/CLAUDE_REAL_MODE_DARAJA_SANDBOX_AUDIT_PLAN.md`.

This runbook covers **sandbox only**. Nothing in it enables production payments, Real accounts or Real trading. A sandbox credit lands in a separate, non-spendable USD test ledger (`funding.usd_ledger_entries`), never in a trading wallet.

## 1. Owner setup

Never paste a secret value into chat, a commit, a ticket or a screenshot.

1. **Apply the migrations** `20260926100000_funding_foundation.sql` and `20260926110000_funding_rpc.sql` through the normal reviewed deployment. They add the `daraja_sandbox` and `daraja_production` modules, both off.
2. **Set the Edge Function secrets** in the dashboard or with `supabase secrets set`. Type the values yourself.

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
3. **Deploy the functions:**
   ```
   npx supabase functions deploy funding-deposit daraja-callback funding-reconcile --project-ref cdaxvkpmgqjfukbtrzys
   ```
   `config.toml` sets `verify_jwt = false` for `daraja-callback` and `funding-reconcile` only.
4. **Open the sandbox for yourself.** In an owner session with fresh TOTP, run these in the SQL editor as the owner, or through the console once it has a funding panel:
   - `select public.funding_set_sandbox_module(true, '<reason>')`
   - `select public.funding_set_sandbox_tester('<your user id>', true, '<reason>')`
   - `select public.funding_record_treasury_snapshot('SANDBOX', <test float KES>, 'Sandbox test float, not real cash')`
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
| 7 | Daily reconciliation | `{"action":"daily","business_date":"<today>"}` | `MATCHED`, or differences that are explained |
| 8 | Reversal | Owner A: `funding_request_action(<id>,'REVERSE',…)`. Owner B: `funding_approve_action` | `REVERSED`, balance back. The same owner approving is refused |

**Evidence per case:** environment `SANDBOX`, project ref, source commit, UTC interval, performer, reviewer (the Owner, a different person from the performer), and digests of the redacted artifacts. Redact the MSISDN to `2547*****XXX`, and never record tokens or secrets.

## 3. Operations

- **Needs attention:** `funding_staff_overview('SANDBOX')` lists `MANUAL_REVIEW`, `EXPIRED` and attention reasons. Resolve with the two-person `RESOLVE_CONFIRMED` or `RESOLVE_FAILED`, and only after checking the M-Pesa statement.
- **Emergency stop:** `funding_set_sandbox_module(false, '<reason>')`. Open payments still finalize through the sweep.
- **Rollback:** turn the module off and remove the Daraja secrets. The funding tables are append-only and are kept.
