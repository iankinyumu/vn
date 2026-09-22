# Astra engine specification

Each index is scoped by `(index_code, execution_mode)`. A tick number is fixed by its schedule, and the settlement digit is drawn by rejection sampling HMAC-SHA-256 blocks: `HMAC(seed, "digit|mode|index|tick|counter")`; bytes below 250 map modulo ten. The displayed price is cosmetic and its final decimal digit is constrained to equal the settlement digit.

Epochs are UTC-day, per-mode commit-reveal records. A commitment is SHA-256 of a 32-byte seed. The chain commits to the previous mode-local chain hash, mode, and commitment. A reveal permits verification that a historical seed produced the published digits; it does not prove an operator did not choose a favorable seed before committing, nor protect future Practice digits from a database superuser. Real seed custody must move outside the database before Real activation.

Contracts settle from their scheduled exit tick. EVEN, ODD, OVER, UNDER, MATCH, and DIFFER use their literal winning sets. Payout is `floor(stake × (1 − margin) × 10 / winning_digits, 2 decimal places)`. The engine reserves stake before opening and posts one balanced, idempotent settlement or refund ledger transaction.
