# ADR 0001 — Synthetic index engine, generation version 3

| Field | Value |
| --- | --- |
| Status | **Proposed — not reviewed.** Not approved for live use in any mode. |
| Specification | `v3.1` (frozen by this document and `engine/v3/vectors.json`) |
| Revision | v3.1 (2026-09-28, before any sign-off): anchorless configurations (`kappa_e12 = 0`), resume and rescale (§5.6), per-tick move limit (§5.7). Every v3.0 vector still holds; the byte encodings and the `v3` label are unchanged. |
| Supersedes | Nothing. Versions 1 and 2 remain valid for the ticks they produced. |
| Scope | Practice (`DEMO`) prototype and shadow run. REAL stays disabled; see §10. |
| Plan | `docs/CLAUDE_SYNTHETIC_ENGINE_PLAN.md` |

Any change to a normative step in §4–§6 needs a new specification version (for example `v3.1`) with new vectors. It must not be made by editing this document in place once signed off.

## 1. Context

Version 2 (migration `20260920560000`) generates a price first and settles on its final decimal digit. The Phase 0 audit of that design found:

- **Seed custody.** Active seeds are plaintext in `engine_private.epoch_seeds`, created with `gen_random_bytes` in the same database that serves customers. Any role that can read that table or execute the price function can predict future ticks.
- **Commitment evidence.** An epoch commitment is a row in the same database. Immutability triggers give tamper resistance against application roles, not independent evidence of *when* it was committed. The chain hash concatenates variable-length text without length prefixes (`prev || uuid || mode || commitment`).
- **Parameters are not committed.** `base_price`, `sigma_per_tick` and `kappa` are read from `engine_indices` at generation time and copied onto the tick. An operator could change them after the seed commitment, and the verifier would accept the new values.
- **Verifier anchoring.** The browser verifier trusts the `previous_price` stored on each tick unless the neighbouring tick is also in the fetched range. There is no independently anchored starting state.
- **Volatility is undefined.** `sigma_per_tick` is a per-tick movement setting. SPI10…SPI100 names do not correspond to any measured quantity.
- **Encodings.** HMAC messages are `|`-joined decimal text. They are unambiguous for today's inputs but have no length framing or domain label beyond a prefix, and there is no key separation between price movement and digit residue.
- **Strength kept.** Version 2's structure `next = prev + pull + 10·coarse + jitter` already makes the final digit exactly uniform, whatever the coarse move is. Version 3 keeps this idea and puts it on a frozen, byte-exact footing.

## 2. Decision summary

1. **SPI-N means a target annualised volatility of N % of log returns.** Annualisation uses a 24/7 calendar (§3).
2. **Model.** Log-return random walk with no anchor (v3.1; v3.0 had weak mean reversion with a 30-day half-life). Bounded symmetric innovations. All normative arithmetic uses exact integers. A price that drifts far from the reference is rescaled by exactly ×10 or ÷10 at an announced UTC midnight (§5.6).
3. **Digit.** The digit is `price_units mod 10` of the published price. It is exactly uniform, conditional on all prior state, by construction (§6). The `winning_digits / 10` payout basis remains valid.
4. **Keys.** HKDF-SHA-256 separates keys by environment, mode, version, index, epoch and purpose. Tick randomness comes from an HMAC-SHA-256 counter PRF.
5. **Commitments.** Length-framed canonical records hash the seed, the full model configuration and the previous commitment. Signing and independent witnessing are specified as required fields; their providers are Phase 2 decisions (§9).
6. **Independent implementations.** The generator uses `node:crypto` (`hkdfSync`, `createHmac`). The verifier uses WebCrypto only and implements HKDF itself. Neither imports the other. A later SQL implementation must match the same vectors.

## 3. Product definition

| Item | Value |
| --- | --- |
| Indices | SPI10, SPI25, SPI50, SPI75, SPI100 (family `continuous-volatility`) |
| Target volatility | 10 %, 25 %, 50 %, 75 %, 100 % annualised; `annual_vol_bp` = 1000, 2500, 5000, 7500, 10000 |
| Cadence | one tick every 2000 ms, 24 hours a day, 7 days a week, including weekends and holidays |
| Ticks per year | `TPY = 365 × 86400 × 1000 / 2000 = 15 768 000` |
| Precision | 3 decimals; `price_units = price × 1000` |
| Reference / start price | 10000.000 (`anchor_units = 10 000 000`). With `kappa_e12 = 0` it does not affect the transition; it defines the soft range. |
| Soft range | A tenth to ten times the reference, 1000.000 to 100000.000. Outside it a rescale is due (§5.6). |
| Hard band | `min_units = 500 000` (500.000), `max_units = 200 000 000` (200000.000) |
| Per-tick move limit | `max_move_units(P)` (§5.7): about 6 σ of the price, for example 15.115 at 10000.000 for SPI100 |
| Contracts | EVEN, ODD, OVER b (0–8), UNDER b (1–9), MATCH b, DIFFER b, settled on the final price digit |
| Resets | None. The price never resets daily. A series starts at an announced cutover genesis (§5.5) and restarts only at an announced resume (§5.6). |
| Regime changes | None inside v3.0. Any parameter change is a new configuration hash, committed before its first epoch and announced. It must never respond to customer positions or P/L. |

**Volatility definition.** Realised volatility over a window of `n` consecutive tick returns `r_t = ln(P_t / P_{t-1})` is `sd(r) × √TPY`, where `sd` is the sample standard deviation. The per-tick target is `σ = annual_vol / √TPY`, frozen as an integer:

```
sigma_e12 = isqrt( floor( annual_vol_bp² × 10^16 / TPY ) )
```

| Index | `annual_vol_bp` | `sigma_e12` | σ per tick | σ in units at 10000.000 |
| --- | --- | --- | --- | --- |
| SPI10 | 1000 | 25 183 245 | 2.518e-5 | 251.8 |
| SPI25 | 2500 | 62 958 113 | 6.296e-5 | 629.6 |
| SPI50 | 5000 | 125 916 226 | 1.259e-4 | 1259.2 |
| SPI75 | 7500 | 188 874 339 | 1.889e-4 | 1888.7 |
| SPI100 | 10000 | 251 832 452 | 2.518e-4 | 2518.3 |

The start price and precision are chosen so that the lowest tier moves about 250 units per tick. Quantisation noise (≈ 16.8 units², §6.3) then adds less than 0.02 % to realised volatility. The number in an index name may be shown as a percentage **only** next to the measured value for a stated window (Workstream C.5).

**Drift (v3.1).** Configurations set `kappa_e12 = 0`: there is no pull toward the reference. The price is a martingale (the expected next price is the current price), so the log price carries the usual `−σ²/2` convexity term and the median price falls over time: after one year to about 100 %, 97 %, 88 %, 75 % and 61 % of its start for SPI10 to SPI100. This is disclosed rather than corrected. Probabilities of leaving the soft range, or of reaching the hard band if no rescale were made, starting from the reference price (exact first-passage probabilities of a Brownian motion with that drift):

| Index | Soft range, 1 year | Soft range, 5 years | Hard band, 1 year | Hard band, 5 years |
| --- | --- | --- | --- | --- |
| SPI10 | < 0.01 % | < 0.01 % | < 0.01 % | < 0.01 % |
| SPI25 | < 0.01 % | 0.01 % | < 0.01 % | < 0.01 % |
| SPI50 | < 0.01 % | 12 % | < 0.01 % | 3 % |
| SPI75 | 0.7 % | 47 % | 0.03 % | 27 % |
| SPI100 | 6.7 % | 76 % | 1.2 % | 58 % |

Almost all exits are downward. §5.6 turns them into announced ×10 rescales before the band is reached.

**v3.0 stationarity (historical).** v3.0 used `kappa_e12 = 534 835`, i.e. `κ = floor(ln 2 × 10^12 / 1 296 000) / 10^12`, a half-life of 30 days of ticks and a stationary log-price standard deviation of about `σ / √(2κ)`. The field stays in the encoding, and the v3.0 vectors use that value.

## 4. Canonical encodings

All multi-byte integers are unsigned big-endian: `u8`, `u32`, `u64`. `str(s)` is `u16(len(s)) ‖ ASCII(s)`. `s` must match `^[A-Za-z0-9._-]{1,64}$`; anything else is rejected, never normalised. `h32` is 32 raw bytes. `‖` is concatenation. No step uses floating point, locale formatting, JSON or text numbers.

| Name | Allowed values |
| --- | --- |
| `env` | `production`, `staging`, `test` |
| `mode` | `DEMO`, `REAL` |
| `index` | `SPI10`, `SPI25`, `SPI50`, `SPI75`, `SPI100` |
| `ENGINE`, `VERSION` | `smartprofit-engine`, `v3` |
| `HEADER(kind)` | `str(ENGINE) ‖ str(VERSION) ‖ str(kind)` |

Epochs are UTC days: `epoch_start_ms = floor(scheduled_ms / 86 400 000) × 86 400 000` and `epoch_end_ms = epoch_start_ms + 86 400 000`. A tick is scheduled at `scheduled_ms = t0_ms + tick_no × tick_interval_ms`.

### 4.1 Seed and keys

The seed is 32 bytes from an OS CSPRNG or a KMS/HSM random-data call (§8).

```
seed_hash = SHA-256( HEADER("seed-hash") ‖ seed )
PRK       = HKDF-Extract( salt = ASCII("smartprofit-engine/v3/hkdf"), IKM = seed )
K[p]      = HKDF-Expand( PRK, info = HEADER("key") ‖ str(p) ‖ str(env) ‖ str(mode)
                                    ‖ str(index) ‖ u64(epoch_start_ms), L = 32 )
```

Purposes `p` are `price-move` and `price-digit`. Test streams are separated by `env = test`. They are never separated by reusing a Practice or production seed.

### 4.2 Tick PRF

```
msg(tick_no, counter) = str("tick") ‖ u64(tick_no) ‖ u32(counter)
B_move       = HMAC-SHA-256( K[price-move],  msg(tick_no, 0) )
B_digit[c]   = HMAC-SHA-256( K[price-digit], msg(tick_no, c) ),  c = 0, 1, 2, …
```

### 4.3 Model configuration hash

A configuration covers every index of one `(env, mode)`. Entries are sorted by `index` byte order.

```
entry(i)    = str(index) ‖ u32(annual_vol_bp) ‖ u32(tick_interval_ms) ‖ u8(decimals)
              ‖ u64(anchor_units) ‖ u64(sigma_e12) ‖ u64(kappa_e12)
              ‖ u64(min_units) ‖ u64(max_units) ‖ u64(t0_ms)
              ‖ u64(genesis_tick_no) ‖ u64(genesis_units)
config_hash = SHA-256( HEADER("model-config") ‖ str(env) ‖ str(mode) ‖ u32(count) ‖ entry… )
```

`sigma_e12` must equal the §3 formula for `annual_vol_bp` and `tick_interval_ms`. A verifier recomputes it and rejects a mismatch.

### 4.4 Epoch commitment

```
commitment = SHA-256( HEADER("epoch-commitment") ‖ str(env) ‖ str(mode)
                      ‖ u64(epoch_start_ms) ‖ u64(epoch_end_ms)
                      ‖ seed_hash ‖ config_hash ‖ prev_commitment )
```

`prev_commitment` is the previous epoch's commitment in the same `(env, mode)`. For the first v3 epoch it is 32 zero bytes. Epochs must be contiguous: a verifier treats a gap as broken continuity.

### 4.5 Tick transcript

```
genesis_hash = SHA-256( HEADER("genesis") ‖ str(env) ‖ str(mode) ‖ str(index)
                        ‖ u64(genesis_tick_no) ‖ u64(genesis_units) ‖ config_hash )
tick_hash    = SHA-256( HEADER("tick") ‖ str(env) ‖ str(mode) ‖ str(index)
                        ‖ u64(tick_no) ‖ u64(scheduled_ms) ‖ u64(generated_ms)
                        ‖ u64(epoch_start_ms) ‖ u64(prev_units) ‖ u64(price_units)
                        ‖ u8(decimals) ‖ u8(digit) ‖ config_hash ‖ commitment
                        ‖ prev_tick_hash )
```

The first v3 tick is `genesis_tick_no + 1`. Its `prev_units = genesis_units` and its `prev_tick_hash = genesis_hash`. `generated_ms` is operator-asserted wall-clock evidence and does not affect the price.

## 5. Price model

### 5.1 Innovation

Read twelve 16-bit words from `B_move` bytes 0–23, `w_i = u16(B_move[2i..2i+1])`. Then:

```
Z      = Σ_{i=0..11} (2·w_i − 65535)          (integer, symmetric, |Z| ≤ 786 420)
parity = B_move[24] & 1
```

`Z` is an Irwin–Hall(12) variable with standard deviation `2·√(2^32 − 1) ≈ 2^17`; the relative error of using `2^17` is 1.2e-10. It is bounded at ±5.9997 sd, with excess kurtosis −0.1. There are no rare-event jumps in this family. Bytes 25–31 are reserved and ignored.

### 5.2 Digit residue

For `c = 0, 1, …`, scan `B_digit[c]` bytes 0–31 in order. The first byte `b < 250` gives `residue = b mod 10`. If `c` would exceed `2^32 − 1`, generation fails. That is unreachable, but it is specified.

### 5.3 Transition

With `P = prev_units`, `A = anchor_units`, `S = 2^17` and `E = 10^12`:

```
num   = P × sigma_e12 × Z + kappa_e12 × (A − P) × S
den   = E × S
C     = floor( (num + 5·den) / (10·den) )          # nearest integer to move/10, ties up
next  = P + 10·C + residue − 4 − parity
digit = next mod 10
```

`floor` is mathematical floor, also for negative numerators. Implementations use arbitrary-precision integers: `num` can exceed 2^64. BigInt in JavaScript, `numeric` in PostgreSQL.

### 5.4 Band handling

If `next < min_units` or `next > max_units`, no tick is produced. The index enters `HALTED_BAND` and new purchases fail closed. Contracts whose exit tick cannot be produced are refunded through the audited refund path. Resuming needs a new configuration (a new `config_hash`) committed before its first epoch, under §5.6. The generator never rerolls, clamps or reflects.

### 5.5 Genesis and cutover

Each index's v3 series starts at an announced `(genesis_tick_no, genesis_units)` in the committed configuration. The v3 tick-number space continues the existing `(index, mode)` numbering: `genesis_tick_no` is the last v2 tick. Version 2 ticks are neither re-read nor rewritten. The genesis price is announced, not derived. For this prototype it is the anchor (10000.000).

### 5.6 Resume and rescale (v3.1)

An index that is halted (§5.4, §5.7 or an operational fault), or paused for a rescale, restarts only through a new configuration for a whole epoch `E`, committed and witnessed like any other. In that configuration the index's entry has:

- `genesis_tick_no = G`, the last tick scheduled before `epoch_start_ms(E)`;
- `genesis_units = scale(units_H, k)`, where `H` is the index's last produced tick, `k ∈ {−1, 0, 1}`, and `scale(u, 1) = 10·u`, `scale(u, 0) = u`, `scale(u, −1) = floor(u / 10)`.

Ticks `H + 1 … G` are never produced (an announced pause). The first tick of the new series is `G + 1`, with `prev_units = genesis_units` and `prev_tick_hash = genesis_hash` (§4.5). Nothing in §4 or §5.1–§5.3 changes. The digit proof (§6) holds unchanged, because it does not depend on `P`.

**Verifier rule.** After a verified tick `H`, a tick `G + 1` whose configuration has `genesis_tick_no = G ≥ H` is accepted as a resume when `genesis_units` equals `scale(units_H, k)` for some `k ∈ {−1, 0, 1}` and the tick chains to that genesis. Any other resume price is a `price_mismatch`. The verifier lists the resumes it accepted.

**Operation (not normative for verification).**

- A running index can be rescaled only while its last price is outside the soft range. The direction is computed, never chosen: `k = 1` below a tenth of the reference, `k = −1` above ten times it. A halted index may also resume unchanged (`k = 0`).
- A rescale is scheduled at least one day ahead, for an epoch not yet committed, by staff with a fresh TOTP (`engine_v3_schedule_rescale`) or by the database owner (`engine_private.operator_schedule_rescale`). It is published for customers (`get_engine_v3_rescales`).
- The index pauses `rescale_pause_lead_ms` (default 75 minutes) before the epoch, so its last price is known when the configuration is committed at least `min_commit_lead_ms` (one hour) ahead. Purchases whose ticks would fall in the pause are refused (`engine_v3_rescale_pause`).
- The database refuses a configuration that changes a running index's genesis without a scheduled resume, or that does not match one exactly. If the worker cannot commit a scheduled resume in time, it records it as missed and commits the epoch unchanged, so no other index is affected.

### 5.7 Move limit (v3.1)

```
max_move_units(P) = 10 · floor( (P · sigma_e12 · 786 420 + kappa_e12 · |A − P| · S + 5·E·S) / (10·E·S) ) + 5
```

This is the largest `|next − P|` the §5.3 transition can produce (`|Z| ≤ 786 420`, jitter within ±5), and it is reached exactly at the extreme innovation. The database refuses any tick with `|price_units − prev_units| > max_move_units(prev_units)` (`engine_v3_move_out_of_bound`). The generator asserts the same, and the worker then halts the index with refunds. Honest generation can never trigger it: it exists to stop a fault or a forged tick from reaching customers.

## 6. Digit model proof

**Claim.** For every prior state (`P`, `C`, `parity`, all earlier ticks) and every permitted configuration, `Pr[digit = d] = 1/10` for each `d ∈ 0…9`, assuming HMAC-SHA-256 under a secret key behaves as a PRF.

1. `digit = (P + 10C + residue − 4 − parity) mod 10 = (residue + k) mod 10`, where `k = (P − 4 − parity) mod 10` does not depend on `residue`.
2. For fixed `k`, `residue ↦ (residue + k) mod 10` is a bijection on {0,…,9}.
3. `residue` comes from `K[price-digit]`, a key independent of `K[price-move]`, which alone determines `C` and `parity`. `P` is a function of earlier ticks' PRF outputs on different messages. Under the PRF assumption, `residue` is independent of `k`.
4. `residue` is exactly uniform: a uniform byte conditioned on `b < 250` is uniform on {0,…,249}, and 250 = 25 × 10.

The empirical digit tests in §7 are implementation diagnostics only. The proof does not depend on the distribution of `C`. The unit test `digit bijection` enumerates all 10 × 2 × 10 cases of step 2.

**Band caveat.** A tick that would breach the band is not produced (§5.4). The halt condition depends on `residue` only within ±5 units of a boundary 12 sd away. The operator cannot choose it, and the affected contracts are refunded rather than settled.

### 6.3 Quantisation variance

`10·C − move` is a rounding error of about U(−5, 5) (variance ≈ 8.33 units², dithered by `Z`). `residue − 4 − parity` is uniform on {−5,…,5} with mean 0 and variance 8.5. The added variance is ≈ 16.8 units², against a smallest σ² ≈ 63 400 units². The model is not rescaled to compensate. Acceptance bands (§7) include this term.

## 7. Quantitative acceptance (pre-registered)

The calibration script is `scripts/engine-v3-calibrate.mjs`. It runs the generator on held-out seeds derived from a published label (`calibration-<n>`), never from production seeds. Thresholds are fixed here, before results are seen.

For each index and seed, over a run of `n` ticks with standardised innovations `e_t = (next − P − κ(A − P)) / (Pσ)`:

| Metric | Pass condition |
| --- | --- |
| Realised annualised volatility | `|realised / target − 1| < 1 %` for `n ≥ 1 000 000`; < 3 % for each 43 200-tick (one-day) window |
| Innovation mean (drift) | `|mean(e)| × √n < 5` |
| Innovation lag-1 autocorrelation | `|ρ₁(e)| × √n < 5` |
| Excess kurtosis of `e` | within `−0.1 ± 0.05` |
| Maximum `|e|` | ≤ 6.0 (structural bound) |
| Digit counts | χ²(9) < 33.72 (p = 10⁻⁴) |
| Digit lag-1 pairs | χ²(81) (independence) < 137.2 (p ≈ 10⁻⁴, Wilson–Hilferty) |
| Digit repeat runs | longest run < 12 per 10⁶ ticks |
| Price range | Never outside the band. Anchorless (v3.1): max \|ln(P / reference)\| within 5 · σ√n over the run, with soft-range exits reported. v3.0: log deviation from the anchor within ±8 stationary sd |
| Exposure link | not applicable to the prototype: the generator takes no position input (structural) |

Multi-year stationarity: at least one run of 15 768 000 ticks (one year) per index must meet the range criterion. The pre-registered thresholds use p ≈ 10⁻⁴ per test to keep the family-wise false-alarm rate low across 5 indices × seeds. Every failing sample is kept in the report.

## 8. Threat model and trust boundary

| Threat | v3.0 prototype (Practice) | Required before REAL |
| --- | --- | --- |
| Dishonest staff read a future seed | **Not prevented.** Seeds stay in the engine database for Practice, as today. | Seeds held by an isolated engine service with KMS/HSM envelope encryption. No DB plaintext. Decrypt/derive calls are logged and separated from trading ops. |
| Compromised DB/app role predicts ticks | Price functions are revoked from `public/anon/authenticated`. A superuser can still predict. | Derivation only inside the engine service, only for due ticks (monotonic schedule). |
| Seed grinding before commitment | Not prevented. Commitment occurs ≥ 24 h ahead, before any position on that epoch exists, so grinding cannot target specific positions. It could target aggregate statistics. | Optional public beacon mixed after commitment (§9). Otherwise disclose. |
| Post-commitment parameter change | **Prevented and detectable:** `config_hash` is inside the commitment and every tick hash. | Same |
| Operator-chosen restart price | **Prevented and detectable (v3.1):** a resume price must be the last price × 10, × 1 or ÷ 10 (§5.6). The database refuses anything else and the verifier reports it. | Same |
| Forged extreme tick | **Prevented (v3.1):** the database refuses any tick beyond the §5.7 move limit. | Same |
| Forged or backdated ticks | Detectable against the revealed seed (price mismatch). Backdating the *commitment* is **not** detectable without a witness. | Signed commitments plus an external timestamp/witness receipt before the first tradable tick. Otherwise purchases fail closed. |
| Tick deletion / replay | Hash chain with `prev_tick_hash` and a monotonic `tick_no` makes gaps and reordering detectable inside a fetched range. | Signed periodic checkpoints exported to a witness store |
| Selective outage (suppress an unfavourable tick) | The tick schedule is fixed. A missing tick is catch-up generated from the same committed state; there is no reroll. Contracts keep their fixed exit tick. | Lag, backlog and clock-drift thresholds with fail-closed purchasing (Workstream D) |
| Double settlement | Existing idempotent ledger and contract state machine (unchanged) | Reconciliation drills |
| Prediction via API | No RPC returns an unrevealed seed or future tick. Reveal only after the epoch ends and dependent contracts are final. | Permissions tests on the engine service |
| Collusion of KMS admin and trading ops | Out of scope | Role separation and a multi-operator incident procedure |

**What a v3 verifier proves** from a proof package: the revealed seed matches `seed_hash` inside the commitment; the commitment chain is contiguous; the configuration matches `config_hash` and the §3 formulas; every price and digit follows from the seed, configuration and anchored genesis; the tick hash chain is unbroken; and each contract's result follows from its fixed exit tick's digit.

**What it does not prove without Phase 2 controls:** when the commitment was first published, that nobody previewed outcomes, or that no epoch was selected or suppressed. The verifier reports `unwitnessed` until a witness receipt and signing key can be checked.

## 9. Phase 2 decisions (they do not change §4–§6 bytes)

**Decided in ADR 0002** (`docs/adr/0002-engine-v3-custody-witness-operations.md`): an external worker with KMS envelope custody, Ed25519 signing, and RFC 3161 witnessing by two TSAs (DigiCert and Sectigo). No beacon in v3.0. The options considered are kept below for the record.


- **Custody provider:** KMS/HSM and the service runtime. `crypto.randomBytes(32)` is acceptable in a Node service backed by the platform CSPRNG; the deployed runtime must be confirmed.
- **Signing:** Ed25519 over the `commitment` and checkpoint hashes, with a published key set and rotation record. Signature bytes are carried beside the record and are not hashed into it.
- **Witness:** an append-only store under a separate administrative boundary, plus an independently checkable timestamp (for example an RFC 3161 TSA or a public transparency log). The receipt must predate the epoch's first tradable tick.
- **Beacon:** not adopted in v3.0. Adopting one (for example a threshold-signed public beacon round fixed by time after the commitment) changes `IKM` derivation and therefore requires `v3.1` with new vectors, missing-round rules and published proofs.

## 10. Migration and rollback

1. **Phase 1 (this change).** Reference generator, independent verifier, vectors, calibration harness. No database or customer path changes.
2. **Phase 1b.** Forward-only migration: `generation_version` accepts 3; add v3 columns (`config_hash`, `commitment`, `tick_hash`, `prev_tick_hash`, `generated_ms`); add SQL v3 functions matched to the vectors under real PostgreSQL + pgcrypto; add a per-index `engine_generation` flag that defaults to `2`. Old rows are untouched.
3. **Phase 2.** Custody, signing, witness, shadow run (v3 ticks stored separately and never settled).
4. **Phase 3.** Per-index announced cutover tick. All v2 contracts settle on v2 ticks first.
5. **Phase 1c (v3.1).** Migration `20260928100000`: move limit on publication, resumes and rescales (§5.6, §5.7). Worker parameters set `kappa_e12 = 0`. No index runs on v3 when it is applied.
6. **Rollback.** Before cutover: drop the shadow feed; v2 is unaffected. After cutover, v3 ticks stay immutable. Rolling back means a *new* announced cutover to a new version or configuration, with no rewriting and no re-settlement.

## 11. Sign-off

| Role | Name | Date | Decision |
| --- | --- | --- | --- |
| Engineering owner | | | |
| Cryptography reviewer | | | |
| Quantitative reviewer | | | |
| Product / legal | | | |

This ADR makes no claim that the system is audited, certified, FIPS-validated, independently witnessed or equivalent to any other platform's indices.
