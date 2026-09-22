# Disabled crypto spot functions

`refresh-market-quote` and `cron-process-demo-orders` are retained here as source history only. This underscore-prefixed archive directory is not a deployable Edge Function slug.

To re-enable: move each directory back under `supabase/functions/`, restore the shared `market-data.mjs` and `quote-cache.mjs` files under `supabase/functions/_shared/`, deploy both functions, set their reviewed server-side secrets, recreate the cron schedule through a reviewed migration, and run the legacy test suite. Re-enable the database module only after those operational steps and account backfill have been reviewed.
