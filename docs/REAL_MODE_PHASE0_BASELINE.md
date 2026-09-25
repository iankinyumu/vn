# Real mode and Daraja sandbox: Phase 0 baseline

**Brief:** `docs/CLAUDE_REAL_MODE_DARAJA_SANDBOX_AUDIT_PLAN.md` (Phase 0).
**Performer:** Claude (executor). **Reviewer:** not yet assigned. This report is unreviewed.
**Observed:** 2026-09-25.

This baseline does not approve Real accounts, funding or Real trading. No Daraja request was sent. No secret values were read or recorded.

## 1. Environments observed

| Item | Value | How observed |
| --- | --- | --- |
| Source commit | `9ea140c9a27df2c41023f0eea133b5be654475f2` on `feat/restore-customer-ui` | `git rev-parse HEAD` |
| Worktree | Clean except the untracked, owner-owned audit brief `docs/CLAUDE_REAL_MODE_DARAJA_SANDBOX_AUDIT_PLAN.md` (left untouched and uncommitted) | `git status` |
| Hosting | Vercel project `smartprofitbinaryv2`. The static build is `npm run build` → `dist` | `.vercel/project.json`, `vercel.json` |
| Deployed URL / deployment commit | **Unknown.** No production URL is recorded in the repo, and the Vercel deployment list was not queried | — |
| Supabase project | The linked project ref is `cdaxvkpmgqjfukbtrzys`, running Postgres `17.6.1.166` | `supabase/.temp` |
| Deployed Edge Functions | `refresh-market-quote` (v6) and `cron-process-demo-orders` (v4), both `ACTIVE`, both with `verify_jwt=false` | `supabase functions list` (read-only) |
| Deployed function secrets (names only) | `CRON_SECRET`, `SUPABASE_*` (platform-provided), `UPSTASH_REDIS_REST_TOKEN`, `UPSTASH_REDIS_REST_URL`. **No Daraja/M-Pesa secret exists** | `supabase secrets list` (the CLI returns only digests) |
| Deployed DB state (`real_accounts` flag, REAL account count, published checklist, applied migration head) | **Unknown.** A read-only query against the linked DB was not run in this session. The owner needs to run it or authorize it (see §6) | — |
| Local config | `.env.example` lists only Supabase, Resend and auth-email names. The local env files contain no Daraja variable name. Values were not read | Variable names only |

Repository-only findings are in §2–§4. §1 contains the only deployed-environment observations.

## 2. Corrections to the brief's repository assessment

- **Order path.** The customer trade page no longer calls `submit_demo_order`. `assets/js/trade.js:339` calls `engine_buy_contract`, preceded by `engine_quote_contract`. `submit_demo_order` survives only in the archived crypto-spot module (`modules/crypto-spot/**`, `supabase/functions/_disabled/crypto-spot/**`).
- **Deployed functions differ from source.** The two deployed functions exist in source only under `supabase/functions/_disabled/crypto-spot/`. They are still `ACTIVE` in the linked project (see finding F2).
- **Ledger currency.** The ledger asset is fixed to `USD` through `engine_ledger_asset()`, while M-Pesa settles in KES. Phase 1 must settle how KES and USD relate: whether to convert, which rate source to use, who carries the FX risk, and whether Real uses a KES ledger. The Daraja integration cannot be designed without this.

The other statements in the brief match the source. Practice-only labels appear on the index, trade, dashboard, register and about pages. `docs/ACCOUNT_TYPES.md:13` says no Real, funding, KYC or Daraja path exists. The switcher shows "Real — Not available yet" (`assets/js/account-switcher.js:84-85`). `docs/REAL_READINESS_CHECKLIST.md` is a draft. No Daraja or M-Pesa code exists anywhere in active source.

## 3. Existing Real-mode safeguards (source)

1. **No path creates a REAL account.** Every `insert into public.trading_accounts` inserts `'DEMO'`: the signup trigger, the backfill, and `enroll_practice_account` (`20260920220000_engine_practice_enrollment.sql:26`). Clients cannot insert, because RLS allows select-own only and grants are select-only (`20260912150000_trading_foundation.sql:229-266`).
2. **Account mode is immutable.** The trigger `trading_accounts_execution_mode_immutable` enforces this (`20260920200000_engine_foundation_hardening.sql:16`). Contracts carry a composite FK `(trading_account_id, execution_mode)`, so a contract cannot cross modes.
3. **Server-side gate on quote and buy.** The quote and buy paths raise `real_disabled` for REAL accounts while the `real_accounts` module is off (`20260920240000_engine_quote_and_buy.sql:6`, `20260920440000_engine_customer_rpc_hardening.sql:6`). The switcher UI is cosmetic only.
4. **Gate enablement.** `enable_real_accounts` is owner-only. It requires the latest immutable published checklist version and one evidence reference for each of six keys, and it audits the change (`20260920500000_engine_permissions_hardening.sql:50-68`). The checklist table is immutable and closed to client roles.
5. **Funding credentials are separated from the engine by design.** The rule appears in `indices build.md:81`: "No engine cron job or engine function may hold or read funding credentials."

## 4. Findings and bypass risks (ranked)

| # | Severity | Finding | Reference | Impact |
| --- | --- | --- | --- | --- |
| F1 | High (before any Real release) | `enable_real_accounts` checks only the **format** of each evidence value. Any `https://…`, `PR-n` or `run:x` passes. It does not check reviewer identity, independence from the performer, or immutability of the evidence. The owner alone can open the gate | `20260920500000_engine_permissions_hardening.sql:58-61` | The brief's rule that "an independent reviewer must be a different named person" is not enforced by the server. This gate must be strengthened before Phase 4 |
| F2 | Medium | Two legacy crypto-spot Edge Functions are still `ACTIVE` with `verify_jwt=false`, but source keeps them only as disabled or archived | deployed project; `supabase/functions/_disabled/crypto-spot/` | They are unauthenticated public endpoints outside current source control, so they sit outside review. Whether they still reach live tables needs checking. Undeploying is an owner decision and was not done |
| F3 | Medium (design) | No funding data model exists: no payments, callbacks, suspense ledger, reconciliation or KES handling. The ledger is USD-only | `engine_ledger_asset()` | Blocks Phase 2. It needs Phase 1 contract design, including the currency decision |
| F4 | Low | Once enabled, the gate is one platform-wide boolean. The source has no per-user Real eligibility, KYC or step-up check yet | `platform_modules.real_accounts` | If the flag were flipped, eligibility would still depend on a REAL-account creation path, which does not exist yet. Phase 3 must add eligibility before any creation path |

No bypass was found through which a client could create, fund or trade a REAL account in the current source.

## 5. Daraja sandbox inventory

| Item | Status |
| --- | --- |
| Daraja app / consumer key and secret | **Absent** from the deployed secret store and local config |
| Product enabled (STK Push / C2B / B2C / Transaction Status / Reversal) | **Unknown.** The owner must state which |
| Sandbox shortcode, passkey, test MSISDN | **Unknown / absent** |
| Callback URL | **None.** No handler is deployed |

## 6. Unknowns and blockers

- **Blocker (Phase 0 gate):** the owner's Daraja sandbox setup has not been identified: products, shortcode type (paybill or till), and the intended callback host. Under the brief, implementation cannot start until it is.
- **Blocker (Phase 1):** the KES/USD ledger decision, and whether Real is a self-generated digit contract. If it is, the legal, settlement and risk owner must be named.
- **Deployed DB state is unknown:** the `real_accounts` flag, REAL account count, published checklist rows, and migration head. The owner can run this read-only query in the SQL editor:
  `select module_key, enabled, changed_at from public.platform_modules where module_key='real_accounts'; select execution_mode, count(*) from public.trading_accounts group by 1; select version, published_at from public.real_readiness_checklists; select max(version) from supabase_migrations.schema_migrations;`
- **Deployed site URL and deployment commit are unknown.** The page-by-page UI review in this report covers source only. A deployed-site review needs the URL.
- **No reviewer is assigned.**

## 7. Status

| Status | Value | Basis |
| --- | --- | --- |
| `CODE_READY` | Not assessed in this phase | Test suite not run for Real work |
| `PRACTICE_READY` | Not ready | Engine v3 acceptance rows pending (`docs/ENGINE_V3_ACCEPTANCE.md`) |
| `DARAJA_SANDBOX_READY` | Not ready | No sandbox integration exists (§5) |
| `REAL_READY` | Not ready | Checklist draft only; F1 open |
