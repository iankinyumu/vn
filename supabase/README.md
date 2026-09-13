# Supabase database requirements

The foundation migration plus `20260912200000_demo_execution_engine.sql` implement authenticated DEMO-only paper execution. REAL execution remains prohibited.

## Current implementation status

The foundation migrations and `20260912200000_demo_execution_engine.sql` are applied to the configured Supabase project. The `refresh-market-quote` Edge Function is deployed and active. Each demo account receives 10,000 USDT of virtual opening balance; a signup never creates a REAL account.

The authentication frontend is now connected to Supabase Auth. `assets/js/login.js`, `register.js`, `forgot-password.js`, and `auth.js` use the Supabase client for password sign-in, account creation, password-reset requests, session checks, and logout. Old fabricated `smartprofit_user` browser sessions are deleted. `account-data.js` reads the signed-in user's profile, account, wallets, and ledger balances through row-level security.

The former browser-only login accepted an arbitrary email and password; it was never a database user. Existing mock account information and fake fills are not used for authenticated account data. Order submission refreshes a server-persisted Binance bid/ask quote through an authenticated Edge Function, then calls a security-definer DEMO RPC. Client price and account IDs are never authoritative.

Profile settings now show and update the signed-in user's database `display_name`, show the verified Auth email as read-only, and use generated initials rather than a stock profile image. Transaction history and open orders are populated from the signed-in account's ledger and order records; before those records exist, they show honest empty states instead of sample transactions or sample orders. The UI identifies the current account as `DEMO`; `REAL` is visibly disabled because real accounts and real execution remain prohibited.

## What it establishes

- Supabase Auth is the only authority for sign-up, login, refresh-token rotation, logout, password reset, and session revocation. The browser must not store a fabricated `smartprofit_user` session.
- Each new Supabase Auth user receives a `profiles` row and a single isolated `DEMO` USD trading account. A signup cannot create a `REAL` account.
- Wallets, ledger accounts, immutable double-entry postings, accounts, orders, fills, positions, market snapshots, and execution audit events have durable PostgreSQL tables.
- Row-level security exposes each authenticated user only to their own records. No browser client receives insert, update, or delete permissions for trading data.
- Append-only tables reject update/delete calls, and ledger postings must balance per asset at transaction commit.

## Connection configuration

The applied migration used the root `.env.local`. Keep its credentials local and out of source control. The expected names are:

```dotenv
SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
SUPABASE_PUBLISHABLE_KEY=...
SUPABASE_SERVICE_ROLE_KEY=... # only needed by a future server-side API
# One of the following is required to run the migration remotely:
SUPABASE_DB_URL=postgresql://...
```

The service-role key and database password must remain server-only. The publishable key is used by the browser for Supabase Auth and is safe to expose only because row-level security is enabled.

`assets/js/supabase-config.js` contains only the Supabase URL and publishable key required by this static browser client. It must never contain a service-role key or database URL.

Apply the migration through the Supabase SQL Editor or a linked Supabase CLI project. Review it in a development project first; it creates permanent schema objects and an Auth-user trigger.

## Supabase dashboard settings required for auth

1. Enable email/password authentication and email confirmation.
2. Set the Site URL and exact allowed redirect URLs for the deployed login, registration, and reset-password pages.
3. Set a strong password policy, CAPTCHA/bot protection, and the desired MFA policy before public signups.
4. Keep JWT signing keys, service-role keys, and database credentials out of frontend code and source control.
5. Configure Auth session lifetime, inactivity timeout, refresh-token rotation, and revoke-on-password-change according to the product security policy.

## Deploy the demo execution boundary

Apply `20260912200000_demo_execution_engine.sql`, then deploy the quote ingestion function:

```bash
supabase functions deploy refresh-market-quote --no-verify-jwt
```

Set `SUPABASE_SERVICE_ROLE_KEY` as an Edge Function secret. The function independently checks the caller's JWT, fetches Binance `bookTicker`, writes an immutable snapshot, and evaluates active demo orders. The browser never receives a service key.

For CLI migration deployment, use the project’s **direct PostgreSQL connection string** rather than a transaction-pooler URL. URL-encode reserved password characters. The included `apply-migration.cjs` utility can apply a reviewed SQL migration with `TRADING_DB_URL` supplied only through the environment.

The demo engine supports idempotent market, limit, and stop-limit orders; reservations; cancellation; immutable fills/events/ledger postings; basic fees and slippage; precision and minimum-notional checks; a server-side 20-orders-per-minute limit; spot position tracking; and RLS-protected realtime order refreshes. It is deliberately not a real-money system: `REAL` has no writable path, broker adapter, or broker credentials.
