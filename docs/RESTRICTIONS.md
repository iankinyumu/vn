# Restrictions

Restrictions are typed (`TRADING`, `WITHDRAWAL`, `DEPOSIT`, `ACCESS`), scoped (`ALL`, `DEMO`, `REAL`), and graded (`NOTICE`, `LIMITED`, `BLOCKED`). Expired rows are ignored. Existing legacy restrictions retain their conservative meaning: `TRADING` / `ALL` / `BLOCKED`.

`NOTICE` is recorded and displayed but does not deny an action. `LIMITED` accepts only validated numeric parameters: trading may set `max_stake`, `max_open_contracts`, and `max_daily_net_loss`; deposit and withdrawal may set `max_amount_per_day`. Unknown, empty, zero, negative, or malformed parameters are rejected. Multiple limits resolve to the most restrictive value. `BLOCKED` denies the relevant action.

Customer enforcement is server-side. Trading blocks raise `trading_restricted`; a limited request raises `restricted_limit_exceeded` rather than being clamped. Daily loss is measured from UTC midnight. An ACCESS block raises `access_restricted` for account-scoped engine RPCs, while `get_my_active_restrictions()` remains available so the customer can understand the block.

| Action | Capability | Eligible role |
| --- | --- | --- |
| NOTICE | `customers.restrict.notice` | support agent, administrator, owner |
| LIMITED | `customers.restrict.limit` | administrator, owner |
| BLOCKED TRADING / DEMO | `customers.restrict.block` | administrator, owner |
| BLOCKED ACCESS, DEPOSIT, WITHDRAWAL, REAL, or ALL | `customers.restrict.block_severe` plus fresh authentication | owner |

Every application, supersession, lift, and engine enforcement decision must be auditable. ACCESS bans also require the separate operational follow-up of a Supabase Auth ban and session revocation. The engine does not pretend that a database restriction alone invalidates an already-issued Auth session.

## Lifting and supersession (enforced by `20260920530000_engine_admin_operations.sql`)

One mapping, `admin_private.restriction_capability(type, scope, severity)`, decides the capability for applying, superseding and lifting. `lift_account_restriction` requires the capability the restriction needed when it was applied (with fresh authentication for `block_severe`), plus a 3-500 character reason, so a lower role can never lift what a higher role applied. `apply_account_restriction` supersedes the active restriction of the same type and scope only when the actor also holds the capability that restriction needed, so the actor always holds the higher of the two. Expiry, when given, must be in the future. Every apply and lift writes an `admin_audit_events` row carrying type, scope, severity, parameters and expiry.

The console's Customers tab offers only the severity, type and scope combinations the signed-in role may apply (`LIMITED` is never offered for `ACCESS`, which has no parameters) and shows a lift action only on restrictions that role may lift. The server enforces the same rules regardless of the page.

Support agents hold `customers.restrict.notice` but not `customers.read`, so the Customers tab (which lists and inspects customers) is hidden from them and they have no console path to apply a notice. Whether agents should gain `customers.read`, or reach notices from the support workspace instead, is an open product decision.
