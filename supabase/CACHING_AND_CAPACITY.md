# Caching and capacity

Updated: 16 September 2026. Deployment checks below were completed on 15 September 2026 (UTC); this document update did not repeat those live checks.

## Current status

**Shared Redis caching is live in Supabase.** Redis credentials are configured, the database migration is applied, and both backend functions are deployed. The updated frontend is ready in this workspace but has not been published to a website host in this session.

| Part | Status | Purpose |
| --- | --- | --- |
| Upstash Redis | Connected and configured on the server | Shares fresh market quotes across users and limits repeated requests |
| Supabase quote function | Deployed, version 6 at verification | Reuses cached quotes or fetches and saves a fresh quote |
| Scheduled demo worker | Deployed, version 4 at verification | Checks resting BTC/ETH demo orders every minute |
| Account summary queries | Migration applied | Returns balance totals and recent position quotes with account access checks |
| Browser account cache | Implemented locally | Reuses account display data for 15 seconds during reloads and navigation |
| Frontend hosting update | Pending | Makes the updated browser code available on the hosted website |
| Production load testing | Pending | Establishes how many concurrent users the deployment can support |

## Why both cloud and browser caching remain
F
Redis lets different users share the same recent market quote. The browser cache saves an individual user from requesting the same account information again when moving between pages. Removing the browser cache would add network requests even when the server already has the answer.

Private balances and order history are **not stored in Redis** in this implementation. They are read through account access checks and briefly cached in the user's browser tab. Trades still check the actual balance and record changes in Postgres, the main database.

## How it works

- Account display reads use a 15-second, per-tab session cache, keyed by Supabase project, user, DEMO mode, query and account ID. It survives reload/navigation in that tab. Identical in-flight reads share one promise. Expired data is fetched on the next page load/focus; there is no recurring account polling loop.
- Order changes and successful submissions invalidate the cache and refresh the account sections, with events grouped into a 300ms window. Profile saves invalidate cached reads. Sign-out clears cached account data, including from public pages. Identity changes on account pages clear state and redirect to sign-in.
- Transaction history is fetched only on pages that display it. New read-only RPCs return grouped balance totals and the latest fresh quote per position instead of transferring the full ledger or arbitrary batches of historical quotes. These RPCs use invoker security and existing RLS, plus an explicit account ownership condition.
- Redis holds shared DEMO market snapshots for up to three seconds, namespaced by Supabase project and symbol. A 30-second owner-token lock coordinates competing cache misses. A losing request gets a temporary 503 with Retry-After rather than multiplying provider requests and database writes. Cache hits reuse an already persisted snapshot.
- Authenticated quote requests have a shared per-user limit of 30 per minute. Redis requests, provider fetches and snapshot inserts have timeouts. Missing Redis configuration or an outage returns a controlled error; it does not bypass the protection and hit the provider/database directly.
- Resting-order matching runs in the scheduled worker and once per newly ingested user-requested snapshot. Cache hits skip matching, so concurrent requests do not repeat the matching pass. This preserves existing behavior for pairs outside the scheduled watchlist. Both functions share one quote-ingestion implementation; the caller supplies demo matching separately.
- Redis contains no account balances or order authorization state. Submitting an order still writes to Postgres and checks the actual balance there. Browser caching never authorizes a trade.

## Verified deployment

The Redis backend is deployed to Supabase project `cdaxvkpmgqjfukbtrzys`:

- Upstash connection verified with PING; REST credentials configured as server secrets.
- Account read-summary migration applied, including supporting indexes and schema reload.
- `refresh-market-quote` version 6 and `cron-process-demo-orders` version 4 deployed with the shared Redis module.
- Existing authentication settings preserved: the quote function validates the user session; the worker validates its cron secret. Both returned 401 to unauthenticated requests.
- Post-deployment scheduled runs returned HTTP 200 with successful BTCUSDT and ETHUSDT processing.
- Balance and quote RPCs remain security-invoker functions; anonymous execution is denied. Tests as two existing authenticated users returned their own balance rows and zero rows for the other account.
- Six local caching tests passed. These are correctness checks, not production load-test results.

The updated static frontend files are in this workspace. A separate frontend hosting deployment was not performed; the repository does not identify a hosting target. Local account pages can now use the deployed summary RPCs.

## Credentials

- Local Redis settings are in `.env.redis.local`, which is excluded from Git. It holds `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.
- The deployed functions use the corresponding **Supabase Edge Function secrets**. Changing the local file alone does not update the deployed credentials.
- Use the Upstash database's REST read/write token. An account-management API key or read-only token is not a substitute.
- Credentials must stay out of frontend JavaScript, documentation and commits. This document deliberately contains no credential values.

## Remaining work

1. Publish the updated frontend to the intended website host and check signed-in navigation there.
2. Expand scheduled matching beyond BTCUSDT and ETHUSDT. Other pairs currently depend on fresh user-requested quotes for matching.
3. Set a concurrent-user target and load-test the deployed system before making capacity claims.
4. Monitor database load, Redis usage, slow requests, rate-limit responses and worker failures. Add alerts and spending limits where supported.
5. At higher traffic, share chart and order-book feeds through a market-data service and cache static files through the hosting provider.

## Deployment order for future environments

1. Provision an Upstash Redis database near the Supabase function region. Set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` as **Supabase Edge Function secrets**, not browser variables. Keep the existing CRON_SECRET configured.
2. Apply `20260915160000_account_read_summaries.sql` before publishing the frontend. It adds two read-only RPCs and supporting indexes. For a large existing database, plan index creation with a suitable maintenance window or a separately managed concurrent index build.
3. Deploy and smoke-test `refresh-market-quote` and `cron-process-demo-orders` with their shared module and existing authentication configuration. The updated functions require Redis; deploying them without secrets makes quote requests unavailable.
4. Publish the frontend after the RPCs are available. Verify authenticated account ownership/RLS with two test users and compare returned totals against the ledger.
5. Verify scheduled matching still runs. Its existing watchlist remains BTCUSDT and ETHUSDT; expand supported-symbol processing before promising resting-order coverage for other pairs.

## What this does not guarantee

Caching reduces repeat work; it does not guarantee unlimited capacity or zero downtime. The tests use fake Redis/provider/database services and establish application behavior, not production throughput.

Account data can remain unchanged on a continuously open page until an order event, focus or navigation causes another read. It is display data; do not represent it as continuously live. A later funds-transfer integration must also invalidate account views on deposits/withdrawals. Other tabs/devices rely on events and expiry, not a shared private browser cache.

The balance RPC still sums ledger entries in Postgres. It removes unbounded browser transfers and API row-limit errors, but long-lived accounts will eventually need transactionally maintained balance projections with reconciliation. Do not turn Redis into the financial ledger.

Public browser charts/order books still contact Binance directly. They bypass this application database but can hit provider limits. At higher traffic, use a shared market-data ingestion service and public broadcast feed rather than one upstream stream/poll per browser. Use CDN caching for versioned static assets through the actual hosting provider; this repository has no hosting configuration to safely update yet.

Before a public high-traffic launch, test the real deployment with a specified concurrent-user target. Measure p95 latency, Redis hit rate/operations, 429/503 rates, DB CPU/query time/connections, auth requests, Realtime lag, worker duration and provider limits. Add gateway/IP rate limits for unauthenticated traffic and budget alarms. Supabase Postgres Changes has per-subscriber authorization costs; use private Broadcast channels if these subscriptions become a bottleneck. Configure capacity and overload behavior based on those measurements.

## Validation

Run `node --test tests/caching.test.mjs` for navigation reuse, expiry, identity/account/mode isolation, invalidation races, grouped UI refreshes, competing quote requests, outage behavior and per-user limits. Run integration/RLS and load checks on staging before deployment. No production load result is claimed.

## Sources

- [Upstash REST API](https://upstash.com/docs/redis/features/restapi)
- [Supabase Postgres Changes and scaling considerations](https://supabase.com/docs/guides/realtime/postgres-changes)
- [Supabase performance guidance](https://supabase.com/docs/guides/platform/performance)
