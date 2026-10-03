-- Engine v3, specification v3.1 (docs/adr/0001-synthetic-engine-v3.md sections 3,
-- 5.6 and 5.7): anchorless configurations, a per-tick move limit enforced when a
-- tick is published, and an announced resume of a paused or halted index, with an
-- optional x10 or /10 rescale. Forward-only. Nothing v1/v2 is touched, and the
-- live indices keep running on version 2: v3 configurations are committed by the
-- engine worker, which sets kappa_e12 = 0 from its parameters file.
--
-- A resume is always a new configuration committed before its epoch (at least
-- min_commit_lead_ms ahead, witnessed like any other). Its genesis price must be
-- the index's last published price times 10, unchanged, or divided by 10
-- (floored). A planned rescale pauses the index rescale_pause_lead_ms before the
-- epoch, so the last price is known when the configuration is committed. No tick
-- is produced during the pause, and purchases that would end in it are refused.

set lock_timeout = '15s';

alter table public.engine_v3_settings add column rescale_pause_lead_ms bigint not null default 4500000
 check (rescale_pause_lead_ms >= 600000);

create table public.engine_v3_resumes (
 id bigint generated always as identity primary key,
 execution_mode public.execution_mode not null,
 index_code text not null,
 kind text not null check (kind in ('rescale','resume')),
 epoch_start_ms bigint not null check (epoch_start_ms % 86400000 = 0),
 pause_after_tick_no bigint not null,
 genesis_tick_no bigint not null,
 exponent smallint not null check (exponent in (-1,0,1)),
 genesis_units bigint,
 status text not null default 'scheduled' check (status in ('scheduled','committed','applied','missed')),
 reason text not null,
 scheduled_by text not null,
 scheduled_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 check (genesis_tick_no >= pause_after_tick_no)
);
create unique index engine_v3_resumes_open on public.engine_v3_resumes(execution_mode,index_code) where status in ('scheduled','committed');
alter table public.engine_v3_resumes enable row level security;
revoke all on public.engine_v3_resumes from public,anon,authenticated,service_role;

-- ---------------------------------------------------------------- exact helpers (match engine/v3/generator.mjs)
-- Largest |next - prev| the section 5.3 transition can produce: the rounded coarse
-- move at |Z| = 786420 plus the widest jitter of 5 units.
create or replace function engine_private.v3_max_move_units(p_entry jsonb,p_prev bigint) returns numeric
language sql immutable set search_path='' as $$
 select 10*floor((p_prev::numeric*(p_entry->>'sigma_e12')::numeric*786420
   +(p_entry->>'kappa_e12')::numeric*abs((p_entry->>'anchor_units')::numeric-p_prev)*131072
   +5*1000000000000::numeric*131072)/(10*1000000000000::numeric*131072))+5
$$;

create or replace function engine_private.v3_rescale_units(p_units bigint,p_exponent smallint) returns bigint
language sql immutable set search_path='' as $$
 select case p_exponent when 1 then p_units*10 when 0 then p_units when -1 then floor(p_units::numeric/10)::bigint end
$$;

-- ---------------------------------------------------------------- scheduling
-- The direction is computed, never chosen: below a tenth of the anchor the price
-- is scaled up, above ten times the anchor it is scaled down. A running index can
-- only be rescaled when it is outside that range; a halted index can also resume
-- unchanged. The epoch must not be committed yet, and a planned rescale needs a
-- day's notice.
create or replace function engine_private.v3_schedule_resume(p_mode public.execution_mode,p_index text,p_epoch_start_ms bigint,p_actor text,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare i public.engine_indices%rowtype; st public.index_state%rowtype; s public.engine_v3_settings%rowtype;
 v_entry jsonb; v_last_epoch bigint; v_t0 bigint; v_units bigint; v_anchor bigint; v_exp smallint; v_pause bigint; v_genesis bigint; v_kind text; v_id bigint;
begin
 if char_length(btrim(coalesce(p_reason,'')))<10 then raise exception 'validation_failed'; end if;
 if p_mode<>'DEMO' then raise exception 'engine_v3_practice_only'; end if;
 select * into s from public.engine_v3_settings;
 select * into i from public.engine_indices where code=p_index and execution_mode=p_mode for update;
 if not found or i.engine_generation<>3 then raise exception 'index_not_available'; end if;
 if p_epoch_start_ms % 86400000<>0 then raise exception 'engine_v3_resume_not_boundary'; end if;
 if exists(select 1 from public.engine_v3_resumes r where r.execution_mode=p_mode and r.index_code=p_index and r.status in ('scheduled','committed')) then
  raise exception 'engine_v3_resume_already_scheduled';
 end if;
 select max(e.epoch_start_ms) into v_last_epoch from public.engine_v3_epochs e where e.execution_mode=p_mode;
 if v_last_epoch is null or p_epoch_start_ms<=v_last_epoch then raise exception 'engine_v3_resume_epoch_committed'; end if;
 select engine_private.v3_entry(e.config_hash,p_index) into v_entry from public.engine_v3_epochs e where e.execution_mode=p_mode and e.epoch_start_ms=v_last_epoch;
 if v_entry is null then raise exception 'engine_v3_config_index_mismatch'; end if;
 select * into st from public.index_state where index_code=p_index and execution_mode=p_mode;
 v_t0:=engine_private.v3_t0_ms(i.t0);
 v_units:=round(st.last_price*power(10::numeric,i.decimals))::bigint;
 v_anchor:=(v_entry->>'anchor_units')::bigint;
 v_exp:=case when v_units*10<v_anchor then 1 when v_units>v_anchor*10 then -1 else 0 end;
 v_genesis:=floor((p_epoch_start_ms-1-v_t0)::numeric/i.tick_interval_ms)::bigint;
 if i.v3_halted_at is not null then
  v_kind:='resume'; v_pause:=st.last_tick_no;
 else
  if v_exp=0 then raise exception 'engine_v3_rescale_not_due'; end if;
  if p_epoch_start_ms-engine_private.v3_now_ms()<86400000 then raise exception 'engine_v3_resume_notice_too_short'; end if;
  v_kind:='rescale';
  v_pause:=floor((p_epoch_start_ms-s.rescale_pause_lead_ms-v_t0)::numeric/i.tick_interval_ms)::bigint;
  if v_pause<=st.last_tick_no then raise exception 'engine_v3_resume_too_late'; end if;
 end if;
 insert into public.engine_v3_resumes(execution_mode,index_code,kind,epoch_start_ms,pause_after_tick_no,genesis_tick_no,exponent,reason,scheduled_by)
  values(p_mode,p_index,v_kind,p_epoch_start_ms,v_pause,v_genesis,v_exp,btrim(p_reason),p_actor) returning id into v_id;
 perform engine_private.v3_log(p_actor,'schedule_'||v_kind,p_mode,p_index,jsonb_build_object('epoch_start_ms',p_epoch_start_ms,
  'pause_after_tick_no',v_pause,'genesis_tick_no',v_genesis,'exponent',v_exp,'reason',btrim(p_reason)));
 return jsonb_build_object('id',v_id,'kind',v_kind,'epoch_start_ms',p_epoch_start_ms::text,'pause_after_tick_no',v_pause::text,'genesis_tick_no',v_genesis::text,'exponent',v_exp);
end; $$;

-- Staff (engine manager, TOTP verified in the last 10 minutes), through the API.
create or replace function public.engine_v3_schedule_rescale(p_mode public.execution_mode,p_index text,p_epoch_start_ms bigint,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor public.staff_roles;
begin
 v_actor:=admin_private.require_staff('engine.manage',true);
 return engine_private.v3_schedule_resume(p_mode,p_index,p_epoch_start_ms,'staff:'||v_actor.user_id,p_reason);
end; $$;

-- The database owner, from the SQL editor.
create or replace function engine_private.operator_schedule_rescale(p_mode public.execution_mode,p_index text,p_epoch_start_ms bigint,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 return engine_private.v3_schedule_resume(p_mode,p_index,p_epoch_start_ms,'operator',p_reason);
end; $$;

-- ---------------------------------------------------------------- worker RPCs
create or replace function public.engine_v3_resume_plan(p_mode public.execution_mode) returns jsonb
language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('index',r.index_code,'kind',r.kind,'epoch_start_ms',r.epoch_start_ms::text,
  'pause_after_tick_no',r.pause_after_tick_no::text,'genesis_tick_no',r.genesis_tick_no::text,'exponent',r.exponent,
  'genesis_units',r.genesis_units::text,'status',r.status) order by r.epoch_start_ms),'[]'::jsonb)
 from public.engine_v3_resumes r where r.execution_mode=p_mode and r.status in ('scheduled','committed')
$$;

-- The worker could not commit a scheduled resume in time. The index is not
-- rescaled and continues from where it paused; staff may schedule it again.
create or replace function public.engine_v3_miss_resume(p_mode public.execution_mode,p_index text,p_reason text) returns void
language plpgsql security definer set search_path='' as $$
begin
 update public.engine_v3_resumes set status='missed',updated_at=now()
  where execution_mode=p_mode and index_code=p_index and status='scheduled';
 if found then perform engine_private.v3_log('worker','miss_resume',p_mode,p_index,jsonb_build_object('reason',left(coalesce(p_reason,''),500))); end if;
end; $$;

-- Announcements for the site: every rescale or resume not yet applied.
create or replace function public.get_engine_v3_rescales() returns jsonb
language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('index',r.index_code,'mode',r.execution_mode,'kind',r.kind,
  'pause_from',to_timestamp((r.epoch_start_ms-s.rescale_pause_lead_ms)/1000.0),'resume_at',to_timestamp(r.epoch_start_ms/1000.0),
  'factor',case r.exponent when 1 then '10' when -1 then '1/10' else '1' end,'status',r.status) order by r.epoch_start_ms),'[]'::jsonb)
 from public.engine_v3_resumes r cross join public.engine_v3_settings s where r.status in ('scheduled','committed')
$$;

-- ---------------------------------------------------------------- epoch commitment
-- As before, plus: a scheduled resume for this epoch must be matched exactly by
-- the configuration (genesis at the last tick before the epoch, price = last
-- published price x 10^exponent), and a running v3 index may not change its
-- genesis without one.
create or replace function public.engine_v3_commit_epoch(
 p_mode public.execution_mode,p_epoch_start_ms bigint,p_config_hash bytea,p_seed_hash bytea,p_prev_commitment bytea,p_commitment bytea,
 p_signing_key_id text,p_signature bytea,p_custody_provider text,p_key_ref text,p_ciphertext bytea
) returns void language plpgsql security definer set search_path='' as $$
declare v_env text:=engine_private.v3_env(); s public.engine_v3_settings%rowtype; last public.engine_v3_epochs%rowtype; existing public.engine_v3_epochs%rowtype; v_known boolean;
 r public.engine_v3_resumes%rowtype; st public.index_state%rowtype; i public.engine_indices%rowtype; v_entry jsonb; v_prev_entry jsonb; v_units bigint;
begin
 select * into s from public.engine_v3_settings;
 select * into existing from public.engine_v3_epochs where execution_mode=p_mode and epoch_start_ms=p_epoch_start_ms;
 if found then
  if existing.commitment=p_commitment then return; end if;
  raise exception 'engine_v3_epoch_conflict';
 end if;
 if v_env='production' and p_custody_provider not like 'kms:%' then raise exception 'engine_v3_custody_not_allowed'; end if;
 if engine_private.v3_now_ms()>p_epoch_start_ms-s.min_commit_lead_ms then raise exception 'engine_v3_commitment_late'; end if;
 select exists(select 1 from public.engine_v3_configs where config_hash=p_config_hash and execution_mode=p_mode and env=v_env) into v_known;
 if not v_known then raise exception 'engine_v3_config_unknown'; end if;
 select * into last from public.engine_v3_epochs where execution_mode=p_mode order by epoch_start_ms desc limit 1;
 if found then
  if p_epoch_start_ms<>last.epoch_start_ms+86400000 or p_prev_commitment<>last.commitment then raise exception 'engine_v3_epoch_chain_broken'; end if;
 elsif p_prev_commitment<>'\x0000000000000000000000000000000000000000000000000000000000000000'::bytea then raise exception 'engine_v3_epoch_chain_broken';
 end if;
 if engine_private.v3_epoch_commitment(v_env,p_mode::text,p_epoch_start_ms,p_seed_hash,p_config_hash,p_prev_commitment)<>p_commitment then raise exception 'engine_v3_commitment_mismatch'; end if;

 for i in select * from public.engine_indices where execution_mode=p_mode and engine_generation=3 loop
  v_entry:=engine_private.v3_entry(p_config_hash,i.code);
  select * into r from public.engine_v3_resumes where execution_mode=p_mode and index_code=i.code and epoch_start_ms=p_epoch_start_ms and status='scheduled' for update;
  if found then
   select * into st from public.index_state where index_code=i.code and execution_mode=p_mode;
   if st.last_tick_no<>r.pause_after_tick_no then raise exception 'engine_v3_resume_pause_not_reached'; end if;
   v_units:=engine_private.v3_rescale_units(round(st.last_price*power(10::numeric,i.decimals))::bigint,r.exponent);
   if v_entry is null or (v_entry->>'genesis_tick_no')::bigint<>r.genesis_tick_no or (v_entry->>'genesis_units')::bigint<>v_units then
    raise exception 'engine_v3_resume_config_mismatch';
   end if;
   if v_units<(v_entry->>'min_units')::bigint or v_units>(v_entry->>'max_units')::bigint then raise exception 'engine_v3_price_out_of_band'; end if;
   update public.engine_v3_resumes set status='committed',genesis_units=v_units,updated_at=now() where id=r.id;
  elsif last.config_hash is not null then
   v_prev_entry:=engine_private.v3_entry(last.config_hash,i.code);
   if v_entry is null or v_prev_entry is null
    or (v_entry->>'genesis_tick_no')<>(v_prev_entry->>'genesis_tick_no') or (v_entry->>'genesis_units')<>(v_prev_entry->>'genesis_units') then
    raise exception 'engine_v3_resume_unscheduled';
   end if;
  end if;
 end loop;

 insert into public.engine_v3_epochs(execution_mode,epoch_start_ms,epoch_end_ms,config_hash,seed_hash,prev_commitment,commitment,signing_key_id,signature)
  values(p_mode,p_epoch_start_ms,p_epoch_start_ms+86400000,p_config_hash,p_seed_hash,p_prev_commitment,p_commitment,p_signing_key_id,p_signature);
 insert into engine_private.v3_wrapped_seeds values(p_mode,p_epoch_start_ms,p_custody_provider,p_key_ref,p_ciphertext);
 perform engine_private.v3_log('worker','commit_epoch',p_mode,null,jsonb_build_object('epoch_start_ms',p_epoch_start_ms,'commitment',encode(p_commitment,'hex')));
end; $$;

-- ---------------------------------------------------------------- tick publication
-- As before, plus: no tick inside a scheduled pause; the first tick after a
-- committed resume may follow the pause (or a halt) and clears the halt; and no
-- tick may move further than the model can (section 5.7).
create or replace function public.engine_v3_publish_tick(
 p_mode public.execution_mode,p_index text,p_tick_no bigint,p_scheduled_ms bigint,p_generated_ms bigint,
 p_prev_units bigint,p_price_units bigint,p_digit smallint,p_tick_hash bytea
) returns text language plpgsql security definer set search_path='' as $$
declare v_env text:=engine_private.v3_env(); s public.engine_v3_settings%rowtype; i public.engine_indices%rowtype; e public.engine_v3_epochs%rowtype;
 v_now bigint:=engine_private.v3_now_ms(); v_shadow boolean; v_entry jsonb; v_epoch bigint; v_existing bytea; v_prev_units bigint; v_prev_hash bytea;
 v_hash bytea; v_factor numeric; v_decimals smallint; v_genesis bigint; v_state_last bigint; rs public.engine_v3_resumes%rowtype; v_resuming boolean:=false;
begin
 select * into s from public.engine_v3_settings;
 select * into i from public.engine_indices where code=p_index and execution_mode=p_mode for update;
 if not found then raise exception 'index_not_available'; end if;
 if i.engine_generation=3 then v_shadow:=false; elsif i.v3_shadow then v_shadow:=true; else raise exception 'engine_v3_not_enabled'; end if;
 if not v_shadow then
  select * into rs from public.engine_v3_resumes where execution_mode=p_mode and index_code=p_index and status in ('scheduled','committed');
  if found then
   if p_tick_no>rs.pause_after_tick_no and p_tick_no<=rs.genesis_tick_no then raise exception 'engine_v3_rescale_pause'; end if;
   v_resuming:=rs.status='committed' and p_tick_no=rs.genesis_tick_no+1;
  end if;
 end if;
 if i.v3_halted_at is not null and not v_resuming then raise exception 'engine_v3_halted'; end if;
-- An identical retry always succeeds; a different record for a stored tick never does.
 if v_shadow then
  select t.v3_tick_hash into v_existing from public.engine_v3_shadow_ticks t where t.index_code=p_index and t.execution_mode=p_mode and t.tick_no=p_tick_no;
 else
  select t.v3_tick_hash into v_existing from public.index_ticks t where t.index_code=p_index and t.execution_mode=p_mode and t.tick_no=p_tick_no;
 end if;
 if found then
  if v_existing=p_tick_hash then return 'duplicate'; end if;
  raise exception 'engine_v3_tick_conflict';
 end if;
 if abs(p_generated_ms-v_now)>s.max_clock_drift_ms then raise exception 'engine_v3_clock_drift'; end if;
 if p_scheduled_ms>v_now then raise exception 'engine_v3_future_tick'; end if;
 v_epoch:=p_scheduled_ms/86400000*86400000;
 select * into e from public.engine_v3_epochs where execution_mode=p_mode and epoch_start_ms=v_epoch;
 if not found then raise exception 'engine_v3_epoch_uncommitted'; end if;
 if engine_private.v3_t0_ms(e.committed_at)>=p_scheduled_ms then raise exception 'engine_v3_commitment_late'; end if;
 v_entry:=engine_private.v3_entry(e.config_hash,p_index);
 if v_entry is null then raise exception 'engine_v3_config_index_mismatch'; end if;
 if p_scheduled_ms<>(v_entry->>'t0_ms')::bigint+p_tick_no*(v_entry->>'tick_interval_ms')::bigint then raise exception 'engine_v3_schedule_mismatch'; end if;
 v_genesis:=(v_entry->>'genesis_tick_no')::bigint;
 if p_tick_no<=v_genesis then raise exception 'engine_v3_before_genesis'; end if;
 v_decimals:=(v_entry->>'decimals')::smallint; v_factor:=power(10::numeric,v_decimals);

 if p_tick_no=v_genesis+1 then
  v_prev_units:=(v_entry->>'genesis_units')::bigint;
  v_prev_hash:=engine_private.v3_genesis_hash(v_env,p_mode::text,p_index,v_genesis,v_prev_units,e.config_hash);
 elsif v_shadow then
  select round(t.price*v_factor)::bigint,t.v3_tick_hash into v_prev_units,v_prev_hash from public.engine_v3_shadow_ticks t where t.index_code=p_index and t.execution_mode=p_mode and t.tick_no=p_tick_no-1;
 else
  select round(t.price*v_factor)::bigint,t.v3_tick_hash into v_prev_units,v_prev_hash from public.index_ticks t where t.index_code=p_index and t.execution_mode=p_mode and t.tick_no=p_tick_no-1 and t.generation_version=3;
 end if;
 if v_prev_hash is null then raise exception 'engine_v3_sequence_gap'; end if;
 if not v_shadow then
  select last_tick_no into v_state_last from public.index_state where index_code=p_index and execution_mode=p_mode for update;
  if v_resuming then
   if v_state_last<>rs.pause_after_tick_no or v_genesis<>rs.genesis_tick_no or v_prev_units<>rs.genesis_units then raise exception 'engine_v3_resume_mismatch'; end if;
  elsif v_state_last<>p_tick_no-1 then raise exception 'engine_v3_sequence_gap';
  end if;
 end if;
 if p_prev_units<>v_prev_units then raise exception 'engine_v3_prev_mismatch'; end if;
 if p_digit<>p_price_units%10 then raise exception 'engine_tick_digit_mismatch'; end if;
 if abs(p_price_units-p_prev_units)>engine_private.v3_max_move_units(v_entry,p_prev_units) then raise exception 'engine_v3_move_out_of_bound'; end if;
 if p_price_units<(v_entry->>'min_units')::bigint or p_price_units>(v_entry->>'max_units')::bigint then raise exception 'engine_v3_price_out_of_band'; end if;
 v_hash:=engine_private.v3_tick_hash(v_env,p_mode::text,p_index,p_tick_no,p_scheduled_ms,p_generated_ms,v_epoch,p_prev_units,p_price_units,v_decimals,p_digit,e.config_hash,e.commitment,v_prev_hash);
 if v_hash<>p_tick_hash then raise exception 'engine_v3_tick_hash_mismatch'; end if;

 if v_shadow then
  insert into public.engine_v3_shadow_ticks(index_code,execution_mode,tick_no,scheduled_at,price,digit,previous_price,v3_epoch_start_ms,v3_generated_ms,v3_config_hash,v3_commitment,v3_prev_tick_hash,v3_tick_hash)
   values(p_index,p_mode,p_tick_no,to_timestamp(p_scheduled_ms/1000.0),p_price_units/v_factor,p_digit,p_prev_units/v_factor,v_epoch,p_generated_ms,e.config_hash,e.commitment,v_prev_hash,v_hash);
  return 'shadow';
 end if;
 insert into public.index_ticks(index_code,execution_mode,tick_no,epoch_id,scheduled_at,price,digit,generation_version,previous_price,generation_decimals,
  v3_epoch_start_ms,v3_generated_ms,v3_config_hash,v3_commitment,v3_prev_tick_hash,v3_tick_hash)
  values(p_index,p_mode,p_tick_no,null,to_timestamp(p_scheduled_ms/1000.0),p_price_units/v_factor,p_digit,3,p_prev_units/v_factor,v_decimals,
  v_epoch,p_generated_ms,e.config_hash,e.commitment,v_prev_hash,v_hash);
 update public.index_state set last_tick_no=p_tick_no,last_price=p_price_units/v_factor,last_x=ln(p_price_units/v_factor),updated_at=now()
  where index_code=p_index and execution_mode=p_mode;
 if v_resuming then
  update public.engine_v3_resumes set status='applied',updated_at=now() where id=rs.id;
  update public.engine_indices set v3_halted_at=null,v3_halt_reason=null where code=p_index and execution_mode=p_mode;
  perform engine_private.v3_log('worker','resume',p_mode,p_index,jsonb_build_object('tick_no',p_tick_no,'kind',rs.kind,'exponent',rs.exponent,'genesis_units',rs.genesis_units));
 end if;
 perform public.engine_settle_tick(p_index,p_mode,p_tick_no);
 return 'published';
end; $$;

-- ---------------------------------------------------------------- purchase gate
-- As before, plus: no contract whose ticks would fall in a scheduled pause.
create or replace function engine_private.v3_purchase_block(p_mode public.execution_mode,p_index text,p_entry_tick bigint,p_settle_tick bigint) returns text
language plpgsql stable security definer set search_path='' as $$
declare i public.engine_indices%rowtype; st public.index_state%rowtype; s public.engine_v3_settings%rowtype; v_t0 bigint; v_now bigint:=engine_private.v3_now_ms();
 v_entry_ms bigint; v_settle_ms bigint; v_cp bigint; v_genesis bigint; v_healthy boolean;
begin
 select * into i from public.engine_indices where code=p_index and execution_mode=p_mode;
 if i.engine_generation=2 then
  if i.v2_final_tick_no is not null and p_settle_tick>i.v2_final_tick_no then return 'engine_generation_cutover'; end if;
  return null;
 end if;
 select * into s from public.engine_v3_settings;
 if s.env is null then return 'engine_v3_environment_unset'; end if;
 if i.v3_halted_at is not null then return 'index_not_available'; end if;
 if exists(select 1 from public.engine_v3_resumes r where r.execution_mode=p_mode and r.index_code=p_index and r.status in ('scheduled','committed')
   and p_settle_tick>r.pause_after_tick_no and p_entry_tick<=r.genesis_tick_no) then return 'engine_v3_rescale_pause'; end if;
 select * into st from public.index_state where index_code=p_index and execution_mode=p_mode;
 v_t0:=engine_private.v3_t0_ms(i.t0);
 if v_now-(v_t0+st.last_tick_no*i.tick_interval_ms)>s.max_tick_lag_ms then return 'feed_stale'; end if;
 select exists(select 1 from public.engine_v3_worker_heartbeats where last_seen>now()-make_interval(secs=>s.heartbeat_timeout_ms/1000.0) and abs(clock_drift_ms)<=s.max_clock_drift_ms) into v_healthy;
 if not v_healthy then return 'engine_worker_unhealthy'; end if;
 v_entry_ms:=v_t0+p_entry_tick*i.tick_interval_ms; v_settle_ms:=v_t0+p_settle_tick*i.tick_interval_ms;
 if not engine_private.v3_epoch_attested(p_mode,v_entry_ms/86400000*86400000)
  or not engine_private.v3_epoch_attested(p_mode,v_settle_ms/86400000*86400000) then return 'engine_unwitnessed'; end if;
 -- Latest checkpoint that every required TSA attested before now.
 select max(c.tick_no) into v_cp from public.engine_v3_checkpoints c where c.execution_mode=p_mode and c.index_code=p_index and not c.shadow
  and not exists(select 1 from unnest(s.required_witnesses) p(provider) where not exists(
   select 1 from public.engine_v3_witness_submissions ws join public.engine_v3_witness_attestations a on a.submission_id=ws.id
   where ws.subject_hash=c.checkpoint_hash and ws.provider=p.provider and a.verdict='valid' and a.gen_time_ms<v_now));
 select (engine_private.v3_entry(e.config_hash,p_index)->>'genesis_tick_no')::bigint into v_genesis from public.engine_v3_epochs e
  where e.execution_mode=p_mode and e.epoch_start_ms=v_entry_ms/86400000*86400000;
 if st.last_tick_no-coalesce(v_cp,v_genesis,st.last_tick_no)>s.max_checkpoint_gap_ticks then return 'engine_checkpoint_stale'; end if;
 return null;
end; $$;

-- ---------------------------------------------------------------- grants
do $$
declare f record;
begin
 for f in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where (n.nspname='public' and p.proname in ('engine_v3_schedule_rescale','engine_v3_resume_plan','engine_v3_miss_resume','get_engine_v3_rescales'))
     or (n.nspname='engine_private' and p.proname in ('v3_max_move_units','v3_rescale_units','v3_schedule_resume','operator_schedule_rescale')) loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',f.sig);
 end loop;
end $$;
grant execute on function public.engine_v3_resume_plan(public.execution_mode),public.engine_v3_miss_resume(public.execution_mode,text,text) to engine_tick_writer;
grant execute on function public.engine_v3_schedule_rescale(public.execution_mode,text,bigint,text),public.get_engine_v3_rescales() to authenticated;
