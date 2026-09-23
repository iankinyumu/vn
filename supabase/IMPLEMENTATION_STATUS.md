# Digit-index implementation status

Active work is on `feat/digit-indices`. The crypto spot module is retained only under `modules/crypto-spot` and disabled database/function locations for historical reference; it has no active scheduler or customer execution path.

Implemented database foundations include typed DEMO/REAL account boundaries, immutable account modes and ledger checks, DEMO indices, HMAC-derived digits, deterministic price walk, commit/reveal epochs, append-only ticks, contracts, double-entry settlement, exposure buckets, restrictions, policy versions, health metrics, cron scheduling, private Broadcast, customer RPCs, and staff RPCs.

The codebase is local-first for this work: do not use `.env.local`, do not run remote migration commands from an agent, and do not add provider or funding secrets. `npm test` includes parity checks, PGlite migration coverage, and a local PostgreSQL pgcrypto conformance harness.

REAL is structural readiness only. It has no account-creation, funding, withdrawal, KYC, payment, currency-conversion, or cashier implementation.
