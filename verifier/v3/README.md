# Engine v3 proof verifier

A standalone checker for `smartprofit-proof/v3` packages (ADR 0001, `docs/adr/0001-synthetic-engine-v3.md`). It uses only the Web Crypto API and has no dependencies. It works in Node 19+ and modern browsers. It shares no code with the generator in `engine/v3`.

```
node verifier/v3/cli.mjs proof.json          # summary; exit code 0 only if verified
node verifier/v3/cli.mjs proof.json --json   # full per-tick and per-contract result
```

Version 3 is a **proposal**. No live tick uses it yet, so there is no production package to check today.

## What it checks

- The configuration's `sigma_e12` values follow from each index's annual volatility, and `config_hash` covers them.
- Each epoch commitment matches its fields. Epochs chain day by day from a zero predecessor. A revealed seed matches its committed `seed_hash`.
- Every tick is anchored to its index's genesis state and follows the one before it (`tick_no`, `prev_units`, `prev_tick_hash`). Its hash matches its record, and its schedule and epoch agree with the configuration.
- Every price is recomputed from the revealed seed, and its digit is the final price digit.
- Each contract's result follows from its exit tick's digit.

## Result states

| State | Meaning |
| --- | --- |
| `verified` | Every check above passed. |
| `not_yet_revealable` | The epoch's seed is not revealed yet. Nothing is wrong so far, but the price cannot be recomputed. |
| `missing_history` | The package lacks the genesis tick, an earlier epoch or an exit tick, so the starting state is not anchored. |
| `invalid_config` | The configuration, schedule or package format is wrong. |
| `invalid_commitment` | A commitment, seed hash or revealed seed does not match. |
| `broken_continuity` | A tick is missing, reordered, or does not chain to its predecessor, or a record hash is wrong. |
| `price_mismatch` | A published price differs from the recomputed one. |
| `digit_mismatch` | A published digit is not the final digit of its price. |
| `contract_mismatch` | A contract result does not follow from its exit tick. |

`witness` is always `unwitnessed` in v3.0. A matching seed reveal shows that the published history follows from the committed seed. It does **not** show when the commitment was made, that nobody previewed outcomes, or that no epoch was chosen or suppressed. Those need the independent witness and seed-custody controls planned for Phase 2.
