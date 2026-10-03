# SmartProfit engine specification

Each index is scoped by `(index_code, execution_mode)`. A tick number is fixed by its schedule. Generation version 1 drew the settlement digit by rejection sampling HMAC-SHA-256 blocks: `HMAC(seed, "digit|mode|index|tick|counter")`; bytes below 250 map modulo ten. The displayed price was cosmetic and its final decimal digit was constrained to equal the settlement digit. Its deterministic log-price walk used `x + kappa * (ln(base) - x) + sigma * z`, where `z` was Box-Muller output from `HMAC(seed, "walk|mode|index|tick|0")`. Version 1 ticks retain this rule and must never be rewritten.

## Unified price generation (version 2)

From migration `20260920560000`, the price is generated first and the settlement digit is `price_units mod 10`, where `price_units` is the price multiplied by `10^decimals`. The previous published price and the exact base, sigma, kappa and decimal settings are stored on each immutable tick. This keeps old proofs valid after a parameter change. Version 2 uses `HMAC(seed, "price-v2|mode|index|tick|counter")`. From block zero, add bytes 0–11 to get `sum`. Starting at byte 12, take the first byte below 250 from bytes 12–30; if none is found, try the next counter block. Let `residue = byte mod 10`, and use the final block's byte 31 for parity. All integer divisions truncate toward zero:

```
sigma_units = round(base_price * sigma_per_tick * 10^decimals)
coarse = trunc((sum - 1530) * sigma_units / 2560)
pull = trunc(kappa * (base_units - previous_units))
jitter = residue - (byte31 even ? 4 : 5)
next_units = previous_units + pull + 10 * coarse + jitter
price = next_units / 10^decimals
digit = next_units mod 10
```

The twelve-byte sum gives bounded, approximately bell-shaped price moves. The last-digit residue is uniform and independent of the coarse move, so every final digit has probability exactly 1/10 conditional on the previous published price. The parity choice centers the jitter at zero. This design preserves the existing digit-contract payout probabilities while making the chart price the settlement source. `sigma_per_tick` is a price-movement setting, **not** an annualized percentage or a claim of equivalence to another platform's index. The SQL price generator and browser verifier must agree on published version 2 ticks. Verification of a tick uses its stored previous price; neighboring ticks are also checked for continuity when available.

The normative DEMO vectors use seed `000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f` (commitment `630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd`):

- `SPI10`, ticks 1-20: `2 8 3 9 8 6 1 6 7 8 7 7 6 1 9 0 1 8 2 5`
- `SPI100`, ticks 1-20: `1 8 3 6 7 6 8 4 8 3 1 4 1 8 3 4 7 0 3 9`

`npm test` executes these values against Node WebCrypto-compatible HMAC logic and a local PostgreSQL instance with `pgcrypto`; SQL and JavaScript must agree byte-for-byte.

Epochs are UTC-day, per-mode commit-reveal records. A commitment is SHA-256 of a 32-byte seed. The chain is `SHA-256(prev_chain_hash || epoch_id || execution_mode || seed_commitment)` within each mode. Epoch fields are immutable apart from one final reveal. A reveal permits verification that a historical seed produced the published digits; it does not prove an operator did not choose a favorable seed before committing, nor protect future Practice digits from a database superuser. Real seed custody must move outside the database before Real activation.

The proof is therefore tamper evidence, not an external-randomness claim: it proves a revealed seed matches its commitment and reproduces historical digits, but it cannot prove the operator did not select the seed before committing it. Practice seed storage in this database is accepted only because funds are virtual. Before Real activation, the Real mode alone must use custody outside this database; its stream must remain independent from Practice from the first epoch onward.

Contracts settle from their scheduled exit tick. EVEN, ODD, OVER, UNDER, MATCH, and DIFFER use their literal winning sets. Payout is `floor(stake × (1 − margin) × 10 / winning_digits, 2 decimal places)`. The engine reserves stake before opening and posts one balanced, idempotent settlement or refund ledger transaction.

The hosted migration requires `pg_cron` 1.5 or later. It schedules the engine every second, epoch reveal every minute, and retention daily. Tick inserts send a private Broadcast payload through `realtime.send` on `ticks:demo:<index>`. The project must retain Realtime Broadcast authorization; the migration grants authenticated users receive access to the Practice topics only.

## Version 3 (built; not yet active on any index)

`docs/adr/0001-synthetic-engine-v3.md` specifies version 3: HKDF-separated keys, length-framed canonical encodings, a committed model configuration, a tick hash chain, and SPI-N defined as a target annualised volatility of N %. `docs/adr/0002-engine-v3-custody-witness-operations.md` (including §10) covers the operational design:

- **Custody.** An external worker holds seeds under KMS envelope custody, and PostgreSQL stores only ciphertext.
- **Signed commitments.** Each epoch commitment is signed with Ed25519.
- **Witnessed commitments.** Each commitment is timestamped by DigiCert and Sectigo (RFC 3161) before its **witness deadline**, the epoch's first scheduled tradable tick, derived from its committed configuration.
- **Attestation.** A separate attestor role verifies every receipt against pinned roots. The tick writer cannot mark anything as witnessed.
- **Checkpoints.** Signed, witnessed checkpoints are published every 150 ticks.
- **Fail-closed purchases.** Purchases fail closed when freshness, heartbeat, witness or checkpoint gates fail.
- **Cutover.** Cutover is Practice-only and happens at a UTC day boundary, after v2 stops at its final tick.

**Status.** No index has `engine_generation = 3`, so every index still generates version 2 ticks, and version 1 and 2 verification is unchanged. Version 3 proofs are checked by `verifier/v3`: the fairness page and `node verifier/v3/cli.mjs` share one verifier and one trust policy. They report a verdict (`fully_verified`, `partial` or `invalid`) with separate price/continuity, signature, witness, checkpoint, reveal and contract results. Operations are in `docs/runbooks/engine-v3.md`; release status and evidence are in `docs/ENGINE_V3_ACCEPTANCE.md`.
