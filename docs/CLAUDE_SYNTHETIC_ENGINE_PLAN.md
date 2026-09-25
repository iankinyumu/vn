# Claude implementation plan: production-grade synthetic index engine

## Mission and boundaries

Build SmartProfit's own continuous synthetic-index engine with documented volatility, a cryptographically secure randomness pipeline, one authoritative tick stream, auditable digit-contract settlement, and an independent historical verifier. Deriv publicly describes synthetic indices as continuously generated with a cryptographically secure random number generator and defined volatility. Its exact price formula, operational controls, and source code are proprietary. Reproduce the *properties*, not its brand, prices, private algorithm, or claims of certification.

Treat this document as an implementation brief. Inspect the current code before editing. Preserve the existing user's uncommitted files. Work in forward-only database migrations. Do not rewrite historical ticks, commitments, settlements, or ledgers. Practice remains the only active account mode; funded/REAL activation is a separate gate. Never label the system audited, FIPS validated, independently witnessed, or equivalent to Deriv until those specific facts are established.

### Repo starting points

- `docs/ENGINE_SPEC.md`: generation versions 1 and 2, commitments, settlement, and present proof limits.
- `supabase/migrations/20260920560000_engine_unified_price_ticks.sql`: current version 2 price-first generator and its authenticated verification RPC.
- `supabase/migrations/20260920380000_engine_determinism_hardening.sql`: seed lifecycle, tick scheduler, reveal, and retention.
- `supabase/migrations/20260920210000_digit_engine_schema.sql`: index definitions, state, epochs, ticks, and per-tick settings.
- `supabase/migrations/20260920420000_engine_health_metrics.sql`: current lag and digit-distribution metrics.
- `assets/js/fairness.js`, `pages/fairness.html`, `pages/guide-fairness.html`: user verification flow.
- `tests/helpers/test-db.mjs`, `scripts/test-engine-postgres.mjs`, and `tests/fairness-ui.test.mjs`: migration and verifier test harnesses.

Version 2 already derives the settlement digit from the generated price and gives each final digit equal probability. It is a useful transition, **not** a full production assurance design. Practice seeds live in the same database as the engine; an operator with sufficient database access can know future outcomes. The current hash chain and browser verification do not provide an independently witnessed commitment time or an independently anchored full price history. Current `sigma_per_tick` values are movement settings, not published annualized volatility targets. A later version must address these limitations without invalidating versions 1 and 2.

## Required architecture decisions before coding version 3

Write an architecture decision record (ADR) and have it reviewed before changing the price formula. The ADR must fix:

1. **Product definition.** Decide whether SPI10/25/50/75/100 names denote measured annualized volatility, relative movement tiers, or another precisely defined quantity. Recommended: define and publish SmartProfit's own 24/7 annualization convention and target bands; do not imply numerical equivalence with Deriv without a measured basis. Specify the tick cadence, decimal precision, trading hours, allowed contract types, and whether indices can reset or change regime. Continuous indices should have no silent daily price reset.
2. **Price model.** Specify the transition from previous published price to next price, including drift, any mean reversion, volatility, rare-event behavior, boundary handling, decimal quantization, and how parameters can change. State whether the process is stationary or can wander. An index must have statistically stable *volatility*, not an artificially flat price. Any regime change must be explicit, versioned, and disclosed; never respond to customer positions.
3. **Digit model.** Digit is always the final displayed decimal digit of the published settlement price. If digit contracts retain the current `winning_digits / 10` payout basis, prove the conditional distribution is exactly uniform for every prior price and permitted setting, or change quoting to an independently reviewed probability model. A goodness-of-fit test alone is insufficient proof of exact probabilities.
4. **Threat model and trust boundary.** Cover dishonest staff, a compromised database or application role, seed theft, selective outage, seed grinding before commitment, post-commitment parameter changes, forged/backdated ticks, tick deletion, replay, double settlement, prediction via an API, and collusion between operational roles. State separately what the verifier proves and what requires trust in infrastructure or an external witness.
5. **Cryptographic protocol.** Freeze byte encodings, domain labels, key derivation, seed length, commitment format, tick transcript, signatures, and version identifiers. Specify byte-level test vectors before implementation. Avoid locale-dependent strings, floating-point arithmetic in normative steps, and implicit JSON key ordering.

Deliverable: `docs/adr/NNNN-synthetic-engine-v3.md` with a versioned specification, formulas, threat model, proof boundaries, quantitative targets, and reviewer sign-off fields. The implementation must follow the frozen specification; code changes to it require a new version and vectors.

## Workstream A — secure randomness and seed custody

### Entropy and generation

1. Generate each epoch's 256-bit secret with an operating-system CSPRNG or a managed HSM/KMS random-data facility. In a Node service, `crypto.randomBytes(32)` is an acceptable API when backed by the platform CSPRNG; confirm the deployed runtime and provider. Do not use `Math.random`, clock values, UUID text, database sequence values, user IDs, or a hash of predictable inputs as entropy. Do not build a custom entropy collector or claim NIST certification from using a standard API.
2. Use an established primitive such as HKDF-SHA-256 to derive separate keys by **environment, account mode, engine version, index, epoch, and purpose**. Purpose labels should separate price movement, last-digit residue, commitments, and any test-only stream. Keep derivation input lengths and encodings unambiguous. Never reuse a Practice key in REAL, staging, or tests.
3. Use a deterministic HMAC-SHA-256 counter-based pseudorandom function for replayable tick randomness, or an independently reviewed DRBG implementation. HMAC output is computationally pseudorandom *when its key remains secret*. Avoid modulo bias with rejection sampling for bounded integers. If a Gaussian-like sample is needed, document its exact transformation and tail behavior; never use unspecified floating-point library behavior as a cross-platform consensus rule.
4. Provide known-answer vectors from at least two independent implementations (for example, service code and standalone verifier) for HKDF, counter blocks, rejection, price units, final digit, and commitments. Include zero/maximum counters, epoch boundaries, invalid input, and forced rejection paths. A verifier must not import the production price-generation function as its sole oracle.

### Custody and access

1. Move active secrets out of PostgreSQL for the future funded path. Use a narrowly scoped, isolated engine service with KMS/HSM-backed envelope encryption or non-exportable root-key operations. Store ciphertext and key IDs in the database; never store active plaintext seeds in a table, migration, environment file, logs, analytics, or browser response. The Practice mode can migrate in a staged rollout, but no REAL index may use the current `engine_private.epoch_seeds` custody model.
2. Give the tick worker only the ability to generate scheduled ticks and publish its outputs. It must not read balances, change payouts, or access staff controls. Give settlement a separate role that consumes immutable ticks. Customer, support, and ordinary admin roles must have no seed-read or arbitrary HMAC-generation capability. Separate KMS administrators from trading operations and record every decrypt/derive operation.
3. Keep active seeds unavailable to verification APIs. Reveal an epoch seed only after its epoch ends **and** all dependent contracts are final or safely resolved. Define a short, explicit outage/recovery policy for overdue reveals. Rotate the root wrapping key without changing published historical seeds; rotate compromised epoch keys according to an incident runbook. Document backup, restore, and destruction procedures.
4. Prevent a privileged operator from requesting future tick outputs through a debug endpoint, arbitrary RPC, database function, or worker command. Require a monotonic schedule and restrict signing/derivation to due ticks. Recognize that a fully privileged infrastructure operator may still compromise the system; do not claim mathematical protection against that role without a stronger external trust design.

## Workstream B — precommitment and independent evidence

1. Create and commit the next epoch's seed commitment and complete model/config hash **before** its first tradable tick. Publish the epoch ID, index/mode, version, exact UTC interval, cadence, precision, anchor state, commitment, previous commitment hash, and creation time. Define what happens if commitment publication is late: fail closed for new purchases.
2. Send the commitment to an append-only store under a separate administrative boundary and obtain an independently checkable timestamp or witness receipt. A row in the same PostgreSQL database, including an immutable trigger, cannot by itself prove when the operator first published a commitment. Sign canonical commitment records with a dedicated signing key whose public key and rotations are published.
3. Assess whether a public randomness beacon sampled **after** the seed commitment should be mixed into the epoch derivation. If adopted, fix the beacon source, round selection, signature verification, missing-round behavior, and mix formula in the ADR. Publish both the operator commitment and the beacon proof. A beacon helps constrain precommitment seed selection only if the future beacon is unpredictable and the operator cannot selectively suppress unfavorable epochs; prove and monitor those assumptions. Do not silently substitute a beacon round.
4. Build an append-only tick transcript: monotonically numbered canonical records containing index, mode, version, scheduled time, generated time, price units, digit, model hash, epoch ID, previous tick hash, and current tick hash. Sign periodic checkpoints and export them to the independent witness store. Define reconciliation of PostgreSQL, the broadcast stream, and witnessed checkpoints after an outage.
5. Publish a machine-readable proof package and verifier instructions. The UI can be a convenient front end, but a user must be able to export enough information to verify without trusting SmartProfit's live API or browser code.

## Workstream C — market model and statistical calibration

1. Specify volatility mathematically. If using annualization for a 24/7 two-second series, set `ticks_per_year = 365 * 24 * 60 * 60 / 2`; define whether reported volatility is standard deviation of log returns, how it is annualized, the sampling window, and how quantization is accounted for. The number in an index name must not be presented as a percentage until observed behavior is measured against a documented percentage target.
2. Simulate each candidate model across many independent seeds, multi-year equivalent runs, epoch transitions, parameter transitions, and long outage catch-ups. Measure realized volatility by index and horizon, return distribution, tail frequency, serial correlation, drift, price range, digit counts, digit serial correlation, lag-one pair counts, and any detectable link to open exposure. Pre-register acceptance bands and confidence intervals in the ADR. A few attractive charts do not establish a stable statistical process.
3. Quantization and uniform-digit noise add price variance. Include that variance in the model calibration, especially for the lowest volatility tier. Prove the last digit is uniform conditional on previous state; then check empirical results as an implementation diagnostic. Keep the final digit as a consequence of the published price, not a display-only annotation.
4. Separate product families. Continuous-volatility, jump/crash/boom, step, and range-bound indices require different published models and risk checks. Do not add special jumps or trend patterns to SPI10–SPI100 without a new named family/version and explicit contract-pricing review.
5. Publish target and observed volatility, time window, engine version, and any changed parameters in customer and admin views. Alert on realized volatility departing from the target band, stalled prices, excessive repeats, negative/overflow prices, digit bias, schedule lag, and cross-index correlation. Do not automatically change parameters in response to customer P/L or open liabilities.

## Workstream D — one authoritative price, settlement, and failure handling

1. Make the scheduled tick number the unique identity of a tick within `(index, mode)`. Generate it exactly once from the committed state. Publish the same canonical record to storage, broadcast, chart, quote context, contract history, and proof export. Retried jobs must return the stored tick byte-for-byte; they must not regenerate from a different seed or model configuration.
2. Fix the entry and settlement tick at purchase time under a database transaction. Quote and buy must use the same immutable policy version, index version, and stake limits. Settle against the stored exit tick price and its last digit. Preserve balanced, idempotent ledger postings and an audit trail linking each contract to its tick hash and proof package.
3. Fail closed for **new** purchases when seed custody, commitment witness, clock, scheduler, model config, price stream, proof publication, or ledger is unhealthy. Existing contracts still need deterministic catch-up ticks and settlement, or an explicit audited refund path where recovery is impossible. Pausing trading must never be a tool for changing an already fixed outcome.
4. Define maximum tolerated tick lag, backlog size, clock drift, and recovery time. Backfill scheduled ticks in order from the committed model. Reconcile sequence gaps before re-enabling purchases. Exercise process crashes before insert, after insert, before broadcast, and during settlement. Reject duplicate or out-of-order publication even under concurrent workers.
5. Keep REAL disabled until the cryptographic custody, external witness, reconciliation, independent review, legal/product, and operational gates are all met. A working Practice simulation is not sufficient evidence for funded activation.

## Workstream E — independent verification and honest product copy

1. Keep version 1 and 2 verification intact. Add version 3 dispatch by the tick's stored, immutable `generation_version`; reject unknown versions. Never reinterpret or backfill old tick rows as version 3.
2. The version 3 verifier must check the witness receipt and signing key, commitment time relative to first tradable tick, seed reveal and hash, model/config hash, domain-separated derivation, every sampled price update, final digit, tick sequence and hash chain, and contract-to-exit-tick mapping. Fetch or export an independently anchored starting state so a missing predecessor cannot silently become an arbitrary trusted `previous_price`.
3. Clearly display **verified**, **not yet revealable**, **missing history**, **invalid signature/commitment**, **price mismatch**, **digit mismatch**, **broken continuity**, and **unwitnessed** as distinct states. Do not collapse failures into a generic “fair” badge. State explicitly that seed reveal does not prove an operator could not preview outcomes or choose/suppress an epoch unless the custody and independent witness controls actually support that claim.
4. Update `docs/ENGINE_SPEC.md`, settlement/fairness guides, FAQ, site copy, API schemas, and admin runbooks with precise terms. State that the system is SmartProfit's own synthetic model. Do not claim that visual chart similarity implies Deriv-equivalent volatility, cryptographic strength, audit status, or payout fairness.

## Execution order and reviewable deliverables

### Phase 0 — audit and freeze

- Inventory current schema, RPCs, grants, scheduler, seed flow, tick broadcast, contract settlement, retention, and frontend assumptions. Capture the current Git state; do not overwrite unrelated uncommitted files.
- Produce ADR, threat model, v3 canonical-format spec, test vectors, volatility definition, and migration/rollback strategy. Get a cryptography specialist and quantitative reviewer to review the ADR before live use.

### Phase 1 — isolated Practice prototype

- Implement the v3 generator and independent verifier in separate modules. Run deterministic vectors and simulation harnesses. Compare generated ticks with database rows and browser output. Add the versioned schema and Practice-only feature flag. Keep existing indices on v2 until replay and statistical acceptance pass.
- Produce a reproducible calibration report with seeds, code version, sample sizes, acceptance bands, plots, and exact commands. Preserve failing samples.

### Phase 2 — custody, witness, and dual run

- Implement isolated seed custody, commitment publication, signing, tick transcript, proof export, role restrictions, and alerts. Run v3 in shadow mode without customer settlement; compare its schedule and health with v2. Do not use shadow ticks for customer contracts.
- Test outage, failover, replays, recovery, seed compromise, lost witness, clock skew, and concurrent worker scenarios. Review logs to ensure no active secret or future outcome leaks.

### Phase 3 — Practice cutover

- Announce an explicit per-index effective tick/time and version. Complete or retain all v2 contracts on their fixed v2 exit ticks before switching an index to v3. Never silently settle a contract against a different generation version. Preserve old proofs and expose both history formats.
- Enable v3 Practice purchases only after the cutover checks and a short monitored soak. Publish the observed volatility dashboard and independent proof package.

### Phase 4 — funded readiness, separate decision

- Require external cryptographic and quantitative review, custody penetration test, witnessed commitment evidence, multi-operator incident procedures, complete accounting/reconciliation testing, and the existing REAL readiness gate. Do not let this plan itself enable REAL.

## Minimum acceptance matrix

| Area | Evidence required before Practice cutover |
| --- | --- |
| Cryptographic reproducibility | Frozen specification; byte-for-byte vectors across generator and independent verifier; forced rejection and boundary cases. |
| Secret protection | No active plaintext seed in PostgreSQL, client payloads, logs, backups accessible to app roles, or public RPCs; role and KMS access tests. |
| Advance commitment | Witness receipt predates first tradable tick; late/missing receipt blocks purchases. |
| Price integrity | One canonical price per tick for every client; monotonic tick numbering; transcript/hash checkpoints; no reroll on retry. |
| Contract integrity | Entry/exit tick fixed at purchase; settlement equals the published exit price digit; duplicate retries post one ledger result. |
| Volatility | Every index meets its pre-registered volatility, drift, tail, and digit-distribution bands on held-out simulated seeds and an observed Practice soak. |
| Failure recovery | Crash/restart, lag, witness outage, KMS outage, seed compromise, and catch-up drills produce documented deterministic outcomes. |
| Historical compatibility | Version 1 and 2 proofs and settled contracts remain unchanged and verifiable. |
| Permissions | Customer/staff/admin roles cannot request active seeds, future ticks, price-generation internals, or witness signing. |
| Verification UX | Standalone proof export and UI agree; tampered price, digit, config, anchor, sequence, signature, or commitment is detected with a specific result. |

## Implementation instructions for Claude

Implement in small, reviewable changes following the phases. After each change, report: files touched, security property added, invariant preserved, exact test commands and results, and unresolved risks. Use actual PostgreSQL with `pgcrypto` for cryptographic parity tests; PGlite fakes do not validate HMAC behavior. Keep a test that ensures a SQL migration can apply to a clean database and to a database containing v1/v2 history. Do not claim completion from a passing unit test if the real database migration, independent verifier, witnessed publication, or quantitative calibration remains untested. Stop before production deployment or REAL enablement; present the completed artifacts and evidence for review.

## Primary references

- [Deriv: Synthetic indices](https://deriv.com/markets/derived-indices/synthetic-indices) — public product properties, not its private algorithm.
- [NIST SP 800-90A Rev. 1](https://csrc.nist.gov/pubs/sp/800/90/a/r1/final) — deterministic random bit generator mechanisms.
- [NIST SP 800-90B](https://csrc.nist.gov/pubs/sp/800/90/b/final) — entropy-source design and validation.
- [NIST SP 800-90C](https://csrc.nist.gov/pubs/sp/800/90/c/final) — constructions combining entropy sources and DRBGs.
- [RFC 5869](https://www.rfc-editor.org/rfc/rfc5869) — HKDF extract/expand and key separation.
- [Node.js `crypto.randomBytes`](https://nodejs.org/api/crypto.html#cryptorandombytessize-callback) — cryptographically strong random bytes when a Node service is used.
