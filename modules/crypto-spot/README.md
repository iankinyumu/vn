# Crypto spot module (disabled)

This directory preserves the former crypto spot implementation and its legacy tests. It is not mounted by an active page, function deployment, cron job, or the default test suite.

To re-enable it safely, first review the historical migrations and restore a reviewed module flag migration. Re-mount the browser files and page only after replacing the digit-index account data calls, restore the two Edge Functions to deployable function directories, configure their required secrets, recreate and verify the cron job, restore the legacy test suite with `npm run test:crypto-legacy`, and backfill the accounts that the original crypto enrolment flow required. Do not re-enable it by changing browser code alone.

Legacy-only configuration removed from `.env.example`: `FCSAPI_KEY`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, and `CRON_SECRET`. The former functions also required server-side Supabase credentials; keep those only in the Supabase secret store.
