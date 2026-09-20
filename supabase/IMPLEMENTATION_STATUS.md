# Codebase Assessment Implementation Status

Verified on 12 September 2026: the demo-engine migration is applied to the configured Supabase project and the `refresh-market-quote` Edge Function is `ACTIVE` (version 1).

## Complete

### Order flow hardened (20 September 2026)

- Both trading Edge Functions answer the CORS preflight before any auth or body parsing and allow exactly `authorization, x-client-info, apikey, content-type`. supabase-js sends `x-client-info` on every `functions.invoke`, so omitting it made the browser discard the request and the customer saw a generic failure.
- Every function error returns `{ error: { code, message }, request_id }` with a stable code (`unauthorized`, `rate_limited`, `unsupported_symbol`, `pair_not_available`, `market_data_unavailable`, `registry_unavailable`, `internal`). The request id is logged server-side with the real cause; the customer never sees server text.
- Upstash Redis is no longer a single point of failure. Missing or failing credentials log one warning per instance and fall back to a per-instance 3 s in-memory micro-cache; the database rate limiter inside `submit_demo_order` still applies.
- Market data tries `data-api.binance.vision` before `api.binance.com` with a 3 s timeout per host, and rejects a zero or crossed book.
- `refresh-market-quote` treats demo matching as best effort: a `process_demo_orders` error or 2 s timeout is logged and swallowed, so the customer still receives a quote and the worker matches the resting order.
- The trade form reports failures inline in an `aria-live` status region instead of `alert()`; an unmapped failure carries a short reference id that is also written to the console with the full error.

### Frontend gaps closed (14 September 2026)

- Public navigation hides sign-in and registration actions for authenticated users.
- Dashboard and trade pages now project open positions, mark them from trusted market snapshots, and display unrealized P&L, total equity, open-order count, and wallet USD equivalents.
- A CRON_SECRET-authorized worker refreshes snapshots for every pair the market registry marks tradable and evaluates resting DEMO orders. The watchlist is registry-driven (`list_executable_symbols`), so a pair added to the registry is picked up without a redeploy.

- Supabase Auth is authoritative; fabricated local-storage sessions are removed.
- DEMO-only account provisioning, isolated wallets, immutable ledger entries, orders, fills, positions, snapshots, and execution events are durable and RLS protected.
- `REAL` has no creation path, writable RPC, broker integration, or credentials path.
- Authenticated DEMO RPCs provide idempotent submission, atomic reservation/settlement, cancellation, basic spot positions, fees, slippage, minimum-notional and quantity-precision checks, and server-side rate limiting.
- Binance bid/ask quotes are fetched server-side, persisted as snapshots, and used by the execution RPC; browser-supplied account and execution-price values are not authoritative.
- The Trade UI uses live Binance depth/trade display only and does not fabricate order-book rows, trade rows, or fallback candles.
- Audit events and immutable ledger/fill records are created for lifecycle actions. Realtime order changes trigger an RLS-protected account refresh.

## Partially complete

- Limit and stop-limit orders are evaluated from each trusted market snapshot; the scheduled worker covers the registry's tradable, unpaused pairs rather than a fixed pair list.
- Market snapshots contain trusted bid/ask data, but not a full normalized depth book or provider sequence stream.
- Precision validation is a safe eight-decimal and minimum-notional rule, not exchange-specific symbol-filter ingestion.
- Realtime updates refresh the account after order changes; a dedicated account-event websocket payload stream is not implemented.

## Not implemented (intentional follow-up work)

- Partial-fill accounting and cancellation-vs-fill race resolution.
- Expiry policies, `CANCEL_PENDING`, and recovery/reconciliation workers.
- BullMQ, a standalone Node/Nest API, and server-worker horizontal scaling. (Upstash Redis *is* used as an optional shared quote cache, cross-instance lock, and quote rate limiter; the quote path degrades to a per-instance in-memory cache when it is absent or failing.)
- Exchange metadata ingestion, stale-feed monitoring, depth sequence reconciliation, and multi-provider failover.
- Automated database integration/failure-recovery tests.
- Any REAL-money execution, broker adapter, or outbound broker credentials.

## Deployment evidence

- Database verification confirmed `submit_demo_order`, `process_demo_orders`, `demo_order_rate_limits`, and `orders` in the `supabase_realtime` publication.
- The Edge Function is intentionally deployed with platform JWT verification disabled because it validates the caller JWT explicitly before performing provider or service-role work.
