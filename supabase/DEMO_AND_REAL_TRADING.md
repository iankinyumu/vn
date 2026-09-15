# Demo and real trading review

Reviewed against the local source on 15 September 2026. This is a code review, not confirmation of the deployed database configuration.

## Recommendation

Keep one product and one shared order contract, with separate demo and real execution adapters. Share interface components, validation rules, order states and reporting code. Separate trading accounts, money, credentials and execution workers. Moving to real trading should add an execution adapter, not replace the demo engine or duplicate the entire application.

There is no single universal deployment standard. Alpaca uses different credentials and endpoints for paper and live trading. Coinbase Exchange provides a separate sandbox; Coinbase Advanced Trade's sandbox returns mocked responses, so it cannot establish realistic execution behavior.

- https://docs.alpaca.markets/us/v1.1/docs/authentication-1
- https://docs.cdp.coinbase.com/exchange/introduction/sandbox
- https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/sandbox

## What exists

- Dedicated SQL demo functions submit, match, fill and cancel orders. No real execution adapter was found.
- `submit_demo_order` resolves an active DEMO account from the authenticated user and writes DEMO orders. The browser does not choose a real account for this function.
- The matcher filters DEMO orders. Demo wallet operations use DEMO scope; a database trigger checks wallet scope against the account mode.
- Orders, wallets, positions, events and ledger records share tables and use account IDs. This is logical separation in one database, not separate infrastructure.
- Browser write permissions are restricted; internal demo functions are revoked from public, anonymous and authenticated roles. The matcher is granted to the service role.
- The quote refresh function also triggers demo matching. The scheduled worker duplicates quote ingestion and only watches BTCUSDT and ETHUSDT, while the interface lists more pairs.

## Changes in this review

The frontend no longer falls back to a REAL account when a DEMO account is absent. Order submission now stops when the displayed account is missing, inactive or not DEMO. These are interface safeguards; the existing server-side DEMO account resolution remains the authorization boundary.

## Required before enabling real trading

1. **Explicit account selection.** Every command must name its trading account. The server must verify ownership, status, mode and trading permission, and choose the execution adapter from the stored account. Never trust a browser mode flag or silently fall back between modes. Current demo submission implicitly selects one account; change that contract before supporting multiple selectable accounts.
2. **Database boundaries.** Enforce order mode against account mode and make account mode immutable. Enforce that events belong to their order's account and ledger entries belong to their transaction's account and asset. The existing wallet scope and balanced-entry checks alone do not enforce all these relationships. Add rejection tests for cross-account and cross-mode writes.
3. **Isolated execution.** Give demo and real workers distinct credentials, permissions, queues and operational controls. A demo worker must not possess real venue credentials or write real balances. The current broad service role is not sufficient isolation for a future live worker. Consider separate databases/projects for the financial data if the required operational isolation warrants it; use shared packages and migrations to avoid maintaining two products.
4. **Independent market data.** Extract the repeated quote-fetching code. Keep market-data ingestion separate from trade execution, with independent consumers. The demo worker must cover all supported open-order symbols, use fresh matching quotes and never execute real orders.
5. **Real execution lifecycle.** Real orders go through a venue adapter. Record fills from authenticated venue responses/events, not the demo pricing calculation. Support partial fills, cancellation races, rejection, timeout recovery, reconciliation and an emergency stop. A timeout means unknown outcome until reconciled; do not retry with a new order ID.
6. **Stable retries.** Use account-scoped idempotency keys, retain the same key across retries, and reject changed payloads under the same key. The database already has account-scoped uniqueness, but the browser generates a fresh key for each attempt and the demo RPC returns an existing order without checking payload equality.
7. **Visible account context.** Display Practice or Real money beside balances and order actions. On switching accounts, clear the order form and replace subscriptions and caches using account ID and mode. Never carry virtual funds into a real account or turn a demo account into a real account.
8. **Verification.** Test shared order-contract behavior against each adapter, then test forbidden cross-mode access, concurrent submissions/cancellations, duplicate events, stale quotes and recovery after worker restarts. Keep live enablement off until these tests and venue reconciliation pass.

## Demo limitations found

The demo fill helper relies on its callers for mode selection and does not itself check mode, account status, snapshot symbol or freshness. It should reject mismatches explicitly before reuse. Its fixed slippage can push limit fills beyond their limit; stop-limit activation is not retained across snapshots. Fill/cancel paths lock orders while submit locks accounts, so account-level serialization and lock ordering need concurrency tests. These behaviors need work before treating the demo as a faithful execution simulator.

This review does not enable live trading, change database functions or deploy migrations. Keep the demo implementation available when real trading is introduced, but do not use its fill calculation to settle real money.
