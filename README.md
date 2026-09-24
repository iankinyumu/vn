# SmartProfit

SmartProfit is a Practice-only digit-contract platform. Customers trade Even/Odd contracts that settle on the last digit of a tick from SmartProfit's own synthetic indices (`SPI10`–`SPI100`), using 10,000.00 USD of virtual Practice credits. There are no deposits, withdrawals or real-money accounts; the Real account type is designed for but locked behind an audited go-live gate.

## Architecture

- **Frontend** — a static multi-page site. Pages live in `pages/`, vanilla JavaScript in `assets/js/` loaded with plain `<script>` tags (no framework, no bundler), styles in `assets/css/`. The browser talks to Supabase through the publishable key in `assets/js/supabase-config.js`.
  - Customer pages: `dashboard.html` (Practice balance, lifetime wins/losses/net result, latest contracts, Practice reset), `trade.html` (live index feed, digit statistics, quotes and purchases), `fairness.html` (in-browser commit-reveal verifier), `profile.html`, `support.html`, plus the public pages: `index.html`, `about.html`, `faq.html` (answers in `assets/js/faq.js`), `contact.html`, `404.html`, and the Guides (`blog.html` lists `guide-settlement.html`, `guide-payouts.html` and `guide-fairness.html`). Header, navigation and footer for every customer page come from `assets/js/shell.js`.
  - Staff console: `admin.html` with its own isolated staff sign-in (`staff-login.html`, `assets/js/staff-auth.js`). Tabs are gated by server-issued capabilities; the database enforces every capability again.
- **Database** — Supabase Postgres. All engine logic is SQL in `supabase/migrations/`: deterministic tick generation from per-epoch seeds (`gen_random_bytes`, HMAC-SHA256), commit-reveal epochs, quoting, linearizable buying, settlement, exposure caps, per-mode limits, versioned policy, graded customer restrictions, an immutable double-entry ledger and an audit trail. Customer and staff access goes only through `security definer` RPCs with `set search_path = ''`.
- **Scheduling** — `pg_cron` (1.5 or newer, seconds syntax) runs `engine_advance` every second, `engine_reveal_due_epochs` every minute and `engine_purge_ticks` daily.
- **Realtime** — each new tick is broadcast from the database on the private channel `ticks:demo:<INDEX>` (event `tick`); the trade page joins it after `realtime.setAuth()` and falls back to polling `get_ticks_since` whenever the channel is not live. Contract results reach the trade page through `postgres_changes` on `engine_contracts`, filtered by row-level security.
- **Edge Functions** — none are active. `supabase/functions/_disabled/` holds the retired spot-trading functions.
- **Modules** — `public.platform_modules` flags: `digit_indices` on, the retired spot module off, `real_accounts` off. The retired module's browser code and tests are archived in `modules/` (see its README, including how to run its archived tests).

## Setup

```powershell
npm install
npm test
```

`npm test` runs, in order: `npm run check:parity` (fails if an engine function branches on `execution_mode` outside the declared allowlist, or if an engine object is created outside a `*_engine_*` migration), `scripts/test-engine-postgres.mjs` (digit, price-walk and price/digit invariant vectors against a real embedded PostgreSQL using the same HMAC-SHA256 and SHA-256 extension functions as production), and every `tests/*.test.mjs` file with `node:test` (database tests on PGlite through `tests/helpers/test-db.mjs`, browser tests on jsdom).

## Deploying database changes

Apply migrations in timestamp order to a reviewed Supabase project, never by editing an applied migration:

```powershell
supabase db push
```

`node supabase/migration-status.cjs` (read-only, connection string from `TRADING_DB_URL`, never printed) reports which engine migrations a database has applied; `--apply <version>...` applies exactly the named local migrations in order. Then confirm the three cron jobs exist and that authenticated users can receive only `ticks:demo:*` broadcasts. `supabase/README.md` has the full checklist. Deployment credentials never belong in the repository or in `.env.local`; `.env.example` lists the only variables the product uses.

## Deploying the website to Vercel

Set the Vercel project's **Root Directory** to the repository root and **Framework Preset** to Other. The root `vercel.json` runs `npm run build` and serves only `dist/`. That build places `pages/index.html` at `/`, the other pages at `/trade.html`, `/dashboard.html`, etc., and shared assets at `/assets/`. Do not set the Root Directory to `pages`: those files depend on the sibling `assets/` directory.

Run `npm run build` locally to inspect `dist/` before publishing. The build output is ignored by Git; Vercel creates it on each deployment. The database engine remains in Supabase and is not hosted by Vercel.

## Documentation

- `docs/ENGINE_SPEC.md` — normative digit, price, epoch and settlement algorithms, known-answer vectors, and the limits of the fairness proof.
- `docs/ENGINE_POLICY.md` — every policy field, its default and its risk rationale.
- `docs/ACCOUNT_TYPES.md` — typed accounts, the parity rule, per-mode limits and exposure, and what must exist before real money.
- `docs/RESTRICTIONS.md` — the type × scope × severity restriction model and who may apply or lift each grade.
- `docs/REAL_READINESS_CHECKLIST.md` — the draft checklist the Real go-live gate verifies.
- `docs/MODULES.md` — how the retired spot module was disabled and how it could be re-enabled.
- `docs/PRIVILEGE_ROLES_AND_WORK_ARCHITECTURE.md`, `ADMIN_DASHBOARD_FOUNDATION.md`, `supabase/ADMIN_ACCESS.md` — staff roles, capabilities and the operations console.
