# Price model version 2: rollout and scheduled start

Migration `20260920560000` adds version 2 of the price generator but changes no live price when applied. Every index keeps producing version 1 ticks, with its version 1 `sigma_per_tick` and `kappa`, until its own `v2_start_tick_no`. The version 2 parameters are stored separately (`v2_sigma_per_tick`, `v2_kappa`) and only apply from that tick. The v3 migrations keep the same rule. `tests/engine-v2-cutover.test.mjs` applies the pending chain to a database in the live state and checks, tick by tick, that the series continues exactly as version 1.

## 1. Release (no price change)

1. `supabase db push --dry-run` lists `20260920560000` and the four `202609241*`/`20260925*` v3 migrations. Nothing else should be pending.
2. `supabase db push`.
3. Check, as the database owner:
   ```sql
   select code, v2_start_tick_no, v2_sigma_per_tick, v2_kappa from public.engine_indices order by code;  -- start is null everywhere
   select generation_version, count(*) from public.index_ticks where generated_at > now() - interval '5 minutes' group by 1;  -- only 1
   ```
4. Deploy the site (`vercel deploy --prod`). The fairness page now reads `get_tick_verification_data`, which exists only after step 2. Never deploy the site first.

## 2. Schedule the start

The start must be the beginning of a UTC day at least 12 hours ahead, so it can be announced. The first version 2 tick is the first tick scheduled at or after that time, and it continues from the last version 1 price.

- Staff (engine manager, TOTP verified in the last 10 minutes), through the API:
  `engine_schedule_v2_start('DEMO', '<index>', '<YYYY-MM-DD>T00:00:00Z', '<reason>')`
- Database owner, in the SQL editor (audited as an operator):
  ```sql
  select engine_private.operator_schedule_v2_start('DEMO', code, '<YYYY-MM-DD>T00:00:00Z', '<reason, 10-500 characters>')
  from public.engine_indices where execution_mode = 'DEMO' order by sort_order;
  ```

Each call returns the start tick and writes `engine.schedule_v2_start` to `admin_audit_events`. A start can be moved (same call) until it is reached. After that the call fails with `engine_v2_already_started`.

`get_engine_config` returns each index's `v2_starts_at`. The trade page shows the scheduled change for the selected index until it takes effect. Announce it in any other customer channels too.

## 3. At the start

Nothing to do. From the start tick, `engine_advance` generates version 2 ticks. Check:
```sql
select index_code, min(tick_no) from public.index_ticks where generation_version = 2 group by 1;  -- equals v2_start_tick_no
```
The fairness page verifies version 1 and version 2 ticks, including the first version 2 tick against the last version 1 price.

## Rollback

- Before the start: move the start to a later day with the same call. There is no "unschedule" call. To cancel, the database owner can set `v2_start_tick_no = null`, provided no version 2 tick exists yet; record the reason in `admin_audit_events`.
- After the start: published ticks are never rewritten. Returning to version 1 would need a new forward migration and its own announced start.
