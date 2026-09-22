# Privilege roles and work architecture

The admin model has support agent, administrator, and owner roles. Capabilities are evaluated server-side by `admin_private.require_staff`; state-changing actions write immutable audit events.

Engine capabilities are `engine.read`, `engine.manage`, `contracts.read`, and Owner-only `contracts.void`. Restriction capabilities are graded by severity: `customers.restrict.notice`, `customers.restrict.limit`, `customers.restrict.block`, and `customers.restrict.block_severe`. The Real-account gate is Owner-only through `platform.enable_real` and requires recent re-authentication.

Customer account actions are always scoped to an explicit account id authenticated to the caller. Practice and future Real accounts share engine code while retaining separate ledgers, exposure, tick streams, and restrictions.
