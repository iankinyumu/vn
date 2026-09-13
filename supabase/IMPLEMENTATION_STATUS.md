# Codebase Assessment Implementation Status

Verified on 12 September 2026: the demo-engine migration is applied to the configured Supabase project and the `refresh-market-quote` Edge Function is `ACTIVE` (version 1).

## Complete

- Supabase Auth is authoritative; fabricated local-storage sessions are removed.
- DEMO-only account provisioning, isolated wallets, immutable ledger entries, orders, fills, positions, snapshots, and execution events are durable and RLS protected.
- `REAL` has no creation path, writable RPC, broker integration, or credentials path.
- Authenticated DEMO RPCs provide idempotent submission, atomic reservation/settlement, cancellation, basic spot positions, fees, slippage, minimum-notional and quantity-precision checks, and server-side rate limiting.
- Binance bid/ask quotes are fetched server-side, persisted as snapshots, and used by the execution RPC; browser-supplied account and execution-price values are not authoritative.
- The Trade UI uses live Binance depth/trade display only and does not fabricate order-book rows, trade rows, or fallback candles.
- Audit events and immutable ledger/fill records are created for lifecycle actions. Realtime order changes trigger an RLS-protected account refresh.

## Partially complete

- Limit and stop-limit orders are evaluated whenever the quote function runs. A scheduled continuous market-data worker is not deployed.
- Market snapshots contain trusted bid/ask data, but not a full normalized depth book or provider sequence stream.
- Precision validation is a safe eight-decimal and minimum-notional rule, not exchange-specific symbol-filter ingestion.
- Realtime updates refresh the account after order changes; a dedicated account-event websocket payload stream is not implemented.

## Not implemented (intentional follow-up work)

- Partial-fill accounting and cancellation-vs-fill race resolution.
- Expiry policies, `CANCEL_PENDING`, and recovery/reconciliation workers.
- Redis, BullMQ, a standalone Node/Nest API, and server-worker horizontal scaling.
- Exchange metadata ingestion, stale-feed monitoring, depth sequence reconciliation, and multi-provider failover.
- Automated database integration/failure-recovery tests.
- Any REAL-money execution, broker adapter, or outbound broker credentials.

## Deployment evidence

- Database verification confirmed `submit_demo_order`, `process_demo_orders`, `demo_order_rate_limits`, and `orders` in the `supabase_realtime` publication.
- The Edge Function is intentionally deployed with platform JWT verification disabled because it validates the caller JWT explicitly before performing provider or service-role work.
