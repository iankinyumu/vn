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
