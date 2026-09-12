# Phase 1 — Codebase Assessment Report

## Executive Summary

This repository is a static HTML/CSS/JavaScript frontend prototype, not a trading system. It has no backend, database, server-side authorization, durable ledger, order store, or transaction boundary.

A paper-trading engine cannot be safely added as browser-only logic if it is intended to be industry-standard. The current UI can become its client, but the execution engine, balances, orders, and mode controls must be introduced server-side.

---

## 1. Architectural Readiness Audit

| Area | Current State | Assessment |
| :--- | :--- | :--- |
| **Users / Authentication** | A `smartprofit_user` session object is stored in browser `localStorage`. | Not secure or authoritative; anyone can modify it. |
| **Wallets / Balances** | Hard-coded values in the Trade page. | No wallet or balance model exists. |
| **Orders / Trades / Positions** | `placeOrder()` validates a quantity then displays an alert. | No order persistence, matching, fills, fees, or positions. |
| **Database** | No database package, schema, migration, ORM, or server code exists. | Not present. |
| **Transactions / Async State** | Browser DOM mutation and alerts only. | No atomic balance reservation, ledger posting, idempotency, or concurrency handling. |
| **Frontend Stack** | Static multipage app with vanilla JavaScript and Bootstrap. | Suitable as a UI client after API integration. |

### Evidence Reference
* `auth.js` treats `localStorage` as the authentication source.
* `trade.js` (line 656) implements an “order” as a browser alert.
* `trade.html` (line 74) displays fixed balances and fixed open orders.
* No server, database, TypeScript configuration, package manifest, migrations, or schema files are present.

---

## 2. Market-Data Feed Assessment

Market data is currently decoupled from execution because execution does not exist.

### Existing Ingestion
* **Historical candles:** Binance REST API, with a Binance mirror fallback.
* **Live chart / ticker:** Binance public WebSocket streams.
* **Dashboard market list:** Binance 24-hour ticker REST endpoint plus `!miniTicker@arr` WebSocket.
* **Order book and recent trades:** Locally generated random values—not real Binance depth or trade data.

### Relevant Files
* `assets/js/trade.js`
* `assets/js/market-overview.js`
* `assets/js/index.js`

### Key Gaps
1. Browser-to-Binance connections are not reliable enough for an execution service.
2. The engine needs a server-side normalized market-data service with timestamped snapshots.
3. Randomized order-book/trade data must never be used for simulated fills.
4. There is no market-data sequence handling, stale-data policy, symbol normalization, or audit storage.

---

## 3. Execution Mode and Isolation Plan

Introduce an immutable per-account execution context:

$$	ext{ExecutionMode} \in \{	ext{DEMO}, 	ext{REAL}\}$$

The client may request a mode, but the server must derive and enforce the effective mode from authenticated account/session claims and environment policy.

### Recommended Control Model

| Control | DEMO Mode | REAL Mode |
| :--- | :--- | :--- |
| **Account can place simulated orders** | Enabled | N/A |
| **Virtual ledger selected** | Yes | No |
| **Broker adapter available** | No | Feature-gated |
| **Outbound broker credentials usable** | Never | Disabled globally initially |
| **Real order submission** | Never | Rejected by server |
| **UI / Order data contract** | Same contract | Same contract |

### Multi-Layer REAL Isolation
* `REAL_TRADING_ENABLED=false` environment flag.
* No production broker credentials in the deployment environment.
* A `DisabledRealExecutionEngine` that unconditionally rejects execution requests.
* Server-side authorization requiring explicit allow-listing before any future enablement.
* Audit log events generated for every rejected real-mode request.

---

## 4. Required Target Architecture & Recommended Initial Implementation Stack

```text
Browser UI
  └── Trading API / Authenticated Session
        └── OrderService
              ├── ExecutionEngineFactory(mode)
              │     ├── DemoExecutionEngine
              │     └── DisabledRealExecutionEngine
              ├── MarketDataService
              ├── LedgerService
              ├── Order / Trade / Position Repositories
              └── WebSocket Event Publisher
```

### Recommended Initial Implementation Stack
* **Backend Framework & Language:** TypeScript with Node.js (NestJS or Express) for strong type safety and modular architecture.
* **Primary Database:** PostgreSQL with double-entry relational schemas for durable, transactional ledger records.
* **Caching & Message Broker:** Redis for real-time market depth snapshots, rate limiting, and pub/sub order event distribution.
* **Real-time Event Server:** Server-side WebSocket or SSE (Server-Sent Events) to push order state updates and ledger adjustments to clients.
* **Worker & Job Processing:** BullMQ / Redis background workers for asynchronous limit/stop-limit order evaluation and reconciliation loops.

---

## 5. Required Data Model

At minimum, introduce these durable entities:

| Entity | Required Fields & Purpose |
| :--- | :--- |
| `users` | `id`, identity fields, password hashes, lifecycle status |
| `trading_accounts` | `id`, `user_id`, immutable `execution_mode` (`DEMO`/`REAL`), base currency, status |
| `wallets` | `id`, `trading_account_id`, `asset`, `ledger_scope` |
| `ledger_accounts` | `available`, `reserved`, `fee`, `realized_pnl` accounts per asset |
| `ledger_entries` | double-entry postings, correlation ID, immutable timestamps, debit/credit values |
| `orders` | client order ID, mode, symbol, side (`BUY`/`SELL`), type (`MARKET`/`LIMIT`/`STOP_LIMIT`), state, quantity, price, stop price, reserved balance amount |
| `fills` | execution price, quantity, fee, fee asset, liquidity source, market snapshot reference, execution timestamp |
| `positions` | account ID, symbol, quantity, average entry price, margin type, realized/unrealized P&L |
| `market_snapshots` | source, symbol, bid/ask prices, depth array, received timestamp, sequence ID |
| `execution_events` | append-only lifecycle / audit trail tracking every transition and rule validation |

> **Critical Isolation Rule:** Virtual assets must be separated by account and ledger scope—not merely a `demo_balance` column. Demo and real balances must never share wallet rows or ledger entries.

---

## 6. Order State Machine

The minimum robust order state machine is structured as follows:

```text
               [ PENDING_VALIDATION ]
                         │
                         ▼
                    [ ACCEPTED ]
                         │
                         ▼
                      [ OPEN ] ───► [ CANCEL_PENDING ] ───► [ CANCELLED ]
                         │
                         ▼
               [ PARTIALLY_FILLED ]
                         │
                         ▼
                     [ FILLED ]

(Any pre-execution state can transition to REJECTED or EXPIRED)
```

### State Transitions & Rules
1. **`PENDING_VALIDATION`:** Order payload received; system checks account authentication, asset availability, minimum notional size, and tick/lot precision.
2. **`ACCEPTED`:** Order passed validation and balance reservation is locked in the virtual double-entry ledger.
3. **`OPEN`:** Order active in the matching queue (for `LIMIT` / `STOP_LIMIT` types).
4. **`PARTIALLY_FILLED`:** Market snapshot crossed order price for a fraction of the requested quantity.
5. **`FILLED`:** Full order quantity executed; balance reservations committed to final wallet balance.
6. **`CANCEL_PENDING` / `CANCELLED`:** User requested cancellation prior to complete fill; unexecuted locked balance is unlocked.
7. **`REJECTED` / `EXPIRED`:** Order failed validation, exceeded slippage limits, or timed out.

Every state change needs an immutable event record, timestamp, actor/source identifier, reason code, and idempotency key.

---

## 7. Paper-Execution Requirements Currently Missing

1. **Authoritative Account Identity:** Server-managed JWT or session management decoupled from client storage.
2. **Virtual Double-Entry Ledger:** Ledger isolating available vs. reserved funds for pending limit orders.
3. **Atomic Transaction Boundaries:** ACID database transactions for balance reservation and execution posting.
4. **Order Persistence & Idempotency:** Database backed store with `client_order_id` deduplication.
5. **Real Market Depth Snapshots:** Ingestion of real depth/orderbook snapshots instead of client-generated random noise.
6. **Deterministic Market-Fill Logic:** Engine verifying order fill eligibility against actual bid/ask prices.
7. **Limit and Stop-Limit Trigger Processing:** Asynchronous engine continually evaluating active orders against tick streams.
8. **Partial Fills & Cancellation Race Resolution:** Concurrency handling when a user cancels an order during execution.
9. **Fee Schedules & Fee Asset Selection:** Realistic maker/taker fee deductions from base/quote currencies.
10. **Slippage, Spread, & Latency Simulation:** Mathematical models simulating market impact and execution delay.
11. **Precision, Notional, & Size Validation:** Validation against minimum order sizes, price step sizes (tick size), and base quantity steps (lot size).
12. **Position & P&L Calculations:** Real-time tracking of open position average entry prices and unrealized P&L.
13. **WebSocket Account Updates:** Real-time push updates for execution events and balance updates.
14. **Reconciliation & Audit Logging:** Immutable audit logs to track and reconcile execution states against market snapshots.
15. **Rate Limiting & Anti-Abuse Controls:** Protection against order spamming and denial-of-service attempts.
16. **Test Fixtures & Failure Recovery:** Integration tests for balance recovery, server reboot recovery, and price gap handling.

---

## 8. Material Risks in the Current Frontend

1. **Session Spoofing & Identity Forgery:** User sessions stored in browser `localStorage` can be freely forged or altered via developer tools.
2. **Non-Durable & Volatile Data:** Balances, open orders, and trade history exist only in memory or static HTML and disappear on page refresh.
3. **Synthetic / Fake Market Depth:** Order book depth and recent trades are generated using random client-side Math.random() scripts, skewing simulated execution.
4. **Data Fallback Fallacies:** Charting logic synthesizes fake candle data if external API calls fail, presenting false market conditions.
5. **Misleading Execution Feedback:** The UI presents order execution via JavaScript `alert()` messages, misrepresenting a transaction complete when zero server recording occurred.
6. **Lack of Concurrency & Race Condition Protection:** Simultaneous order submissions or multi-tab usage leads to invalid state and unvalidated execution.
7. **Zero Security & Price Manipulation Exposure:** Client-side JavaScript handles price and quantity values, making the UI vulnerable to client-side DOM/variable injection.
8. **No Compliance or Audit Capability:** Complete absence of logs, order IDs, timestamp verification, or execution provenance required for financial auditability.

---

## Readiness Verdict

**Status:** Not implementation-ready as-is for a safe, industry-standard paper trading engine.

**Recommendation:** The visual frontend is reusable, and market-data presentation can be retained, but Phase 2 requires introducing a backend, durable ledger, authenticated API, and server-side execution boundary before connecting the trade form.

*Note: No implementation code was changed in this assessment phase.*
