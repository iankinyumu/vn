# ADR 0002 — Engine v3 custody, signing, witness and operations (Phase 2)

| Field | Value |
| --- | --- |
| Status | **Accepted for implementation** (engineering owner). External review is still required before REAL (§9). |
| Builds on | ADR 0001 (spec `v3.0`). Nothing here changes the §4–§6 price bytes. Part B adds new records (§4). |
| Plan | `docs/CLAUDE_SYNTHETIC_ENGINE_PLAN.md`, Workstreams A, B, D and E |

## 1. Decisions at a glance

| # | Question | Decision | Main alternative rejected |
| --- | --- | --- | --- |
| D1 | Where v3 ticks are generated | A separate **Node 24 engine worker** outside the database. It publishes ticks through narrow RPCs as role `engine_tick_writer`. PostgreSQL never sees an active seed. | Keep generating in `pg_cron`. Rejected: seeds would have to live in the database. |
| D2 | Seed custody | **Envelope encryption under a cloud KMS key** that cannot be exported. The recommended provider is AWS KMS (symmetric key, key policy: worker role may `Decrypt` only, with encryption context bound to `{env, mode, epoch_start_ms}`, and every call logged in CloudTrail). The database stores ciphertext and the key id only. A local AES-256-GCM provider exists for `test`/`staging`; the worker **refuses to start with it in `production`**. | Plaintext `engine_private.epoch_seeds`. Rejected: an operator with DB access can see the future. |
| D3 | Seed generation | `crypto.randomBytes(32)` inside the worker, which uses the OS CSPRNG. The worker records the runtime and provider. | `gen_random_bytes` in the database. Rejected by D1. |
| D4 | Signing | **Ed25519**. The private key is stored as a custody-wrapped PKCS#8 blob and loaded only by the worker. Public keys are published in `engine_v3_signing_keys` with validity periods, and rotation is append-only. A KMS-native Ed25519 key can replace it behind the same `Signer` interface without changing any bytes. | ECDSA P-256. Rejected: more malleability pitfalls and no gain here. |
| D5 | Independent witness | **RFC 3161 timestamps from two independent public TSAs**, DigiCert and Sectigo. Both are publicly trusted, WebTrust-audited and tested from this repo. FreeTSA is supported as an optional third. A commitment counts as *witnessed* when **both** receipts verify to a pinned root and their `genTime` predates the first tradable tick. | A row in the same database. Rejected: it cannot prove time. A blockchain anchor was rejected for slow finality and heavy verifier dependencies. |
| D6 | Public beacon | **Not adopted** in v3.0. The witness and custody controls address back-dating and preview. Beacon mixing changes the key derivation and would need `v3.1`. | — |
| D7 | Tick transcript | A per-index hash chain (ADR 0001 §4.5) plus **signed, witnessed checkpoints** every 150 ticks (5 minutes). | — |
| D8 | Single writer | The worker holds a session advisory lock for each `(mode)`. The database also enforces `tick_no = last + 1`, `prev_tick_hash` equality and `scheduled_ms ≤ now`, so a second or rogue writer cannot fork the chain. | — |

## 2. Trust boundary after Phase 2

| Actor | Can | Cannot |
| --- | --- | --- |
| Customer, support, admin (API roles) | Read published ticks, revealed seeds, commitments, receipts and checkpoints | Read wrapped or plain seeds; call any `engine_v3_*` writer RPC; generate a future tick |
| DB owner / `postgres` | Read seed **ciphertext** | Decrypt it (no KMS permission); forge a signature; back-date a TSA receipt |
| Engine worker | Decrypt the seed for the **current** epoch only; publish due ticks; sign | Publish a tick scheduled in the future (refused by the database); change a committed configuration |
| KMS administrator | Manage the key policy | Decrypt: the key policy grants `Decrypt` to the worker role only. Policy changes are logged. |

**What remains trusted.** Someone controlling *both* the worker runtime and its KMS role can preview the current epoch. This is stated in the verifier output and in customer copy. It is mitigated operationally: separate cloud accounts for worker and database, two-person control of the KMS key policy, and CloudTrail alerts on `Decrypt` outside the worker role. It is not eliminated mathematically.

## 3. Operational thresholds (fail closed for new purchases)

| Gate | Threshold | Purchases while breached | Existing contracts |
| --- | --- | --- | --- |
| Tick freshness | last v3 tick ≤ 6 s behind schedule | Rejected (`feed_stale`) | Settle when late ticks arrive; late beyond policy `max_settlement_delay_seconds` → audited VOID and refund (existing path) |
| Commitment lead | the next epoch is committed ≥ 1 h before it starts | Rejected in the new epoch until committed and witnessed | Unaffected |
| Witness | both TSA receipts recorded with `genTime` < the contract's entry tick time | Rejected (`engine_unwitnessed`) | Unaffected |
| Clock drift | worker vs database `now()` ≤ 1 s, checked every cycle | Worker stops publishing, so ticks go stale | As tick freshness |
| Backlog | ≤ 50 ticks generated per cycle, in order | Freshness gate applies | Catch-up is deterministic |
| Checkpoint | the latest signed checkpoint is ≤ 300 ticks old | Rejected (`engine_checkpoint_stale`) | Unaffected |
| Band halt / key loss | index `HALTED` | Rejected | `engine_v3_void_unproducible` refunds contracts whose exit tick can never be produced (audited) |

## 4. Part B records (additive to spec v3.0)

```
signed_message(kind, key_id, subject) = HEADER("signed") ‖ str(kind) ‖ str(key_id) ‖ subject        # subject = 32 bytes
checkpoint_hash = SHA-256( HEADER("checkpoint") ‖ str(env) ‖ str(mode) ‖ str(index)
                           ‖ u64(tick_no) ‖ tick_hash ‖ u64(created_ms) )
```

- `kind` ∈ {`epoch-commitment`, `checkpoint`}. The signature is Ed25519 over `signed_message`.
- An RFC 3161 request uses `messageImprint = (SHA-256, subject)`, where `subject` is the commitment or checkpoint hash itself. Since the subject is a SHA-256 of a canonical record, the TSA attests "a record with this hash existed at `genTime`".
- A verifier accepts a TSA receipt only if the CMS signature verifies, the signer chain reaches a **pinned root** (`verifier/v3/tsa-roots.json`), the leaf has the `id-kp-timeStamping` EKU, and every certificate is valid at `genTime`. Revocation is not checked; see §9.

## 5. Cutover (Phase 3)

Per index, at a UTC day boundary `D`:

1. `genesis_tick_no` is the last tick scheduled before `D`, computable from `t0`. `genesis_units` is the announced 10000.000. The v3 series is a **new, announced price series**, because v2 prices are around 1000.
2. At least 24 h before `D`, the worker registers the configuration and commits and witnesses epoch `D`. Operations then call `engine_v3_schedule_cutover`, which sets `v2_final_tick_no`.
3. From then on, v2 buys whose exit tick would pass `v2_final_tick_no` are rejected (`engine_generation_cutover`). v2 generation stops at that tick, so every v2 contract settles on a v2 tick.
4. At `D`, the index's `engine_generation` becomes 3 and the worker publishes from `genesis_tick_no + 1`.

## 6. Reveal

The worker publishes an epoch's seed ≥ 10 minutes after the epoch ends, once no OPEN contract has an entry or exit tick inside it. The database checks `SHA-256(HEADER("seed-hash") ‖ seed) = seed_hash` before accepting the reveal. Overdue reveals (> 24 h) raise an admin health alert.

## 7. Incident runbooks (summary; full text in `docs/runbooks/engine-v3.md`)

- **Seed or worker compromise:** halt the affected mode, void open contracts through `engine_v3_void_unproducible`, rotate the KMS key and signing key, commit a new configuration, and disclose. Published history stays; it is never rewritten.
- **KMS outage:** ticks stop and purchases fail closed. Existing contracts VOID after the policy delay. Recovery resumes deterministic catch-up.
- **TSA outage:** ticks continue. Purchases in a not-yet-witnessed epoch fail closed. The worker retries both TSAs with backoff.
- **Worker crash:** a restart regenerates byte-identical ticks. The database accepts an identical re-publish and rejects any different one (`engine_v3_tick_conflict`).

## 8. Implementation map

| Area | Location |
| --- | --- |
| Schema, writer RPCs, gates, cutover, reveal, proof export | `supabase/migrations/20260924110000_engine_v3_publication.sql` |
| Worker, custody, signer, TSA client | `engine/v3/service/` |
| Verifier: signatures, RFC 3161, checkpoints | `verifier/v3/verify.mjs`, `verifier/v3/tsa.mjs`, `verifier/v3/tsa-roots.json` |
| Drills and acceptance evidence | `tests/engine-v3-*.test.mjs`, `scripts/engine-v3-acceptance.mjs`, `docs/ENGINE_V3_ACCEPTANCE.md` |

## 9. Outside this repository (required before the corresponding matrix row is signed)

These are operational facts code cannot create. `scripts/engine-v3-acceptance.mjs` reports each one as **pending** until its evidence file exists.

1. Provision the AWS KMS key and the worker IAM role, with the key policy of D2 and CloudTrail alerting.
2. Deploy the worker in a cloud account separate from the database. Rotate its DB credential.
3. Run shadow mode, then a monitored Practice soak of ≥ 7 days after cutover (observed volatility, lag and gates).
4. Perform the live failure drills (KMS revoke, TSA block, worker kill) against staging and archive their logs.
5. Obtain independent cryptographic and quantitative review of ADR 0001/0002, and a custody penetration test before any REAL decision.
6. Monitor TSA certificate revocation (OCSP/CRL) operationally. The offline verifier pins roots but does not check revocation.

## 10. Revisions from the production fix brief (2026-09-25)

These supersede the matching parts of §1–§4 wherever they differ (`docs/CLAUDE_ENGINE_V3_PRODUCTION_FIX.md`).

**Witness deadline (replaces "genTime < the contract's entry tick time").** For each epoch, the deadline is the first scheduled tradable tick over every index in the epoch's committed configuration: `max(genesis + 1, first tick at or after the epoch start)`.
- The config hash and epoch start are both inside the commitment, so the deadline is commitment-bound and cannot change after publication.
- SQL (`engine_private.v3_witness_deadline`), the generator (`witnessDeadline`) and the independent verifier compute it identically. It is exported with each epoch, and the verifier recomputes and compares it.
- A receipt with `genTime` at or after the deadline is **late**. It never makes an epoch tradable or verified, however soon after it arrives.

**Trust boundary for receipts (replaces "worker records receipts").**
- The tick writer can only *submit* raw tokens (`engine_v3_witness_submissions`). Its claimed `genTime` is ignored.
- A separate role, `engine_witness_attestor`, runs `engine/v3/service/attestor-main.mjs` under its own credentials and without KMS access. It verifies each token against the pinned roots and the canonical subject, takes `genTime` from the token, and records one immutable verdict per submission.
- Each verdict is bound to the token hash, provider, subject, deadline and the canonical root-bundle ID (`tsa.mjs rootBundleId`). The database refuses verdicts made with any other bundle than the one staff configured.
- Purchase gates read attestations only.
- Resubmitting an identical token is idempotent. A different token is a new, audited submission, so an invalid first receipt can be replaced. Nothing uses `ON CONFLICT DO NOTHING`.

**Checkpoints.** A checkpoint anchors a purchase only if every required TSA has an attested valid receipt with `genTime` before the purchase time, and its tick is within the configured gap. Genesis anchors a new series until the first checkpoint. Proofs verify checkpoint receipts themselves. An unwitnessed anchor leaves the range **unanchored**.

**Configuration rotation.** Each epoch binds its own configuration. Proof package v2 carries every needed configuration keyed by hash and may span a change. The verifier checks each tick under its own epoch's configuration. A rotation must keep each live index's `genesis_*` values. A new genesis is a cutover (§5).

**Verdict.** Browser and CLI share one verifier, one trust loader (`verifier/v3/trust.mjs`) and one result.
- `components`: price/continuity, signatures, witness, checkpoints, reveal, contracts.
- `verdict`: `fully_verified`, `partial` or `invalid`.
- CLI exit codes: 0, 2 and 1 respectively (64 for a usage error).
- Unpinned keys, missing roots, missing or late receipts, and unrevealed days are **partial**. Tampering, invalid tokens and unpublished keys are **invalid**.

**Remaining privileged-infrastructure threat.** Separating the attestor stops the tick writer from minting "witnessed", but it does not stop an attacker who controls both the worker and the attestor, or the database owner. A database owner can insert an attestation row directly. The public proof does not depend on attestation rows, because it re-verifies raw tokens against pinned roots. The purchase gate does depend on them. Mitigations are operational: separate cloud accounts, database-owner credentials held outside the application team, and alerts on writes to `engine_v3_witness_attestations` by any role other than the attestor. No cryptographic protection is claimed against full worker compromise.

**Release statuses.** `scripts/engine-v3-acceptance.mjs` reports `CODE_READY` (automated gates plus a recorded independent code review), `PRACTICE_READY` (plus every operational evidence file) and `REAL_READY` (never set by this project).
