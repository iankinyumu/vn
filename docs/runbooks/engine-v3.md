# Engine v3 operations runbook

Covers ADR 0001 (specification) and ADR 0002 (custody, signing, witness, operations). Practice (`DEMO`) only. Nothing here enables REAL.

## 1. Separation of duties (set up once)

| Role | Holds | Must not hold |
| --- | --- | --- |
| KMS administrator (cloud account A) | Key policy management | `kms:Decrypt`, database credentials |
| Engine worker runtime (cloud account B) | IAM role with `kms:Encrypt`/`kms:Decrypt` on one key, DB login in `engine_tick_writer` | Staff/admin app access, DB owner |
| Database owner (Supabase) | Migrations | KMS permissions, the worker's IAM role |
| Engine manager (staff, MFA) | `engine_v3_configure`, `engine_v3_set_shadow`, `engine_v3_schedule_cutover` | Worker credentials |

Two people must approve any change to the key policy.

## 2. KMS key (AWS)

Create a symmetric `SYMMETRIC_DEFAULT` key in the worker's region. Key policy statements, in addition to the account root statement:

```json
{
  "Sid": "EngineWorkerSeedsAndSigningKey",
  "Effect": "Allow",
  "Principal": { "AWS": "arn:aws:iam::<ACCOUNT_B>:role/smartprofit-engine-v3-worker" },
  "Action": ["kms:Encrypt", "kms:Decrypt"],
  "Resource": "*",
  "Condition": {
    "StringEquals": { "kms:EncryptionContext:env": "production" },
    "ForAllValues:StringEquals": { "kms:EncryptionContextKeys": ["purpose", "env", "mode", "epoch_start_ms", "key_id"] }
  }
},
{
  "Sid": "KeyAdministratorsCannotDecrypt",
  "Effect": "Deny",
  "Principal": { "AWS": "arn:aws:iam::<ACCOUNT_A>:role/smartprofit-kms-admin" },
  "Action": ["kms:Decrypt", "kms:ReEncrypt*", "kms:GenerateDataKey*"],
  "Resource": "*"
}
```

Enable CloudTrail data events for the key. Alert on any `Decrypt` whose principal is not the worker role, and on any `PutKeyPolicy`.

## 3. Database

1. Apply migrations `20260924100000`, `20260924110000` and `20260924120000`. They are inert until configured.
2. An engine manager with a fresh MFA session calls, through the app API:
   `select public.engine_v3_configure('production', '{}'::jsonb, '<reason>')`.
   The environment is immutable once set. Production refuses thresholds weaker than ADR 0002 §3 and fewer than two witnesses.
3. Create the worker login, using a generated secret stored only in the worker's secret manager:
   `create role smartprofit_engine_worker login password '<secret>' in role engine_tick_writer;`
4. Connect the worker through a **session-mode** connection (direct, or the pooler's session mode). Transaction pooling breaks the single-writer advisory lock.

## 4. Signing key

```
ENGINE_CUSTODY=kms:aws ENGINE_KMS_KEY_ID=<arn> AWS_REGION=<region> \
ENGINE_SIGNING_KEY_FILE=/secrets/signing-key.json \
node engine/v3/service/main.mjs --init-signing-key ed25519-2026-10-1
```

The command prints the public key. Add it to `verifier/v3/trusted-keys.json` in a reviewed commit and deploy the site, **before** the worker's first commitment. Keys are never removed. When a key is retired, keep it listed so past records stay verifiable.

## 5. Parameters file

`ENGINE_PARAMS_FILE` must list every index in the mode:

```json
{
  "SPI10": { "annual_vol_bp": 1000, "anchor_units": 10000000, "kappa_e12": 534835, "min_units": 500000, "max_units": 200000000, "genesis_tick_no": 0, "genesis_units": 10000000 },
  "SPI25": { "annual_vol_bp": 2500, "...": "same shape" }
}
```

- The values come from ADR 0001 §3. `genesis_tick_no` is the last tick scheduled before the UTC day on which that index's v3 series starts: `floor((D_ms - 1 - t0_ms) / tick_interval_ms)`.
- The worker registers the configuration every cycle. A changed file creates a new `config_hash`, which applies only to epochs committed after the change. Committed epochs never change.

## 6. Start the worker

```
ENGINE_DATABASE_URL=... ENGINE_CUSTODY=kms:aws ENGINE_KMS_KEY_ID=... AWS_REGION=... \
ENGINE_SIGNING_KEY_FILE=/secrets/signing-key.json ENGINE_PARAMS_FILE=/config/params.json \
ENGINE_WITNESSES=digicert,sectigo node engine/v3/service/main.mjs
```

The worker keeps commitments two days ahead, each ≥ 1 h before its epoch starts. A second instance waits in standby until the leader's lock is released. Logs are JSON lines, and seeds and keys are never logged.

## 7. Shadow run (Phase 2)

1. Set `genesis_tick_no` for every index to the last tick before shadow day `D` (§5), and start the worker at least 24 h before `D`.
2. After the day-`D` epoch is committed and witnessed (check `get_admin_engine_v3_health`), each engine manager calls `engine_v3_set_shadow('DEMO', '<index>', true, '<reason>')`.
3. Shadow ticks go to `engine_v3_shadow_ticks` and never settle anything. Compare schedule lag, gaps and volatility with v2 for at least 7 days. Export the evidence (§11).

## 8. Practice cutover (Phase 3)

1. Choose `D2`, at least 48 h ahead. Update `genesis_tick_no` for the index to the last tick before `D2` and deploy the parameters file, so the epochs from `D2` onward carry it.
2. Once the `D2` epoch is committed **and** witnessed, call `engine_v3_schedule_cutover('DEMO', '<index>', <D2_ms>, '<reason>')`. It returns `v2_final_tick_no`.
3. Announce the cutover time and the new series. v3 starts at 10000.000, a new price series.
4. From scheduling onward, v2 buys whose exit tick passes the final tick are refused (`engine_generation_cutover`), and v2 generation stops at the final tick.
5. At `D2` the worker calls `engine_v3_activate_cutover` once the last v2 tick is final and no v2 contract is open. The index then publishes v3 ticks from `genesis + 1`.
6. Customer copy: update the "No index uses version 3 yet" paragraph in `pages/guide-fairness.html` in the same release.

## 9. Routine checks

- `get_admin_engine_v3_health`: a worker seen within 10 s with drift ≤ 1 s; today's and tomorrow's epochs each with two witnesses; no `reveal_overdue`; volatility `within_band` once a day of ticks exists.
- `purchase_block` per index in `get_engine_v3_status` is `null` in normal operation.

## 10. Incidents

| Event | Automatic behaviour | Operator action |
| --- | --- | --- |
| KMS outage | No ticks; purchases fail (`feed_stale`). Late exit ticks → policy VOID and refund | Restore KMS. The worker catches up deterministically. Confirm catch-up in health. |
| TSA outage | Ticks continue; purchases in an unwitnessed epoch fail (`engine_unwitnessed`) | Watch retries. If one TSA is down for more than 12 h, raise it as an incident. Do not relax `required_witnesses` in production (the database refuses). |
| Worker crash | None. A restart continues from database state. | Check that the chain is contiguous. A `engine_v3_nondeterminism_detected` exit is a severity-1 incident. |
| Price band breach | The worker halts the index and refunds unproducible contracts | Investigate. Resuming needs a new cutover. |
| Suspected seed or worker compromise | — | Halt every index (`engine_v3_halt`) and refund (`engine_v3_void_unproducible`). Rotate the KMS key policy and role, retire the signing key, and add a new one to `trusted-keys.json`. Disclose. Recommit from a new cutover. History is never rewritten. |
| Missed commitment window (outage over 2 days) | Ticks for the uncommitted day cannot be published | Treat as halt + new cutover. |

## 11. Evidence for the acceptance matrix

`node scripts/engine-v3-acceptance.mjs` rebuilds `docs/ENGINE_V3_ACCEPTANCE.md`. External rows turn **MET** only when a signed-off evidence file exists in `docs/evidence/` (see the template the script prints). Evidence files are reviewed commits. Do not create one for work that has not happened.
