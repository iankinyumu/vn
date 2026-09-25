# Runbook: decommission the legacy crypto-spot Edge Functions (F2)

**Finding:** F2 in `docs/REAL_MODE_PHASE0_BASELINE.md`. **Plan:** `docs/CLAUDE_REAL_MODE_DARAJA_SANDBOX_AUDIT_PLAN.md` (decision 5).
**Performer:** Claude. **Reviewer:** Owner (pending). This maintenance change is separate from the Real-mode and Daraja work.

## Evidence captured 2026-09-25T20:47Z (read-only)

| Slug | Deployed version | `verify_jwt` | Deployed `index.ts` sha256 (first 16) | Archived source sha256 (first 16) |
| --- | --- | --- | --- | --- |
| `refresh-market-quote` | 6 | false | `315c6bfe6e23cb2e` | `90517db925ff6d93` |
| `cron-process-demo-orders` | 4 | false | `4ad063f6cb143e04` | `be9f54c4eca86d6d` |

The deployed bundle's `_shared/quote-cache.mjs` hashes to `8014fb3412cd5a78`. `supabase functions download` fetched the deployed source into a scratch directory outside the repository, and that copy is not committed.

**The deployed code is older than the archived source.** The deployed copies are earlier revisions: fixed watchlists, and ad-hoc CORS with `Access-Control-Allow-Origin: *`. Review of the archived source therefore does not cover what is running.

What the deployed code can do:

- `refresh-market-quote` accepts any request that carries a valid Supabase user session, and anyone can register. It then uses the **service-role key** to fetch the Binance book ticker, insert a row into `public.market_snapshots`, and call `process_demo_orders`. That RPC is a no-op, because `crypto_spot` is disabled (`20260920100000_disable_crypto_module.sql`). **Impact:** any registered user can make the platform write unbounded `market_snapshots` rows and call Binance and Upstash on its behalf. No customer money or Practice ledger is reachable.
- `cron-process-demo-orders` requires `X-Cron-Secret` to equal `CRON_SECRET`. Without the secret it rejects the request. With it, the behavior matches the path above.

Search for intended callers:

- **The site:** nothing in `pages/`, `assets/`, `scripts/`, `engine/` or `tests/` calls either slug, `functions/v1` or `functions.invoke`.
- **Scheduled jobs:** the only schedule pointing at these functions was `process-demo-orders-every-minute`. `20260914120000_schedule_demo_order_matching.sql` created it and `20260920100000_disable_crypto_module.sql:88` unscheduled it. The current engine cron jobs (`engine-advance`, `engine-reveal-due-epochs`, `engine-purge-ticks`) call SQL directly.
- **Unknown:** the live `cron.job` table and the function invocation logs were not read in this session. The Owner should confirm both before deletion (step 1).

## Procedure

1. **Confirm there are no live callers (Owner, read-only).**
   - In the SQL editor, run `select jobid, jobname, schedule, command from cron.job where command ilike '%functions/v1%';`. It should return no rows.
   - In the Dashboard, open Edge Functions → each slug → Logs and Invocations. Export the last 7 days (or the full retention period) and store the export outside the repository. Record the export time and invocation counts in the table below. Invocations after 2026-09-20 have no product caller and should be treated as abuse or probing.
2. **Delete both deployments.** This removes only the deployed functions. It does not delete data, secrets, `market_snapshots` rows, engine state or migrations.
   ```
   npx supabase functions delete refresh-market-quote --project-ref cdaxvkpmgqjfukbtrzys
   npx supabase functions delete cron-process-demo-orders --project-ref cdaxvkpmgqjfukbtrzys
   ```
3. **Verify.**
   - `npx supabase functions list` must not list either slug.
   - A `POST https://cdaxvkpmgqjfukbtrzys.supabase.co/functions/v1/refresh-market-quote` must return 404.
   - Load the Practice trade page and check that quotes, buys and the tick feed still work. They do not depend on these functions.
4. **Retire the now-unused secrets (optional, Owner).** `CRON_SECRET`, `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` were read only by these functions. Leave them until the engine-v3 worker configuration has been checked for any Redis use.

**Rollback:** redeploy from `supabase/functions/_disabled/crypto-spot` as that directory's README describes. Rollback is not expected, because the module is disabled in the database.

## Record

| Step | Performed by | Time (UTC) | Result |
| --- | --- | --- | --- |
| Evidence capture | Claude | 2026-09-25T20:47Z | As above |
| 1. Live caller check | — | — | Pending (Owner) |
| 2. Deletion | — | — | Pending Owner go-ahead |
| 3. Verification | — | — | Pending |
| Owner review | — | — | Pending |
