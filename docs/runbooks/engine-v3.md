# Engine v3 operations runbook

Covers ADR 0001 (specification) and ADR 0002 including §10 (custody, signing, witness, attestation, operations). Practice (`DEMO`) only; nothing here enables REAL.

## 1. Separation of duties

| Role | Holds | Must not hold |
| --- | --- | --- |
| KMS administrator (cloud account A) | Key policy management | `kms:Decrypt`, database credentials |
| Engine worker (cloud account B) | IAM role with `kms:Encrypt`/`kms:Decrypt` on one key; DB login in `engine_tick_writer` | Attestor or staff credentials; DB owner |
| Witness attestor (cloud account C, or B with a separate identity) | DB login in `engine_witness_attestor`; read-only copy of `verifier/v3/tsa-roots.json` | KMS access; writer credentials |
| Database owner (Supabase) | Migrations | KMS permissions; worker or attestor roles |
| Engine manager (staff, MFA) | `engine_v3_configure`, `engine_v3_set_shadow`, `engine_v3_schedule_cutover` | Worker or attestor credentials |

Any change to a key policy, the trust manifest or the root bundle needs two approvers.

## 2. Deployment order

Do each step only after the previous one has been checked.

1. **Database.** Apply migrations `20260924100000`, `20260924110000`, `20260924120000` and `20260925100000`. They are inert until configured. The v3 migrations build on `20260920560000` (v2 unified ticks), which must be applied first.
2. **KMS key (§3).** Record the `kms-provisioning` evidence (§12).
3. **Signing key (§5).** Publish its public key in `verifier/v3/trusted-keys.json` through a reviewed commit, and deploy the site.
4. **Configure the database (§4).** Set the environment, and the root-bundle ID of `verifier/v3/tsa-roots.json`.
5. **Deploy the attestor (§7), then the worker (§6).** The worker's preflight refuses to start unless everything above is in place. Record the `worker-deployment` evidence.
6. **Shadow run (§8)** for at least 7 complete days, with staging drills (§11). Record `shadow-run` and `live-drills`.
7. **Practice cutover (§9)**, then at least 7 complete days of monitoring. Record `practice-soak`.

## 3. KMS key (AWS)

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

Enable CloudTrail data events for the key. Test both of these before recording evidence:
- A `Decrypt` attempted by the administrator role is denied.
- A `Decrypt` from any principal other than the worker role raises an alert.

## 4. Database configuration

An engine manager with a fresh MFA session calls, through the app API:

```sql
select public.engine_v3_configure('production', '{"tsa_root_bundle_id":"<id>"}'::jsonb, '<reason>');
```

- `<id>` is `rootBundleId` over the required providers' roots (DigiCert and Sectigo): `0847caae8082d3bdac4d469b8c74f8ed23a6b11a81fa283ba28a5d3188acf247` for the bundle committed on 2026-09-25. `tests/engine-v3-witness.test.mjs` recomputes it.
- The environment is immutable once set. Production refuses weaker thresholds than ADR 0002 §3, fewer than two witnesses, or a missing bundle ID.

Create the service logins, with secrets held only in each service's secret manager:

```sql
create role smartprofit_engine_worker login password '<secret>' in role engine_tick_writer;
create role smartprofit_witness_attestor login password '<secret>' in role engine_witness_attestor;
```

Use **session-mode** connections (direct, or the pooler's session mode). Transaction pooling breaks the worker's single-writer advisory lock.

## 5. Signing key

```
ENGINE_CUSTODY=kms:aws ENGINE_KMS_KEY_ID=<arn> AWS_REGION=<region> \
ENGINE_SIGNING_KEY_FILE=/secrets/signing-key.json \
node engine/v3/service/main.mjs --init-signing-key ed25519-2026-10-1
```

The printed public key goes into `verifier/v3/trusted-keys.json` in a reviewed commit. The manifest is append-only: a retired key stays listed so history remains verifiable. Never commit a placeholder or test key as a production key.

## 6. Worker

```
ENGINE_DATABASE_URL=... ENGINE_CUSTODY=kms:aws ENGINE_KMS_KEY_ID=... AWS_REGION=... \
ENGINE_SIGNING_KEY_FILE=/secrets/signing-key.json ENGINE_PARAMS_FILE=/config/params.json \
ENGINE_WITNESSES=digicert,sectigo npm run start:engine-v3-worker
```

**Preflight** (exit 3) refuses to start on any of:
- local custody in production;
- unreachable KMS (a round trip is tested);
- an empty trust manifest, or a manifest without the worker's own key;
- a required witness that is missing or has no roots;
- missing parameters;
- a non-DEMO mode.

The parameters file lists every index with `annual_vol_bp`, `anchor_units`, `kappa_e12`, `min_units`, `max_units`, `genesis_tick_no` and `genesis_units` (ADR 0001 §3).
- `genesis_tick_no` is `floor((D_ms - 1 - t0_ms) / tick_interval_ms)` for the day `D` the index's v3 series starts.
- A changed file creates a new configuration for epochs committed afterwards. Keep each live index's genesis values unchanged when rotating.

## 7. Attestor

```
ENGINE_ATTESTOR_DATABASE_URL=... node engine/v3/service/attestor-main.mjs
```

It verifies every submitted token against `verifier/v3/tsa-roots.json` and records valid, late or invalid. It exits 3 if its bundle ID differs from the configured one (`engine_v3_root_bundle_mismatch`).

## 8. Shadow run

1. Set every index's `genesis_tick_no` to the last tick before shadow day `D`, at least 24 h ahead.
2. Once the day-`D` epoch is witnessed (see `get_admin_engine_v3_health`, where `tradable` must be true), call `engine_v3_set_shadow('DEMO', '<index>', true, '<reason>')` for each index.
3. Run for at least 7 complete days, then collect the report:
   `ENGINE_REPORT_DATABASE_URL=<read-only> npm run report:engine-v3-soak -- --shadow --days 7`

## 9. Practice cutover

1. Choose `D2` at least 48 h ahead. Set the index's `genesis_tick_no` to the last tick before `D2` and deploy the parameters.
2. When the `D2` epoch is committed **and** attested on time, call `engine_v3_schedule_cutover('DEMO', '<index>', <D2_ms>, '<reason>')`. From then on, v2 buys that would end after the final tick are refused, and v2 stops at that tick.
3. Announce the effective tick (`genesis + 1`), the time, the version and the new 10000.000 series.
4. At `D2` the worker activates the cutover once the last v2 tick is final and no v2 contract is open.
5. In the same release, update the "No index uses version 3 yet" paragraph in `pages/guide-fairness.html`.

## 10. Alerts and thresholds

| Signal (from `get_admin_engine_v3_health` / `get_admin_engine_v3_witnesses`) | Alert when | Customer effect |
| --- | --- | --- |
| Worker heartbeat | older than 10 s, or drift above 1 s | purchases blocked (`engine_worker_unhealthy`) |
| Tick lag | more than 6 s behind schedule | purchases blocked (`feed_stale`) |
| Tomorrow's epoch | not `tradable` by 12 h before its start | none yet; page on-call |
| Witness verdicts | any `invalid` or `late` | that epoch or checkpoint is not tradable |
| Checkpoints | none attested within 300 ticks | purchases blocked (`engine_checkpoint_stale`) |
| Reveal | `reveal_overdue` | proof stays partial |
| Volatility | `alert` on the 1-day window | investigate. Never change parameters in response to customer P/L. |
| Attestation writes | any row not written by the attestor role | security incident |

## 11. Incidents, rollback and void

| Event | Automatic behaviour | Operator action |
| --- | --- | --- |
| KMS outage | No ticks; purchases fail. Late exit ticks lead to a policy VOID and refund. | Restore KMS. The worker catches up deterministically. Confirm the chain in health. |
| TSA outage | Ticks continue. Purchases in an unwitnessed epoch or after a stale checkpoint fail. | The worker retries. A receipt that arrives after the deadline stays **late**, and that day remains untradable. Do not relax witnesses; production refuses. |
| Attestor down | Submissions queue as pending. Purchases fail once checkpoints go stale. | Restart the attestor. It drains the queue. |
| Worker crash or lost reply | None. A restart continues from the database. The stored tick is authoritative. | A `engine_v3_nondeterminism_detected` exit is severity 1. |
| Price band breach | Index halted; unproducible contracts refunded | Investigate. Resuming needs a new cutover. |
| Suspected seed, worker or attestor compromise | — | Halt every index (`engine_v3_halt`) and refund (`engine_v3_void_unproducible`). Rotate the KMS policy and roles, retire the signing key (add a new key to the manifest), and rotate attestor credentials. Disclose. Recommit from a new cutover. History is never rewritten. |
| Rollback before cutover | — | Turn shadow off. v2 is unaffected. |
| Rollback after cutover | — | Announce a new cutover to a new configuration or version. v3 ticks stay immutable, and settled contracts are never re-settled. |

**Root rotation (TSA certificates).**
1. Add the new root to `tsa-roots.json` through a reviewed commit.
2. Compute the new bundle ID and redeploy the attestor and the site together.
3. Update `tsa_root_bundle_id` with `engine_v3_configure`.

Keep old roots in the file for as long as history signed under them must verify.

**Key rotation.** Add the new key to the manifest first, then switch the worker's signing key. Never remove an old key.

## 12. Evidence

`npm run accept:engine-v3` reports `CODE_READY`, and `npm run accept:engine-v3:practice` reports `PRACTICE_READY`. Operational rows turn MET only when `docs/evidence/<name>.json` passes `scripts/engine-v3-evidence.mjs`. Each file needs:
- `summary`, `environment`, `performed_by`, and `reviewed_by` (a different person);
- `reviewed_at` (after the window);
- `source_commit` (a full hash);
- `interval.start` and `interval.end` (UTC);
- `artifacts`, each either a repository path with its SHA-256, or an `https` URL with a SHA-256 or immutable reference and an independent `reviewed_by`;
- measured `results` that meet the thresholds for that type:

| File | Environment | Minimum window | Required results |
| --- | --- | --- | --- |
| `code-review.json` | repository | — | `reviewed_commit`, `scope`, `findings_resolved: true` |
| `kms-provisioning.json` | production | — | `key_arn`, `admin_decrypt_denied`, `foreign_decrypt_alert_fired`, `cloudtrail_data_events` |
| `worker-deployment.json` | production | — | `custody_provider: kms:aws`, `separate_cloud_account`, `attestor_separate_credentials`, `preflight_passed`, `published_key_id` (must be in the manifest) |
| `shadow-run.json` | production | 7 days | `sequence_gaps: 0`, every epoch witnessed before its deadline, `max_checkpoint_gap_ticks <= 300`, `lag_p99_seconds <= 6` |
| `live-drills.json` | staging | — | drills `kms_revoke`, `tsa_block`, `worker_kill`, `clock_skew`, `lost_reply`, each `as_documented` with the observed outcome |
| `practice-soak.json` | production | 7 days | every index `within_band`, `settlement_reconciled`, `browser_cli_verdicts_agree`, `cutover_effective_tick` |

This validation is structural, not cryptographic proof that the work happened. Record only work that happened, over real elapsed time.
