# Claude implementation brief: finish engine v3 and the customer site

**Status:** OPEN — this is an implementation instruction, not a readiness certificate.
**Scope:** Complete and verify the Phase 2 repairs, the Practice cutover path, the independent proof experience, and the customer-facing site. Preserve funded/REAL as a separate release gate under `docs/REAL_READINESS_CHECKLIST.md`.

## Operating instruction

Implement this brief end to end. Do not stop to ask the owner to choose between routine technical alternatives. The decisions below are made. Inspect the current repository first, preserve every pre-existing uncommitted change, use forward-only database migrations, and make small reviewable commits containing only your work. Do not alter historical v1/v2 ticks, contracts, proofs, or ledger records. If an implementation detail is genuinely unspecified, choose the option that preserves independent verification, fail-closed purchase behavior, and the existing public contract; document the choice in the ADR and continue.

Run the tests and inspect the rendered site, not just source files. Fix failures you introduce. A failed local test environment is an environment result, never a pass. Obtain a real PostgreSQL result in a compatible environment if embedded PostgreSQL fails on Windows. Never synthesize operational evidence, private keys, timestamps, approvals, deployment records, or elapsed soak time. If credentials, external infrastructure, or seven days of observations are unavailable, finish all executable code and local verification, record the exact external blocker, and leave the relevant readiness gate OPEN. No need to ask the owner for a technical decision to proceed with independent work.

The primary documents are `docs/CLAUDE_SYNTHETIC_ENGINE_PLAN.md`, `docs/adr/0002-engine-v3-custody-witness-operations.md`, `docs/runbooks/engine-v3.md`, and `docs/ENGINE_V3_ACCEPTANCE.md`. Correct these when implementation changes their claims. The acceptance matrix generated on 2026-09-24 is historical output; regenerate it after the fixes.

## Starting point: Claude's 3 of 10 result

Claude reported **3 of 10 acceptance rows MET**: cryptographic reproducibility, historical compatibility, and verification UX. The other **7 of 10** are explicitly pending: secret protection, advance commitment, price integrity, contract integrity, volatility, failure recovery, and permissions. These are the statuses in the existing generated matrix, **not a production-readiness result**. The audit found additional defects in the implementation and in what the current automated checks assert. In particular, verification UX must be re-evaluated after fixing CLI trust inputs, config changes, and checkpoint witnesses. Do not carry any old `MET` label forward without rerunning the strengthened checks on the final candidate commit.

Creating an AWS KMS key and deploying the worker is only the start of closing those seven rows. It does not supply the required seven-day shadow record, staging failure drills, seven-day observed Practice run, independent receipts, published production signing key, or corrected proof behavior. Nor does it fix the missing AWS SDK dependency. Perform the code repairs and fresh local verification first; then use real infrastructure and elapsed observation windows to close the operational rows. Do not mark an evidence file complete just because the worker starts.

| Existing row | Current report | Additional work before it can be accepted afresh |
| --- | --- | --- |
| Cryptographic reproducibility | MET | Rerun frozen vectors and PostgreSQL parity on the final implementation. |
| Secret protection | Pending | Fix KMS dependency and custody path; deploy isolated KMS and worker; prove role separation and secret non-disclosure. |
| Advance commitment | Pending | Enforce and prove both valid receipts before the true first tradable tick; complete the shadow run. |
| Price integrity | Pending | Repair and verify transcript, cross-config proofs, anchors, and witnessed checkpoints; complete the shadow run. |
| Contract integrity | Pending | Test the corrected fail-closed gate and reconciliation; complete the Practice soak. |
| Volatility | Pending | Recompute held-out calibration and measure the actual seven-day Practice series. |
| Failure recovery | Pending | Pass automated retry/restart tests and recorded staging outage drills. |
| Historical compatibility | MET | Rerun migration and v1/v2 regression checks after the forward-only repairs. |
| Permissions | Pending | Test all roles against the new validation path and prove the deployed KMS policy. |
| Verification UX | MET, subject to recheck | Fix browser/CLI verdict parity, trust pinning, config rotation, checkpoints, and rendered UI; rerun browser and tamper tests. |

## Required design decisions

1. **One explicit release status.** Report `CODE_READY`, `PRACTICE_READY`, and `REAL_READY` separately. `CODE_READY` requires the full automated suite, real PostgreSQL integration, production build, browser checks, and reviewed code. `PRACTICE_READY` additionally requires deployed isolated custody, pinned signing key and TSA roots, witnessed shadow run, staging failure drills, cutover, and observed Practice soak. `REAL_READY` additionally requires every independent review and control in the funded readiness checklist. Never write “production ready”, “site ready”, “independently witnessed”, or “Deriv equivalent” without defining and satisfying the applicable gate. No silent fallback from v3 to v2 or local custody during an active v3 run.
2. **Witness deadline.** For each epoch, both independent RFC 3161 receipts must cryptographically validate against pinned roots and have `genTime` strictly before that epoch's **first scheduled tradable v3 tick**, determined from the index schedule and cutover, not from a selected proof range or a contract entry time. Enforce this for every index covered by an epoch. If no such tick exists yet, use the frozen scheduled start defined in the publication record. Persist and export the deadline as a canonical, signed or commitment-bound value. Do not change a deadline after publication. A receipt arriving after ticks have begun cannot make that epoch witnessed for purchase purposes or for the verifier.
3. **Config rotation.** Keep v3 as the generation version and support multiple immutable, hash-identified configurations across epochs. Each epoch binds its own config; a proof can contain every config it needs, keyed by hash. The verifier selects the epoch's config for each tick. A request spanning a config change must verify in one package; do not throw merely because the range crosses a change. Include only the necessary predecessor commitment chain and anchor history, with bounded, explicit proof size. Preserve validation of `prev_commitment` across epochs. Do not trust an arbitrary previous price at a package boundary.
4. **Proof success.** Expose separate `price/continuity`, `signatures`, `witness`, `reveal`, and `contracts` states. Overall **fully verified** means all applicable checks pass, the starting state is anchored, signing keys are pinned, all required receipts validate before their true deadlines, and every due seed is revealed and reproduced. A mathematically matching price with missing independent evidence is `partial` or `unwitnessed`, never an unconditional success. Current unrevealed epochs must say `not yet revealable`. Use the same core verifier, trust policy, required witnesses, and result contract in browser and CLI. CLI exit 0 only for fully verified; distinct nonzero status for incomplete proof and invalid proof.
5. **Checkpoint rule.** Every promised checkpoint is signed and independently witnessed. Export its receipt tokens, verify their subject, TSA signature, and `genTime`, and mark a missing or invalid receipt distinctly. A checkpoint becomes a usable independent anchor only after receipt validation; for a purchase, its `genTime` must precede that purchase's entry time and its tick must be within the configured freshness gap. Do not imply that a checkpoint was witnessed at its own tick time when the TSA signed it later. Preserve a defensible genesis anchor when no checkpoint exists.
6. **Trust boundary.** An engine writer cannot make its own arbitrary receipt row count as witnessed. Treat receipt token, claimed provider, claimed `genTime`, and database timestamp as untrusted input. Validate token signature, chain, EKU/policy, subject imprint, and extracted `genTime` in a constrained service before storage; bind the stored validation result to the exact token, pinned root bundle version, subject, provider, and canonical deadline. For the purchase gate, use a separately authorized attestation path or database-verifiable validation result that the ordinary tick writer cannot mint. If a robust independent attestation cannot be implemented in this release, keep the gate closed and label this requirement unmet. Reject malformed, duplicate-conflicting, unknown-subject, or late receipts; do not use `ON CONFLICT DO NOTHING` to conceal invalid first inserts or block a valid replacement without an explicit recovery operation and audit trail.
7. **Key custody.** The production worker uses `kms:aws` with a named KMS key ARN and scoped encryption context. Add and lock `@aws-sdk/client-kms` as a runtime dependency; `npm ci` followed by a KMS module load/startup check must pass. Keep the signing private key wrapped outside the database and available only to the worker. Publish the real public key through a reviewed, append-only trust manifest; never generate or commit a fake production key to satisfy a test. Production startup must refuse local custody, an empty trust manifest, missing witnesses, missing parameters, or unavailable KMS. Maintain key rotation and historical verification.

## Work sequence and exact outcomes

### 1. Baseline, migrations, and dependency repair

- Record the starting commit, worktree status, and which files already belong to the owner. Do not stage or rewrite those files without a necessary conflict resolution; show any such resolution in the final report.
- Add the missing KMS dependency and lockfile update. Exercise the `kms:aws` construction path with a mock client and a clean `npm ci`; verify production configuration fails safely without credentials or required settings.
- Add a forward-only migration for corrected receipt, deadline, checkpoint, and proof data. Apply all migrations both to a clean PostgreSQL database and one containing v1/v2 history, with `pgcrypto` enabled. Test role grants and RPC access as customer, staff, admin, and dedicated worker roles. Preserve older proof exports.
- Review the worker for retry, idempotence, clock drift, leader/fencing, transaction, and restart behavior. A retry must never reroll a tick, commitment, seed, or digit. No routine log, RPC, telemetry event, error response, backup visible to app roles, or browser bundle may contain an active plaintext seed, signing secret, or future outcome.

### 2. Repair independent publication and purchase gates

- Compute and publish immutable epoch start, true first scheduled tradable tick per index, config hash, commitment, and signed canonical metadata before the first due tick. Verify both TSA receipts against the pinned roots and canonical subject before an epoch is eligible for trading. Preserve the raw tokens for independent re-verification.
- Make the contract gate compare each entry and settlement epoch against its own true witness deadline. A current or future settlement epoch without a valid pre-tick receipt blocks new purchases. Late receipt, invalid token, stale worker heartbeat, clock skew, stale witnessed checkpoint, KMS outage, and feed lag fail closed with stable machine-readable reasons. Continuing tick publication during a TSA outage must not make late witnessing appear valid.
- Ensure ordinary database or app administrators and the tick-writer role cannot forge the independent validation signal used by the purchase gate. Document the remaining privileged-infrastructure threat in the ADR; do not claim cryptographic protection against full worker compromise.
- Produce database integration cases for: two good receipts; one missing; token with wrong subject; forged `genTime`; bad TSA signature/chain; after-first-tick receipt; future epoch settlement; recovery after TSA outage; duplicate and replacement receipt; checkpoint not witnessed; and unauthorized writer. Tests must assert both purchase result and exported proof result.

### 3. Repair proof export and verifier together

- Export a versioned package with all required immutable configs, epoch records, receipt tokens, pinned key IDs, checkpoints, predecessor chain/anchor, ticks, and linked contracts. Keep a documented size limit and pagination/continuation strategy; do not omit data silently to fit the limit.
- Verify config hash and signature for each epoch, then reproduce each tick under that epoch's config. Check sequence, previous price, hash chain, commitment chain, entry and exit mapping, displayed last digit, and settlement. Verify true schedule-relative receipt times. Validate TSA tokens in both browser and CLI using the same pinned root set. Reject untrusted keys and missing roots as incomplete or invalid, not verified.
- Remove the single-config-range exception. Cover shadow-to-Practice cutover, two adjacent configs, a range beginning at a checkpoint, a range crossing a UTC epoch boundary, missing predecessor history, and historical v1/v2 coexistence. For each valid fixture, mutate one byte in price, digit, config, signature, token, timestamp, anchor, sequence, and contract linkage and require a specific failing state.
- Make the CLI accept a proof file and load the checked-in trust manifest and root bundle by default. Permit explicit trust bundle override only for test/staging with conspicuous labeling. Test CLI exit codes with real fixture packages. Browser and CLI must produce the same normalized verdict for the same proof and trust bundles.

### 4. Finish customer frontend and UI/UX

- Build the static site and test the rendered `pages/fairness.html`, `pages/trade.html`, `pages/dashboard.html`, index list, and related help copy at desktop and mobile widths. Verify that the v3 fairness panel appears only for applicable v3 history, allows a sensible valid tick range, exports the exact package it checked, and explains `fully verified`, `partial/unwitnessed`, `not yet revealable`, and `invalid` in plain language. Show the checked time range, index, config changes, witness providers, key identity, checkpoint anchor, and contract outcome without leaking implementation secrets.
- Give loading, offline/network failure, stale feed, unsupported browser crypto, too-large range, missing history, no data, invalid proof, and download failure distinct, actionable UI states. Keep the page usable with keyboard only and a screen reader: labels, focus, live result announcements, contrast, and no color-only verdicts. Avoid calling a price “fair” merely because a local hash check passed.
- Confirm the trade UI disables and explains blocked v3 purchases, does not show a successful purchase before the server confirms the gate, and shows the generation version and fixed entry/exit ticks in receipts/history. Confirm dashboard observed volatility is labeled by window and sample size and is never presented as a guaranteed constant or as a prediction of future digits.
- Run real browser checks against a local served build, not only DOM unit tests. Check console errors, network failures, responsive layout, tab order, proof upload/export or download flow, and matching CLI verdicts. Capture screenshots or a concise browser test log as evidence. Keep customer language consistent across fairness, guide, FAQ, dashboard, and trade pages.

### 5. Strengthen acceptance and operational evidence

- Replace `docs/evidence/*.json` existence checks with a schema that requires artifact paths/URLs, SHA-256 digests or immutable object references, environment, time interval, actor and independent reviewer identities, review timestamp, source commit, and measured results. Validate that local artifacts exist and hashes match; external references require a recorded independent review. Do not call this cryptographic proof of human performance. Add negative tests for empty strings, fabricated/missing artifacts, mismatched hashes, too-short intervals, wrong environment, and a self-review.
- `npm run accept:engine-v3` must fail whenever any required `CODE_READY` row fails. A distinct Practice-readiness command/status must fail when any external row is pending. Never return exit 0 while wording suggests the complete matrix is met when it is not. Recompute calibration with the current generator revision and preserved seeds; check preregistered volatility, drift, tails, and digit bands plus actual observed data when available. A committed historical report alone is insufficient.
- Update runbook and ADR with actual verification behavior, deployment order, alert thresholds, rollback/void procedure, key and root rotation, outage handling, and a clear statement of what an independent proof does and does not establish. Update `docs/ENGINE_V3_ACCEPTANCE.md` from the final checks. Keep the funded checklist separate.

## Required test matrix

Use real PostgreSQL for migration, cryptographic parity, access control, contract gate, and worker integration. PGlite tests can supplement these but cannot replace them. Run at least:

```text
npm ci
npm run build
npm run check:parity
npm run check:engine-v3-vectors
node scripts/test-engine-postgres.mjs
node --test --test-concurrency=1 tests/*.test.mjs
npm run calibrate:engine-v3
npm run accept:engine-v3
```

Add focused tests before implementation for the witnessed-first-tick rule, cross-config proof, CLI trust behavior, checkpoint witness, and evidence validator. Run both happy-path and tampered-proof browser fixtures. Run the full suite again after the final code change. Record command, environment, commit, result, and any skip. If Windows embedded PostgreSQL cannot start, run the same test against a compatible local/container/staging PostgreSQL; a skipped test remains open until that run succeeds.

## Release procedure and truthful completion

1. Complete code, tests, docs, and browser verification first. Mark `CODE_READY` only when all its gates pass on the exact candidate commit. A local-mode fixture may establish code behavior but cannot establish isolated production custody or independent live witnessing.
2. If already-authorized credentials and infrastructure exist, provision the separate worker account and KMS key, deploy the candidate, publish its real signing key, verify both TSA paths, and execute the runbook. Record immutable evidence. If access is absent, leave deploy/evidence tasks open and report the exact missing capability; continue every local task that does not depend on it.
3. Run at least seven complete days of shadow ticks and staging failure drills. Only after the specified pre-cutover checks pass, cut over one Practice index with a published effective tick and version. Reconcile settlement and run at least seven complete days of Practice monitoring. Never shorten these windows to make the document appear done.
4. Mark `PRACTICE_READY` only when every Phase 2/3 row is genuinely MET and observed reports and browser proof checks agree. Keep `REAL_READY` false until the separate funded checklist and external reviews are completed. Do not enable funded/REAL through this brief.
5. Final handoff must include the exact candidate commit, files changed, migrations applied, commands and outputs, browser evidence, acceptance row statuses, deployed environment and time windows if any, unresolved risks, and the next operational action. If all gates are met, change this document's Status to `DONE` with a dated evidence link. If any gate is open, retain `OPEN` or `CODE_READY` and state why without requesting a new technical decision.

## Primary protocol references

- [RFC 3161 Time-Stamp Protocol](https://www.rfc-editor.org/rfc/rfc3161) for independently verifiable timestamp tokens and `genTime`.
- [AWS KMS Decrypt API](https://docs.aws.amazon.com/kms/latest/APIReference/API_Decrypt.html) and [encryption context](https://docs.aws.amazon.com/kms/latest/developerguide/encrypt_context.html) for key scoping and ciphertext context.
- [AWS cross-account KMS access](https://docs.aws.amazon.com/kms/latest/developerguide/key-policy-modifying-external-accounts.html) for the two-policy permission boundary.
