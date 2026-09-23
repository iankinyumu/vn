# Supabase digit-index engine

The active database product is the proprietary Practice digit-index engine. Apply migrations in timestamp order to a reviewed Supabase project; do not connect an agent or browser directly with a service-role key.

Required services are `pgcrypto`, `pg_cron` 1.5 or newer, and Supabase Realtime Broadcast. The engine migration fails clearly when `pg_cron` is unavailable rather than substituting a client-side scheduler.

```powershell
npm test
npm run check:parity
supabase db push
```

After applying migrations, verify cron jobs named `engine-advance`, `engine-reveal-due-epochs`, and `engine-purge-ticks`; verify authenticated users can receive only `ticks:demo:*` private Broadcast topics. Also verify `public.engine_contracts` is in the `supabase_realtime` publication (added by `20260920520000_engine_contract_realtime.sql`); the trade page relies on it for contract results, and row-level security is the only filter on those change events. No Edge Function, provider credential, payment secret, or external market-data source is part of tick generation.

Practice enrolment is lazy through `enroll_practice_account()`. It creates one DEMO USD account with virtual credits. REAL remains disabled and cannot be enabled by updating a module row: the audited `enable_real_accounts` gate is the only route, and Real account creation, funding, and cashier work are deliberately absent.
