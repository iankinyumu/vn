# Astra build brief: SmartProfit Digit Indices (demo mode) and crypto module shutdown

Repository: `iankinyumu/vn` (branch `main`). Work on a new branch `feat/digit-indices`. Commit at the end of every phase.

You are replacing the crypto spot product with a self-hosted synthetic-index product whose contracts settle on the last digit of a tick (Even/Odd first). The crypto build is **disabled, not deleted**. Everything below is a requirement unless it says "default", in which case use the stated value and make it configurable.

**Read "Account-type architecture" and "Restrictions" before anything else.** The platform follows the industry-standard model: one login, one engine, typed accounts (Practice now, Real later) chosen with an account switcher. Practice runs the same engine code path as Real with virtual money, so it is the reference model for Real. Only Practice is built now.

---

## 0. Working rules (non-negotiable)

1. **Production-grade, compile-ready code only.** No stubs, placeholders, `TODO`s, mock or simulated logic, "example" values standing in for real behaviour, or commented-out code paths. If something cannot be finished properly, stop and report it instead of faking it.
2. **Never edit or move an applied migration** in `supabase/migrations/`. All database change is a new, timestamped migration (use dates after `20260919130000`). Migrations must be idempotent where the existing style is (`if not exists`, `create or replace`). **Every Phase 2 (engine) migration filename must contain `_engine_`** (e.g. `20260920140000_engine_foundation.sql`), including the 2.0 foundation-hardening migration. This is not cosmetic — the parity checker below relies on it to tell new engine code from everything that came before.
3. **No remote side effects.** Do not connect to Supabase or any remote service. Do **not** read or use any credential from `.env.local`. Write migrations, functions and tests locally and give me the exact commands to apply/deploy.
4. **The indices are fully proprietary: no external source for anything that produces a tick.** No Binance, FCSAPI, drand, block-hash beacons, or any third-party API for index prices, ticks, digits or entropy. Entropy comes from the database's CSPRNG (`gen_random_bytes`). This rule is about the indices only; it does not restrict what real mode may use later (payments, currency rates, etc.). Existing CDN assets for Bootstrap/Font Awesome/fonts may stay.
5. **Build the Practice (`DEMO`) account type only, but write everything account-type-aware.** No REAL account creation path, no funding, withdrawals, Daraja/M-Pesa or KYC. `REAL` stays unreachable behind the database flag `real_accounts` (off). Follow "Account-type architecture" so Real is added by enabling and extending, never by rewriting.
6. **Server-authoritative.** The browser never supplies an account id, a price, a payout, an entry tick or a result. Existing patterns (`auth.uid()`, `security definer`, RLS, revoked grants, immutable ledger, audit events) are the standard; match or exceed them.
7. Keep the existing conventions: vanilla JS with script tags (no framework, no bundler), `node:test` + `jsdom` + the helpers in `tests/helpers/test-db.mjs`, stable error codes returned to the UI, `aria-live` status regions, no `alert()`.
8. Run `npm test` at the end of every phase. It must be green. Do not delete a test to make it pass; move it (see Phase 1) or rewrite it to assert the new behaviour.
9. Never print secret values in output or logs. Never force-push or rewrite git history.

## 1. Facts about the repo (verified; do not re-discover)

- Static multi-page site in `pages/`, JS in `assets/js/`, Supabase backend (Auth, Postgres, Edge Functions, pg_cron, Realtime).
- Existing reusable foundation: `profiles`, `trading_accounts` (DEMO/REAL, one DEMO account per user), `wallets`, `ledger_accounts` (kinds `AVAILABLE`, `RESERVED`, `FEE`, `REALIZED_PNL`), immutable double-entry `ledger_transactions`/`ledger_entries` with a deferred balance-check trigger, `staff_roles` + `admin_private.role_capabilities()` + `admin_private.require_staff()`, `admin_audit_events`, `account_restrictions`, support tickets, `set_updated_at()`, `reject_mutation()`.
- Crypto-only pieces: `orders`/`fills`/`positions`/`market_snapshots`/`execution_events` usage, `submit_demo_order`, `cancel_demo_order`, `fill_demo_order`, `process_demo_orders`, `market_symbols`, `market_symbol_controls`, `list_executable_symbols`, `list_admin_market_health`, `set_symbol_trading_status`, `list_admin_demo_orders`, `get_admin_demo_order_detail`; Edge Functions `refresh-market-quote` and `cron-process-demo-orders` plus `_shared/market-data.mjs` and `_shared/quote-cache.mjs`; pg_cron job `process-demo-orders-every-minute`; browser files `market-registry.js`, `market-ticker.js`, `market-overview.js`, `order-form.js`, `order-errors.js`, `trade.js`, and pages `trade.html`, `dashboard.html`, `index.html`, `profile.html` which load them; the Admin "Trading" and "Markets" tabs in `pages/admin.html` / `assets/js/admin-operations.js`; staff capabilities `trading.read_demo` and `markets.manage`; `platform overview` fields `market_health` and `orders_today`.
- Test files that assert crypto behaviour: `market-registry`, `trade-market-wiring`, `edge-functions`, `caching`, and crypto parts of `admin-operational`, `admin-permissions`, `admin-ui`, `customer-page-resilience`. Inspect each before deciding what moves and what is rewritten.
- `assets/js/charts.js` is empty. `README.md` is a stale template from another author.

## 2. Decisions already made (do not re-litigate)

| Item | Value |
|---|---|
| Product | Digit contracts on self-generated indices; each index instanced once per account type with its own tick stream (see "Account-type architecture") |
| Contract types (all implemented) | `EVEN`, `ODD`, `OVER(b)`, `UNDER(b)`, `MATCH(d)`, `DIFFER(d)`. Launch-enabled: `EVEN`, `ODD` only. Others exist, are tested, and are toggled in policy (`enabled=false` by default) |
| Ledger asset | `USD`, 2 decimal places. Every balance, stake, payout and ledger entry is USD. Exposed through one SQL function `engine_ledger_asset()` and one config RPC. Practice has no deposits, no M-Pesa and no currency conversion |
| Practice credits | 10,000.00 USD of virtual credits, plus a `reset_practice_balance(p_account_id)` RPC (see 2.14) |
| Indices (own brand, not third-party names) | `SPI10`, `SPI25`, `SPI50`, `SPI75`, `SPI100`; 2000 ms ticks; 3 decimals; base prices and per-tick sigma in section 2.3 |
| House margin (return-to-player = 1 − margin) | 3.5 % default, per-contract-type override allowed, bounds 0.5 %–15 % |
| Settlement | Digit of the exit tick; win pays `payout` (stake included), loss pays 0 |
| Tick count | 1–10 ticks per contract (default bounds in policy) |
| Modules (flags in `public.platform_modules`) | `crypto_spot` = disabled, `digit_indices` = enabled, `real_accounts` = disabled |
| Account types | `DEMO` (Practice) built now; `REAL` designed for, not built. Reuse the existing `trading_accounts` / `wallets` / `ledger_*` foundation, hardened per 2.0 |
| Account switcher | Stays. One set of pages; the active account is chosen explicitly and shown unmistakably (Frontend rules) |
| Tick streams | Independent per account type. `SPI10` (Practice) and `SPI10` (Real, later) share code, config and branding but never a seed, epoch or digit |
| Restrictions | Typed, scoped and graded by severity; privilege to apply/lift depends on gravity (section "Restrictions") |
| Real activation | Gated by `enable_real_accounts()` (section "Real go-live gate"), not a bare flag flip |

---

## Account-type architecture: one engine, typed accounts

**Principle (industry standard).** One login, one platform, one engine. A customer holds typed accounts (Practice = `DEMO`; Real = `REAL`, later) and acts on exactly one of them at a time, chosen with an account switcher. Practice executes the same engine code as Real with virtual money. What separates the two is the **account**: its money, ledger, limits, exposure, funding, restrictions and presentation.

| Same for every account type | Separated by account type |
|---|---|
| Login and identity | Account, wallet and ledger scope |
| Engine code path (quote, buy, settle, void) | Contracts (each carries its account's mode, enforced by the database) |
| Index tick streams, epochs, seeds, fairness proofs | Exposure and liability buckets, never offsetting each other |
| Contract types, payout margin, tick bounds (so Practice mirrors real economics) | Limits (stake, open contracts, rate, liability) per mode |
| Pages and components | Funding (Real only, later), practice credits and reset (Practice only) |
| Admin console (with account-type filters) | Restriction scope, audit tags, reporting, caches, subscriptions, theme and labels |

**Parity rule.** Engine code may branch on `execution_mode` (as opposed to merely carrying it as a key column, which every engine table now does per "Account-type architecture") only for: (a) limits lookup, (b) exposure bucket, (c) funding/credit operations (practice credits and reset now; real funding later), (d) the `real_accounts` gate. Any other branch is a defect.

**This is enforced automatically, not by review, and it is scoped to new engine code only.** Add `scripts/check-parity.mjs`: it reads every `supabase/migrations/*_engine_*.sql` file — never Phase 0, Phase 1, or any migration that predates this brief; those are out of scope for this rule and must never be edited or added to any allowlist — extracts each `create or replace function <name>(...) ... language plpgsql ... as $$ ... $$` body (a single regex-based extractor is sufficient given the repo's consistent migration style; if a function body cannot be reliably extracted, the script must fail loudly rather than silently skip it), and for any function whose fully-qualified name is **not** in the allowlist below, searches the body for the literal token `execution_mode` used in a conditional (`if`, `case`, `where`, `and`, `or` immediately adjacent to the token — a simple token-adjacency check, not a full SQL parser) and fails with the file, function name and matching line if found. Wire it into `npm test` as a required step (`npm run check:parity`) so a future contributor cannot merge a fifth branch without either adding it to the allowlist in the same commit (visible in code review) or the build going red.

Allowlist (function name → reason, matching (a)–(d) above): `engine_buy_contract`, `engine_quote_contract` → limits lookup and exposure bucket; `engine_tick_exposure` → exposure bucket; `enroll_practice_account`, `reset_practice_balance` → funding/credit operations; `enable_real_accounts` (see "Real go-live gate") → the gate itself. Every other engine function branching on `execution_mode` fails the check. Ship this script in Phase 2 and run it as part of every subsequent phase's `npm test`. Add a second, small check in the same script: any migration that creates or replaces an object inside an engine schema/table but is **not** named `*_engine_*` fails with the filename — this closes the gap where someone could dodge the parity scan just by naming a file wrong.

### Backend rules

1. **Explicit account selection.** Every account-scoped command takes `p_account_id`. The server verifies the account belongs to `auth.uid()`, is `ACTIVE`, that its mode is currently allowed (`DEMO` yes; `REAL` only if `module_enabled('real_accounts')`, otherwise `real_disabled`), and that no restriction blocks it. The browser never supplies a mode flag, and there is no fallback from one account to another.
2. **Typed consistency.** Account mode is immutable. Contracts carry `execution_mode` and reference their account through a composite foreign key so a contract's mode can never disagree with its account (2.0).
3. **Ledger integrity across shared tables.** Entries must belong to the transaction's account and match their wallet's asset; wallet scope must match account mode (2.0).
4. **Exposure buckets per mode** (2.9). Practice never counts toward Real liability.
5. **Limits per mode** (2.11). Economics (margin, contract set, tick bounds) are common so Practice mirrors Real.
6. **Independent streams, shared code.** Practice and Real each get their own indices, epochs, seeds and ticks (2.1–2.5); nothing about the tick data is shared, only the SQL that generates it. Real's seed still must move to real-grade custody before `real_accounts` is enabled — see "Real go-live gate".
7. **Lazy enrollment.** Signup creates only the profile (1A.7). `enroll_practice_account()` is called on first visit to the app; it is idempotent and creates the practice account, its wallet and the opening credit.
8. **Operations.** Every admin list has an account-type filter (Practice / Real / All). Every engine audit row carries `execution_mode`. When Real exists, staff actions on REAL accounts require `require_staff(capability, true)` (fresh re-authentication) and voids stay Owner-only.
9. **No funding credentials in the engine.** Real funding (Daraja) will be a separate Edge Function with its own secrets. No engine cron job or engine function may hold or read funding credentials.
10. **One account per mode per user.** `trading_accounts` gets `unique (user_id, execution_mode)` (2.0). A user has at most one Practice account and, later, at most one Real account. This closes off using multiple accounts of the same mode to bypass per-account limits or exposure buckets.

### Frontend rules (the account switcher stays)

1. **One set of pages.** A header **account switcher** (`assets/js/account-switcher.js`) lists the customer's accounts from `list_my_accounts()`. Practice is selectable. Real is shown but disabled ("Not available yet") while `get_engine_config().real_enabled` is false; there is no creation path.
2. **One context object.** `assets/js/account-context.js` holds `{ accountId, mode, currency }` and is the only source of the active account. Every data call receives it explicitly. No defaults, no fallback to another account. If the account is missing, inactive or not the expected mode, actions stop and the reason is shown.
3. **Sessions start in Practice.** Switching to Real is an explicit action every session (with step-up authentication when Real exists).
4. **Mode identity.** `<body data-mode="demo|real">` drives CSS tokens in `assets/css/mode-tokens.css`. Practice shows a persistent "PRACTICE · virtual funds" ribbon, a distinct accent colour, a balance labelled "Practice balance", and a Buy button reading "Buy · Practice". Define the token structure for both modes now; only Practice is styled and reachable.
5. **Switching resets everything.** Clear the order form and any pending quote, cancel timers, unsubscribe and resubscribe realtime, drop every cache keyed by account, re-fetch. Never carry a value from one account into another.
6. **Mode-specific screens.** Practice has "Reset practice balance". A Cashier (deposit/withdraw) exists only for Real, later, and never appears in Practice.
7. **Namespaced keys.** All storage, cache and subscription keys are `<mode>:<accountId>:<key>` through one helper.
8. `profile.html` stays identity-focused. Balances and history appear only for the active account, on the dashboard and trade pages.

---

## Restrictions: type, scope and severity

The existing `public.account_restrictions` (only `TRADING`, always total) becomes a graded model. Extend it in a new migration; existing rows keep their meaning (`TRADING`, scope `ALL`, severity `BLOCKED`).

| Dimension | Values |
|---|---|
| **Type** (what is restricted) | `TRADING` (opening new contracts; open contracts still settle), `WITHDRAWAL`, `DEPOSIT`, `ACCESS` (all account actions) |
| **Scope** (which accounts) | `ALL`, `DEMO`, `REAL` |
| **Severity** (gravity) | `NOTICE` (recorded and shown to the customer, no enforcement), `LIMITED` (enforces `params`), `BLOCKED` (hard stop) |
| **Duration** | optional `expires_at`; expired rows are ignored at read time |

`LIMITED` params: for `TRADING`: `max_stake`, `max_open_contracts`, `max_daily_net_loss`; for `DEPOSIT`/`WITHDRAWAL`: `max_amount_per_day` (validated and stored now; enforced by the future cashier). Reject unknown params.

**Resolution.** `public.effective_restrictions(p_user uuid, p_mode text, p_type text)` (internal, security definer, no browser grant) considers active, unexpired rows of that type whose scope is `ALL` or the account's mode, and returns `blocked` (any `BLOCKED`), `limits` (per param, the minimum across `LIMITED` rows) and `notices`.

**Enforcement in this build.** `TRADING` blocked → `trading_restricted`. `TRADING` limited and the request exceeds a limit → `restricted_limit_exceeded` (never silently clamp). `max_daily_net_loss` compares `net loss today + new stake`, where net loss today is Σ(stake − payout) over losing-side settled contracts of that account since 00:00 UTC, floored at 0. `ACCESS` blocked → every customer RPC except `get_my_active_restrictions` raises `access_restricted`. Also list the ban-at-auth-layer (Supabase Auth ban and session revocation for `ACCESS`) as an explicit follow-up in `docs/RESTRICTIONS.md`; do not simulate it.

**Gravity decides who may apply and lift.**

| Restriction | Capability | Who |
|---|---|---|
| `NOTICE` (any type/scope) | `customers.restrict.notice` | support agent, administrator, owner |
| `LIMITED` (any type/scope) | `customers.restrict.limit` | administrator, owner |
| `BLOCKED`, type `TRADING`, scope `DEMO` | `customers.restrict.block` | administrator, owner |
| `BLOCKED` with scope `REAL` or `ALL`, or type `ACCESS`/`WITHDRAWAL`/`DEPOSIT` | `customers.restrict.block_severe` | owner only, with fresh re-authentication |

Lifting requires the same capability the restriction needed to be applied, plus a reason. A new restriction of the same type and scope supersedes the old one (existing behaviour) only if the actor holds the higher of the two required capabilities. Replace `customers.restrict_trading` everywhere. Update `apply_account_restriction` to take type, scope, severity, params, expiry and reason (drop the old 3-argument version and its grant); extend `get_my_active_restrictions()` to return type, scope, severity, params, expiry, reason, applied_at; audit rows carry all of these. The customer sees an `aria-live` banner for restrictions that apply to the active account (notice text, the limits in force, or the block reason and expiry). The admin Customers tab shows only the choices the staff member's capabilities allow (the server enforces regardless).

---

## Real go-live gate: `real_accounts` cannot be flipped on casually

Enabling Real is not a boolean update. It is a function call that fails unless a documented, versioned checklist has been satisfied, so the decision is auditable and cannot be made by editing a row in a database client.

1. `docs/REAL_READINESS_CHECKLIST.md` is a versioned document (`v1`, `v2`, ...) listing, at minimum: Real seed generation moved to custody outside this database (2.4); Real funding (Daraja) implemented, reconciled and load-tested; Real policy limits (2.11) reviewed and published; step-up authentication implemented for Real (Frontend rule 3); the conformance and parity test suites (below) green against a live-shaped Real fixture; a named Owner sign-off. Each item has an evidence reference (a PR link, a report, a run id) — free text is not acceptable.
2. `public.real_readiness_checklists(version text primary key, published_at timestamptz not null, items jsonb not null, published_by uuid not null references auth.users)`. Immutable once published. No browser grants.
3. `public.enable_real_accounts(p_checklist_version text, p_evidence jsonb, p_reason text)`: capability `platform.enable_real` (Owner only, `require_staff(..., true)` fresh re-authentication). Validates `p_checklist_version` matches the **latest** published checklist (`checklist_outdated` otherwise), that `p_evidence` has a non-empty value for every item key in that checklist (`evidence_incomplete` otherwise listing the missing keys), and that `char_length(btrim(p_reason)) >= 20`. On success: sets `platform_modules.real_accounts = true`, writes an `admin_audit_events` row with `action = 'platform.enable_real'` and `after_state` containing the checklist version and the full evidence object, and returns the audit event id.
4. There is no corresponding "just flip it back off" path with the same ease: disabling `real_accounts` again (if ever needed) goes through a separate, equally audited `disable_real_accounts(p_reason)`, Owner-only, and does not un-publish the checklist.
5. This brief does not publish a checklist, does not implement Real funding, and does not call `enable_real_accounts`. It only builds the gate, so that whoever adds Real later cannot skip it by accident, and so the go-live decision has a paper trail from day one rather than being retrofitted under pressure.

---

## Phase 0: repository hygiene

1. `.env.local` is **tracked in git** (commit `7c83676`) and contains real-looking values for `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_URL`, `RESEND_API_KEY`, `FCSAPI_KEY`. Run `git rm --cached .env.local` and untrack `supabase/.temp/`; add both to `.gitignore`. Do not rewrite history; report that I must rotate every key listed and purge history myself.
2. Rewrite `.env.example` to contain only variables the new product needs. Remove `FCSAPI_KEY`, Upstash, and anything used only by the crypto module (list them in `modules/crypto-spot/README.md`).
3. Add a test that fails if `.env.local`, `.env`, or a file matching `*.pem`/`*service_role*` is tracked (`git ls-files`).

## Phase 1: disable the crypto module (keep everything, remove all references)

Interpretation: "operations side" = admin console, RBAC, platform overview, Edge Functions, cron, scripts, docs. Also remove crypto from customer surfaces because the product is changing.

### 1A. Database (one new migration, e.g. `20260920100000_disable_crypto_module.sql`)

1. Create `public.platform_modules(module_key text primary key, enabled boolean not null, changed_at timestamptz not null default now(), reason text not null)`. Seed `crypto_spot=false`, `digit_indices=true`, `real_accounts=false`. `real_accounts` may only be changed by a reviewed migration or owner SQL; no admin UI toggles it. RLS on, no browser grants. Add `public.module_enabled(text) returns boolean` (stable, `security definer`, `set search_path = ''`).
2. Release open crypto orders safely: for every order in `ACCEPTED`/`OPEN`/`PARTIALLY_FILLED`, post the reservation release through the existing ledger functions (idempotency key `module-disable-release-<order_id>`), set state `CANCELLED`, append an `execution_events` row with reason `MODULE_DISABLED`. Must be idempotent and leave no stuck `RESERVED` balance. Test it with seeded open orders.
3. Recreate `submit_demo_order`, `cancel_demo_order`, `fill_demo_order`, `process_demo_orders` with a first-line guard `if not public.module_enabled('crypto_spot') then raise exception 'module_disabled'`. Copy the **latest** definitions (check every migration after `20260912200000`; `20260918120000` redefines `submit_demo_order`). Preserve all existing behaviour when the flag is on. Also revoke `execute` on `submit_demo_order`/`cancel_demo_order` from `authenticated`.
4. `select cron.unschedule(jobid) from cron.job where jobname = 'process-demo-orders-every-minute';`
5. Replace operations RPCs: drop `list_admin_market_health`, `set_symbol_trading_status`, `list_admin_demo_orders`, `get_admin_demo_order_detail`; recreate `get_platform_overview` and `get_admin_customer_detail` without any order/market fields (their replacements arrive in Phase 4; until then the overview reports contract/engine fields as they become available, never crypto). Keep all crypto **tables and data** untouched.
6. RBAC: replace `trading.read_demo` → `contracts.read` and `markets.manage` → `engine.manage`; add `engine.read` (administrator, owner) and `contracts.void` (owner only); replace `customers.restrict_trading` with the four restriction capabilities in "Restrictions" (support agent gets `customers.restrict.notice` only); add `platform.enable_real` (owner only, "Real go-live gate"). Update `admin_private.role_capabilities()`, every `require_staff(...)` call site, and the affected permission tests.
7. Lazy enrollment: replace `handle_new_user` so a new user gets only the `profiles` row (no trading account, no wallets, no USDT credit). Existing accounts and history are untouched. Practice accounts are created by `enroll_practice_account()` (2.13), which also serves existing users who already have a DEMO account: it finds it, provisions the `USD` wallet if missing and posts the opening credit once (idempotency key `practice-opening-credit-v1`), ignoring historic USDT rows. Test that signup still succeeds end to end (signup must never fail) and note in `docs/MODULES.md` that re-enabling `crypto_spot` requires backfilling its accounts.

### 1B. Edge Functions and cron

1. `git mv` `refresh-market-quote`, `cron-process-demo-orders`, `_shared/market-data.mjs`, `_shared/quote-cache.mjs` into `supabase/functions/_disabled/crypto-spot/` (directories that do not start with a letter are not valid function slugs; verify the CLI's discovery ignores the folder). Keep `_shared/http.mjs`, `cors.mjs`, `errors.mjs` only if the new product uses them; otherwise move them too.
2. Add `supabase/functions/_disabled/crypto-spot/README.md` with exact re-enable steps.
3. Give me (do not run) the commands: `supabase functions delete refresh-market-quote`, `supabase functions delete cron-process-demo-orders`, `supabase secrets unset CRON_SECRET UPSTASH_REDIS_REST_URL UPSTASH_REDIS_REST_TOKEN`, and note the `cron_secret` Vault entry to delete in the dashboard.

### 1C. Frontend

1. `git mv` crypto-only browser code and the crypto trade page into `modules/crypto-spot/` (`assets/js/{market-registry,market-ticker,market-overview,order-form,order-errors}.js`, the old `trade.js`, old `pages/trade.html`, crypto-only CSS such as `trade.css` pieces if separable). Write `modules/crypto-spot/README.md` explaining how to re-mount it.
2. Remove every `<script>`/`<link>` to moved files from `index.html`, `dashboard.html`, `profile.html`, `trade.html`, `admin.html`. `account-data.js` must stop assuming a USDT wallet and spot positions; it reads the `engine_ledger_asset()` wallet and contract summaries.
3. Move crypto tests to `modules/crypto-spot/tests/` and add `npm run test:crypto-legacy` for them. `npm test` runs active tests only. Tests that mix concerns are rewritten, not deleted.

### 1D. Acceptance gate for Phase 1

`grep -rniE "binance|bitcoin|\bbtc\b|\beth\b|usdt|crypto|market_symbol|market-registry|market-ticker|fcsapi|upstash" pages assets supabase/functions tests docs README.md package.json .env.example` returns **no matches**, except inside `modules/`, `supabase/functions/_disabled/`, `supabase/migrations/` (history) and `docs/MODULES.md`. Add this grep as a test. Also test: `submit_demo_order` raises `module_disabled`; the cron job is absent; no open crypto order retains a reservation.

---

## Phase 2: the engine (database-native; all logic in SQL, deterministic, tested)

### 2.0 Foundation hardening (the shared account/ledger tables now serve both account types)

Do this first, in its own migration, before any engine table. These items come from `supabase/DEMO_AND_REAL_TRADING.md` (required before real trading) and are cheap now, expensive later.

1. Make `trading_accounts.execution_mode` immutable (trigger rejects any update of it), add `unique (id, execution_mode)`, and add `unique (user_id, execution_mode)` so a user can hold at most one account of each mode (Backend rule 10).
2. Ledger entries must belong to the transaction's account: a trigger on `ledger_entries` insert verifies that the entry's ledger account → wallet → trading account equals the transaction's `trading_account_id`, and that the entry's `asset` equals the wallet's `asset`. (The existing wallet-scope trigger already ties wallet scope to account mode.)
3. `engine_contracts` (2.7) carries `execution_mode` with composite FK `(trading_account_id, execution_mode)` → `trading_accounts(id, execution_mode)`.
4. Tests: a posting into another account's ledger account is rejected; a wallet or contract with a mode different from its account is rejected; updating an account's mode is rejected; a second account of the same mode for the same user is rejected. Do not alter existing crypto rows.

### 2.1 Vocabulary

- **Index**: a named synthetic series with a fixed tick cadence.
- **Tick**: `(index_code, tick_no, scheduled_at, price, digit)`. `scheduled_at(n) = t0 + n × interval`, n ≥ 1. `tick_no` is a pure function of time; the engine never chooses it.
- **Digit**: the integer 0–9 that is both the settlement value and the last decimal digit of the displayed price.
- **Epoch**: one UTC day, **per account type**. Practice and Real never share a seed, an epoch, a tick or a digit, even though they use identical index configs and code. Each index exists as one row per `(code, execution_mode)`: same economics, independent randomness. This is what actually resolves the overlap concern — not a policy promise, but a key structure that makes cross-mode leakage a foreign-key violation, not a discipline problem.

### 2.2 Digit derivation (normative; JS verifier and SQL must match byte for byte)

```
seed        : 32 bytes
commitment  : lowercase hex SHA-256(seed)
for counter k = 0,1,2,...:
    block = HMAC-SHA256(key = seed, message = UTF-8("digit|" + execution_mode + "|" + index_code + "|" + tick_no + "|" + k))
    for each byte b in block, in order:
        if b < 250: digit = b mod 10; STOP
```

Rejecting bytes ≥ 250 removes modulo bias (250 = 25 × 10). The digit is independent of the price path and of every other tick.

Known-answer vectors (compute with the same algorithm in SQL, JS and a test; all three must agree):

```
seed (hex)      000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f
commitment      630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd
SPI10  n=1..20  6 9 0 5 5 0 9 1 3 6 8 9 2 5 7 3 8 9 1 3
SPI100 n=1..20  8 7 3 7 9 8 8 2 9 3 1 3 4 7 9 0 2 8 7 6
HMAC(seed, "digit|DEMO|SPI10|1|0") = recompute with this exact message; the vectors above were generated before the mode was folded into the message, so re-derive and re-check all vectors once `execution_mode` is added to the HMAC input, and commit the regenerated vectors into `docs/ENGINE_SPEC.md` and the test file before relying on them.
```

### 2.3 Price path (display only; not part of the fairness proof)

- State `x` = natural log of an underlying value, starting at `ln(base_price)`.
- Each tick: `x ← x + κ·(ln(base_price) − x) + σ·z`, `κ = 0.0005`, `z ~ N(0,1)` derived deterministically from `HMAC(seed, "walk|" + execution_mode + "|" + index_code + "|" + tick_no + "|0")` (Box–Muller from two 53-bit uniforms in (0,1)). The same `(seed, index, n, prior state)` must always reproduce the same tick, so a crash and retry can never re-roll an outcome.
- Displayed price: `u = 10^-decimals`, `band = floor(exp(x) / (10u))`, `price = (band × 10 + digit) × u`. This guarantees `round(price / u) mod 10 = digit` exactly. Test this invariant on 100 000 ticks per index and enforce it in a trigger on `index_ticks`.
- Index config validation (reject otherwise): `base_price × sigma ≥ 200 × u`, `decimals` 2–5, interval ∈ {1000, 2000} ms.

Default indices:

| code | display name | interval | decimals | base | sigma |
|---|---|---|---|---|---|
| SPI10 | SmartProfit Index 10 | 2000 | 3 | 1000 | 0.0004 |
| SPI25 | SmartProfit Index 25 | 2000 | 3 | 1000 | 0.0010 |
| SPI50 | SmartProfit Index 50 | 2000 | 3 | 1000 | 0.0020 |
| SPI75 | SmartProfit Index 75 | 2000 | 3 | 1000 | 0.0030 |
| SPI100 | SmartProfit Index 100 | 2000 | 3 | 1000 | 0.0040 |

State plainly in `docs/ENGINE_SPEC.md` that for digit contracts the volatility tier is cosmetic: outcomes depend only on the uniform digit stream. State equally plainly that SPI10 under Practice and SPI10 under Real are the same index by name and config only; their tick histories are independent from the first tick, because they are different rows with different seeds.

### 2.4 Epochs, commit-reveal, tamper evidence

- `engine_private.epoch_seeds(epoch_id, execution_mode, seed bytea check (octet_length(seed)=32))`: schema `engine_private` has **no** grants to `anon`, `authenticated` or `service_role`; only `security definer` engine functions read it. A Practice seed and a Real seed are different rows generated by different calls; nothing in the schema ties them together.
- `public.engine_epochs(id, execution_mode, starts_at, ends_at, seed_commitment, prev_chain_hash, chain_hash, committed_at, revealed_seed, revealed_at)`, `chain_hash = sha256(prev_chain_hash || epoch_id || execution_mode || seed_commitment)`, with `prev_chain_hash` chained **within** each mode's own sequence, not across modes. Immutable except the reveal columns.
- `engine_ensure_epochs()` guarantees epochs for today and tomorrow exist **for every mode with at least one ACTIVE-or-PAUSED index** (so it does nothing for REAL while `real_accounts` is off and no REAL index rows exist), commitment published at least 12 h before use, except the very first epoch of a mode.
- `engine_reveal_due_epochs()` (cron, every minute): reveal an epoch's seed only when `ends_at + 10 minutes` has passed and no OPEN contract of that same mode has an entry or settle tick inside it.
- `get_epoch_proofs(p_account_id, p_index, p_limit)` resolves the mode from the account and returns commitments, chain hashes and revealed seeds for that mode only; a Practice user can never fetch Real's epoch data even after reveal.
- `pages/fairness.html` + `assets/js/fairness.js`: in-browser verifier using WebCrypto (`crypto.subtle`). Input: index, tick range. Output: commitment check, count of digits verified vs mismatches. It must pass the vectors above in a jsdom test.
- Document honestly in the spec: commit-reveal proves the seed was not changed after commitment and lets anyone audit past digits; it does **not** prove the operator did not choose a favourable seed before committing, and while the seed lives in the database anyone with database superuser can compute future digits. State that seed custody must move to an isolated signer before `real_accounts` is enabled, and that this is now a per-mode requirement, not a platform-wide one: Practice's seed can stay in-database indefinitely (it is not money), and Real's seed is the only one that must move before go-live. This is enforced procedurally by "Real go-live gate" below, not by this migration.

### 2.5 Schedule and tick generation

- Tables: `engine_indices(code, execution_mode, display_name, sort_order, tick_interval_ms, decimals, base_price, sigma_per_tick, kappa, status 'ACTIVE'|'PAUSED', t0, created_at, primary key(code, execution_mode))`, `index_state(index_code, execution_mode, last_tick_no, last_x, last_price, updated_at, primary key(index_code, execution_mode))` (the "head" row), `index_ticks(index_code, execution_mode, tick_no, epoch_id, scheduled_at, generated_at, price, digit, primary key(index_code, execution_mode, tick_no))`. Seed only `(code, 'DEMO')` rows for the five indices in this brief; do not insert any `'REAL'` row now — creating them is itself part of the go-live gate below, not something Astra does today.
- `index_ticks` is append-only (extend `reject_mutation()` usage) except a definer-only `engine_purge_ticks()` that deletes ticks older than `tick_retention_days` (default 30) only when the epoch is revealed and no contract references them. Contracts store their own proof fields so purging loses nothing.
- `PAUSED` only blocks new purchases. Ticks always continue so open contracts settle.
- `public.engine_advance()`: for each ACTIVE-or-PAUSED `(index, execution_mode)` row, take `pg_try_advisory_xact_lock(hashtextextended('engine:'||code||':'||execution_mode,0))` (skip if busy), compute `due = floor((clock_timestamp() − t0) / interval)`, and for `n = last_tick_no+1 … min(due, last_tick_no + 50)` insert the tick, update `index_state`, then run settlement (2.8) scoped to that same mode. It is idempotent and safe under overlapping calls. Because no `'REAL'` index rows exist yet, this runs against `DEMO` only today; enabling Real later is adding rows, not changing this function.
- Schedule with pg_cron **seconds syntax** (`cron.schedule('engine-advance', '1 seconds', 'select public.engine_advance()')`). In the migration, `DO`-check `pg_cron` version ≥ 1.5 and raise a clear error if it is older; do not improvise a fallback, stop and report. Also schedule `engine_reveal_due_epochs` (every minute) and `engine_purge_ticks` (daily); both already iterate by mode per the changes above. No `pg_net`, no secrets in cron.
- Realtime: an `after insert` trigger on `index_ticks` broadcasts `{index_code,tick_no,price,digit,scheduled_at}` on the private channel `ticks:<execution_mode>:<index_code>` (lower-cased mode) using database broadcast (`realtime.send`, not `postgres_changes`, which does not scale to per-second fan-out). Add the RLS policy on `realtime.messages` so only `authenticated` users may receive `ticks:demo:%` topics; do not open a `ticks:real:%` policy in this brief — add it when Real launches, so a client cannot even subscribe to a Real topic that does not exist yet. Verify against the current Supabase Realtime docs before writing; if the API differs, stop and report.

### 2.6 Contract types and payout math

Winning-digit sets: `EVEN` {0,2,4,6,8}; `ODD` {1,3,5,7,9}; `OVER(b)` {b+1..9}, b ∈ 0..8; `UNDER(b)` {0..b−1}, b ∈ 1..9; `MATCH(d)` {d}; `DIFFER(d)` all but d. Let `w` = number of winning digits.

`payout = floor( stake × (1 − margin) × 10 / w , to 2 dp )`, computed in `numeric`, never in floating point. `profit = payout − stake`. Reject a contract when `profit < min_profit_ratio × stake` (default 1 %). Policy publication must validate that every enabled contract type satisfies this for every legal barrier.

Known-answer payouts at margin 0.035 (exact decimal, floor to 2 dp):

```
stake 100.00: w=5 → 193.00   w=9 → 107.22   w=3 → 321.66   w=1 → 965.00
stake  37.00: w=5 →  71.41
stake  10.00: w=9 →  10.72
```

Trap: IEEE floats give 964.99 for `100 × 0.965 / 0.1`. A test must assert 965.00.

Because payout is floored to the cent, the effective margin on very small stakes is slightly above the nominal margin (for example, stake 1.00 at w=5 pays 1.93, exactly nominal, but stake 1.01 pays 1.94 vs an exact 1.9493). This is intended and always favours the house; document it in `ENGINE_POLICY.md`.

### 2.7 Buying (linearizable; no look-ahead)

`engine_buy_contract(p_account_id uuid, p_index text, p_type text, p_barrier smallint, p_stake numeric, p_tick_count int, p_idempotency_key text)` (the account's `execution_mode` resolves which `(index_code, execution_mode)` row, epoch and tick stream this call reads and writes; the caller never passes a mode):

1. Verify `p_account_id` belongs to `auth.uid()` and is `ACTIVE` (`account_not_available` otherwise), and that its mode is allowed (`real_disabled` for REAL while `real_accounts` is off). Reject if module `digit_indices` is disabled, the index is PAUSED, the contract type is disabled, `effective_restrictions` blocks or limits the request (`trading_restricted`, `restricted_limit_exceeded`, `access_restricted`), the account's per-mode limits (2.11) are violated (`limits_not_configured` if the mode has no limits row), the feed is stale (`now() − last tick scheduled_at > max_feed_lag_seconds`, default 10 → `feed_stale`), or the per-minute rate is exceeded (per-mode `max_buys_per_minute`, default 30, server-side table).
2. Lock the account row `for update`, then the index's `index_state` row `for share`. The tick writer takes the same row `for update`. This makes every buy strictly ordered against every tick commit.
3. `entry_tick_no = greatest(index_state.last_tick_no, floor((clock_timestamp() − t0)/interval)) + 1` (all three values read from the `(index_code, execution_mode)` row locked in step 2); `settle_tick_no = entry_tick_no + tick_count − 1`. The entry tick is therefore always strictly after every tick that is committed, due, or visible to any client.
4. Compute payout from the **current** policy version; store `policy_version`, `payout`, `payout_multiplier`, `win_digits` count on the contract (immutable).
5. Check and update exposure (2.9).
6. Post the ledger reservation (2.10). Insert the contract and a `contract_events` row.
7. Idempotency: `unique (trading_account_id, idempotency_key)` on `engine_contracts`. Same account, same key and identical payload hash returns the existing contract; same account, same key and a different payload raises `idempotency_conflict`. The key is never unique platform-wide, so two different accounts (including a user's own DEMO and, later, REAL account) may reuse the same client-generated key without colliding.

`engine_quote_contract(p_account_id, ...)` returns the same numbers without side effects for the UI; the buy always recomputes server-side.

### 2.8 Settlement, void, fault isolation

- After inserting tick `n` for an index, settle all `OPEN` contracts with `settle_tick_no = n`, each inside its own `begin … exception when others` block (a savepoint). A failing contract is flagged (`settlement_attempts`, `last_error`), retried on the next run, and **must never prevent a tick from being published or another contract from settling**.
- Win iff `exit_digit ∈ winning set`. Store `exit_digit`, `exit_price`, `exit_epoch_id`, `settled_at`, state `WON|LOST`. Ledger idempotency key `settle-<contract_id>`.
- **Void with refund** (`VOID`, reason `ENGINE_DELAY`) when the settle tick was generated more than `max_settlement_delay_seconds` (default 30) after its `scheduled_at`. An engine fault must never cost a user money.
- Manual void: `void_contract(p_contract_id, p_reason)`, capability `contracts.void` (Owner), only for `OPEN` contracts, reason ≥ 10 chars, audited, refund via the ledger.

### 2.9 Exposure control (within a mode, all its bets share one tick stream, so risk is correlated)

- `engine_tick_exposure(execution_mode, index_code, settle_tick_no, net_loss_by_digit numeric[10])`: for each possible exit digit, the house's net loss if that digit lands = Σ(payout − stake of winners) − Σ(stake of losers) **within that mode's own tick stream**, since Practice and Real exit digits are drawn from entirely independent sequences and can never coincide by construction, not merely by convention. Updated inside `engine_buy_contract` under a row lock per `(mode, index, settle tick)`.
- Reject with `exposure_limit` if `max(net_loss_by_digit)` would exceed the mode's `max_liability_per_tick`. Practice and Real exposure live in separate buckets and never offset each other. Also enforce the mode's `max_open_contracts`, `max_stake` and `min_stake` from 2.11.
- Purge exposure rows after settlement.

### 2.10 Ledger postings (asset = `engine_ledger_asset()`; extend, do not weaken, existing invariants)

Write a mode-aware helper (derive `ledger_scope` from the account's `execution_mode`; do not reuse `post_demo_ledger` if it hard-codes DEMO):

| Event | Entries |
|---|---|
| Buy | `AVAILABLE −stake`, `RESERVED +stake` |
| Win | `RESERVED −stake`, `AVAILABLE +payout`, `REALIZED_PNL −(payout − stake)` |
| Loss | `RESERVED −stake`, `REALIZED_PNL +stake` |
| Void | `RESERVED −stake`, `AVAILABLE +stake` |

Each transaction must net to zero per asset (the existing deferred trigger enforces this).

### 2.11 Policy versioning

- `engine_policy_versions(version, effective_from, house_margin, margin_overrides jsonb, min_ticks, max_ticks, max_settlement_delay_seconds, max_feed_lag_seconds, min_profit_ratio, tick_retention_days, enabled_contract_types text[], created_by, reason)` holds the economics common to every account type, so Practice mirrors Real. `engine_policy_limits(policy_version, execution_mode, min_stake, max_stake, max_open_contracts, max_buys_per_minute, max_liability_per_tick)` holds per-mode limits. Seed the `DEMO` row with: min_stake 1.00, max_stake 1 000.00, max_open_contracts 20, max_buys_per_minute 30, max_liability_per_tick 100 000.00 USD. Do not seed a `REAL` row; Real limits are chosen when Real is designed. Immutable rows. `publish_engine_policy(p_policy jsonb, p_reason text)` (capability `engine.manage`) validates, inserts a new version, writes an `admin_audit_events` row. Changes affect **new** purchases only; contracts carry their own version.
- Seed version 1 with the defaults in this brief. Publishing a policy that changes economics also requires the coverage validation in 2.6.

### 2.12 Health monitoring

`get_admin_engine_health()` (capability `engine.read`) returns per index: last tick number and lag, count of missing ticks in the last hour, stuck (unsettled past due) contracts, `settlement_attempts > 3` contracts, and a rolling digit-quality report over the last 10 000 ticks: χ² vs uniform (9 d.o.f.), maximum lag-1 digit-pair deviation, and longest run. Status: `healthy`; `watch` if χ² > 33.72 (p ≈ 1e-4); `alert` if χ² > 44.81 (p ≈ 1e-6). Lag > 10 s = `degraded`. `get_platform_overview` reports `engine_health` (worst index) and `contracts_today` split by account type.

### 2.13 RPC surface and grants

Customer (`authenticated` only; revoke from `public`, `anon`). Account-scoped calls take `p_account_id` and follow Backend rule 1:
- `list_my_accounts()`, `enroll_practice_account()` (idempotent; creates the practice account, `USD` wallet and one opening credit of 10 000.00 USD), `get_engine_config()` (includes `ledger_asset`, `real_enabled`, indices, enabled contract types, limits for the caller's accounts, server time), `get_account_summary(p_account_id)`, `engine_quote_contract`, `engine_buy_contract`, `list_my_contracts(p_account_id, state, before, limit)`, `reset_practice_balance(p_account_id)`, `get_my_active_restrictions()`.
- Account-independent (shared stream): `get_recent_ticks(index, limit ≤ 500)`, `get_ticks_since(index, after_tick_no, limit ≤ 500)`, `get_epoch_proofs(index, limit)`.
- Cron/engine only: `engine_advance`, `engine_ensure_epochs`, `engine_reveal_due_epochs`, `engine_purge_ticks`.
- Staff (existing style, `require_staff`): `list_admin_contracts` (account-type filter), `get_admin_contract_detail`, `get_admin_engine_health`, `set_index_trading_status`, `publish_engine_policy`, `void_contract`, `get_admin_engine_exposure`, plus the restriction RPCs from "Restrictions".

All `security definer`, `set search_path = ''`, fully-qualified names. RLS: users read only contracts and events of their own accounts; ticks readable by `authenticated`; nothing readable in `engine_private`.

### 2.14 Practice-balance reset

`reset_practice_balance(p_account_id)`: rejects any account whose mode is not `DEMO`; allowed only when the account has no OPEN contracts and AVAILABLE < `min_stake`; posts a balanced ledger transaction restoring AVAILABLE to the opening amount; at most once per 24 h; audited.

---

## Phase 3: customer interface

1. New `pages/trade.html` + `assets/js/trade.js` (+ small modules as needed). Vanilla JS, canvas chart (no charting CDN), keep the existing glass design system.
2. Layout: index selector; live price with the **last digit visually emphasised** (always show trailing zeros); strip of the last 20 digits coloured by even/odd; digit frequency bars for the last 100 and 1 000 ticks with a permanent one-line caption: "Each digit is drawn independently. Past digits do not predict the next one."; contract panel (only enabled types, barrier picker when required, stake, ticks 1–10); live quote (payout, profit, win probability) from `engine_quote_contract`; Buy button; open contracts with ticks remaining; settled history; practice balance with a clear "Practice mode, virtual funds" label.
3. Live data: subscribe to the private Realtime channel `ticks:demo:<index_code>` for ticks (Real gets `ticks:real:<index_code>` when it exists, subscribed only when the active account is Real), and to the RLS-protected changes of the active account's contracts for results; on connect and on reconnect call `get_ticks_since` and reconcile by `tick_no` (no gaps, no duplicates). Show `Live` / `Reconnecting`. If no tick arrives for > 3 × interval mark the feed stale and disable Buy. Do not rely on the local clock for tick timing.
4. Errors: map every stable code (`account_not_available`, `real_disabled`, `trading_restricted`, `restricted_limit_exceeded`, `access_restricted`, `feed_stale`, `exposure_limit`, `limits_not_configured`, `idempotency_conflict`, `insufficient_funds`, stake/limit codes, rate limit) to one plain sentence in an `aria-live` region; unknown failures show a short reference id and log details to the console. One idempotency key per purchase intent, reused across retries, new when any field changes.
5. Dashboard: replace the market overview with account summary, recent contracts, win/loss count and net result. Remove ticker components from `index.html`, `dashboard.html`, `profile.html`. Landing page has no live feed.
6. `pages/fairness.html` (2.4). Add "Fairness" to the navigation.
7. Account switcher, account context, mode tokens, restriction banner and switching behaviour exactly as in "Frontend rules" and "Restrictions". Call `enroll_practice_account()` on first load after sign-in.

## Phase 4: operations (admin console)

1. Replace the Trading tab with **Contracts**: filter by account type (Practice / Real / All), account, index, state, date; detail view with entry/settle ticks, digits, payout, policy version, ledger transaction ids, events.
2. Replace the Markets tab with **Engine**: per-index status, lag, last tick, digit-quality status, pause/resume with mandatory reason; current policy with version history and a publish form (with server validation errors shown); exposure view; epochs with commitments and reveal status; stuck contracts list; manual void (Owner only) with reason.
3. Overview: "Market Feed" card becomes "Engine" (`engine_health`); "orders today" becomes "contracts today".
4. Every state-changing action writes `admin_audit_events` and appears in the Audit tab. Update capability gating in `admin.html`/`admin-operations.js` to `engine.read`, `engine.manage`, `contracts.read`, `contracts.void` and the restriction capabilities.
5. Customers tab: replace the single "restrict trading" form with the graded form (type, scope, severity, params, expiry, reason) showing only the choices the staff member may apply, list restrictions with their type/scope/severity/expiry, and lift only what the staff member's capabilities allow. Replace `alert()`/`prompt()` with inline forms and `aria-live` status.

## Phase 5: copy pass (customer-facing text)

Rewrite `index.html`, `about.html`, `faq.html`, `contact.html`, `404.html`, `blog*.html`, footers and page titles for the digit-index product. Replace the crypto blog posts with short factual articles (how digit contracts work; what the house margin is and how payouts are calculated; how to verify fairness). Hard rules: no claim that users can predict outcomes, no profit or earnings claims, no "guaranteed", no testimonials; the FAQ must state the margin, that outcomes are independent, and that practice funds are virtual. Fix the stale `README.md` (accurate architecture, setup, test, module and engine docs).

---

## Scope note: Practice only

This brief builds the **Practice (`DEMO`) account type** only. There are no deposits, withdrawals, M-Pesa/Daraja calls, currency conversion, KYC or REAL account creation anywhere in it. Real is prepared structurally: typed accounts, the parity rule, per-mode limits and exposure, hardened shared tables, the `real_accounts` gate, restriction scopes and the account switcher.

## Tests required (in addition to updating the existing suites)

Database (real Postgres via the existing helper; use two connections for concurrency):
- Known-answer digit and payout vectors from 2.2 and 2.6; SQL vs JS verifier agree.
- Deterministic seed → digit frequency over 200 000 ticks per index: χ² < 21.67; price-digit invariant holds on every tick.
- Linearization: a buy racing `engine_advance` never receives an entry tick ≤ any committed tick; test both orders and a forced sleep inside the writer.
- Idempotency: replay, changed payload conflict, concurrent duplicate.
- Ledger: after a randomized simulation of 5 000 contracts across all types, every transaction nets to zero, `RESERVED` is zero with no OPEN contracts, and each account's AVAILABLE equals opening balance + Σ(profit − loss).
- Fault isolation: a poisoned contract never blocks tick publication or other settlements; delayed tick voids and refunds.
- Exposure cap, stake/limit bounds, policy validation (zero-profit configuration rejected), `limits_not_configured` for a mode with no limits row, module flag guards.
- **Parity:** run the conformance scenarios (digit vectors, payouts, linearization, settlement, void, exposure, ledger invariants, idempotency) for both a DEMO fixture and a REAL fixture. The REAL fixture is created directly by test SQL — inserting its own `engine_indices`/`index_state` rows with `execution_mode = 'REAL'` and enabling `real_accounts` — inside the test database only, never through any product path or the go-live gate. Results must be identical except limits and funding/credits. Also assert that with `real_accounts` off, and with no `'REAL'` index rows present, a REAL account is rejected with `real_disabled`, and that Practice and Real fixtures produce non-overlapping digit sequences from identical tick numbers (proving stream independence, not just separate storage).
- **Parity script:** `npm run check:parity` passes on the shipped migrations (Phase 0/1 crypto-shutdown migrations and all pre-existing history are outside its scope by construction and must never be touched to make it pass), and a test temporarily injects a disallowed `execution_mode` branch into a throwaway `*_engine_*` scratch file to prove the script actually fails when it should, then removes it. A second test proves an engine object created in a migration missing `_engine_` in its filename is caught by the naming-lint check.
- **Real go-live gate:** `enable_real_accounts` rejects a stale checklist version, rejects incomplete evidence naming the missing keys, rejects a reason under 20 characters, rejects a non-owner caller, and requires fresh re-authentication; success sets the flag and writes a complete audit row; `disable_real_accounts` is symmetric and does not un-publish the checklist.
- **Isolation:** Practice and Real exposure buckets never offset each other; a buy with another user's account id is rejected; no fallback between accounts; cross-account and cross-mode writes rejected (2.0).
- **Restrictions:** the full type × scope × severity × mode matrix; expiry; supersede rules; lifting privilege (a lower role cannot lift what a higher role applied); `LIMITED` rejects (never clamps); `max_daily_net_loss`; `ACCESS` gating; legacy rows still behave as `TRADING`/`ALL`/`BLOCKED`; `customers.restrict.block_severe` requires fresh re-authentication.
- Permissions: `anon`/`authenticated` cannot call engine/cron functions, cannot read `engine_private`, cannot read an unrevealed seed, cannot read other users' contracts; staff capabilities enforced.
- Epoch chain hash tamper detection; reveal only after the epoch has ended and contracts are settled.

Frontend (jsdom, matching the existing style): account switcher (Real listed but disabled), session starts in Practice, switching clears form/quote/timers/subscriptions/caches and never carries values, no fallback when the account is missing or inactive, mode tokens applied and ribbon present, namespaced cache keys, restriction banner, trade page payload correctness, error mapping, tick gap reconciliation, stale-feed lockout, idempotency-key handling, no crypto strings in any active DOM, fairness verifier against the vectors, admin tabs and capability gating.

Repository: secrets-not-tracked test (Phase 0), crypto-reference grep gate (Phase 1D).

## Documentation to write

- `docs/ENGINE_SPEC.md`: normative algorithms (2.2–2.10), vectors, honest limits of the fairness proof.
- `docs/ENGINE_POLICY.md`: every policy field, default, and its risk rationale.
- `docs/MODULES.md`: how `crypto_spot` was disabled and the exact steps to re-enable it.
- `docs/ACCOUNT_TYPES.md`: the same-vs-separated table, the parity rule and how `check-parity.mjs` enforces it, per-mode limits and exposure, the frontend switching rules, how Real is added (satisfy the readiness checklist, call `enable_real_accounts`, add REAL limits, funding adapter, step-up sign-in, cashier, seed custody), and what Practice cannot prove (funding, custody, reconciliation, real load, adversarial users with money at stake).
- `docs/REAL_READINESS_CHECKLIST.md`: the `v1` checklist itself (unpublished; a draft ready for an Owner to review and publish before Real work begins).
- `docs/RESTRICTIONS.md`: the type/scope/severity model, the privilege matrix, enforcement points, and the ACCESS ban-at-auth follow-up.
- Update `supabase/README.md`, `supabase/IMPLEMENTATION_STATUS.md`, `docs/PRIVILEGE_ROLES_AND_WORK_ARCHITECTURE.md`, `ADMIN_DASHBOARD_FOUNDATION.md` for the new capabilities and screens. Remove crypto instructions from active docs (they live under `modules/crypto-spot/`).
- A "Before real money" section in `docs/ACCOUNT_TYPES.md` listing what is deliberately missing: seed custody outside the database, REAL account creation path, payments and any currency conversion, Daraja callbacks with idempotent receipt handling, reconciliation, external RNG/engine audit.

## Deliverables and report

For each phase: commit, `npm test` result, and a short list of decisions you made where this brief left room. At the end give me: (1) the ordered commands to apply migrations and deploy/undeploy functions, (2) the secrets I must rotate, (3) any place you stopped instead of guessing, (4) the output of the Phase 1D grep proving it is clean, (5) the output of `npm run check:parity` proving no undeclared branch exists.