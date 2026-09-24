# SmartProfit engine specification

Each index is scoped by `(index_code, execution_mode)`. A tick number is fixed by its schedule, and the settlement digit is drawn by rejection sampling HMAC-SHA-256 blocks: `HMAC(seed, "digit|mode|index|tick|counter")`; bytes below 250 map modulo ten. The displayed price is cosmetic and its final decimal digit is constrained to equal the settlement digit. The price walk is deterministic: it evolves log-price as `x + kappa * (ln(base) - x) + sigma * z`, where `z` is Box-Muller output from two 53-bit uniforms taken from `HMAC(seed, "walk|mode|index|tick|0")`. A database trigger rejects any tick whose displayed final digit differs from its settlement digit.

The normative DEMO vectors use seed `000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f` (commitment `630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd`):

- `SPI10`, ticks 1-20: `2 8 3 9 8 6 1 6 7 8 7 7 6 1 9 0 1 8 2 5`
- `SPI100`, ticks 1-20: `1 8 3 6 7 6 8 4 8 3 1 4 1 8 3 4 7 0 3 9`

`npm test` executes these values against Node WebCrypto-compatible HMAC logic and a local PostgreSQL instance with `pgcrypto`; SQL and JavaScript must agree byte-for-byte.

Epochs are UTC-day, per-mode commit-reveal records. A commitment is SHA-256 of a 32-byte seed. The chain is `SHA-256(prev_chain_hash || epoch_id || execution_mode || seed_commitment)` within each mode. Epoch fields are immutable apart from one final reveal. A reveal permits verification that a historical seed produced the published digits; it does not prove an operator did not choose a favorable seed before committing, nor protect future Practice digits from a database superuser. Real seed custody must move outside the database before Real activation.

The proof is therefore tamper evidence, not an external-randomness claim: it proves a revealed seed matches its commitment and reproduces historical digits, but it cannot prove the operator did not select the seed before committing it. Practice seed storage in this database is accepted only because funds are virtual. Before Real activation, the Real mode alone must use custody outside this database; its stream must remain independent from Practice from the first epoch onward.

Contracts settle from their scheduled exit tick. EVEN, ODD, OVER, UNDER, MATCH, and DIFFER use their literal winning sets. Payout is `floor(stake × (1 − margin) × 10 / winning_digits, 2 decimal places)`. The engine reserves stake before opening and posts one balanced, idempotent settlement or refund ledger transaction.

The hosted migration requires `pg_cron` 1.5 or later. It schedules the engine every second, epoch reveal every minute, and retention daily. Tick inserts send a private Broadcast payload through `realtime.send` on `ticks:demo:<index>`. The project must retain Realtime Broadcast authorization; the migration grants authenticated users receive access to the Practice topics only.

## Version 3 (proposed, not active)

`docs/adr/0001-synthetic-engine-v3.md` specifies a candidate version 3: HKDF-separated keys, length-framed canonical encodings, a committed model configuration, a tick hash chain, and SPI-N defined as a target annualised volatility of N %. It is **not** used for any tick or contract. Every live index still generates version 2 ticks, and version 1 and 2 verification is unchanged. The Node reference generator (`engine/v3/generator.mjs`), the WebCrypto verifier (`verifier/v3/verify.mjs`) and the SQL functions in `engine_private` (migration `20260924100000`) all reproduce `engine/v3/vectors.json`. Seed custody, witnessed commitments and cutover are later phases. Until they are complete, nothing in this section changes what the fairness page proves.
