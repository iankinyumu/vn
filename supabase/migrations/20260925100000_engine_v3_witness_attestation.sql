-- Engine v3: independent witness attestation, canonical witness deadlines,
-- witnessed checkpoints and multi-config proof export
-- (docs/CLAUDE_ENGINE_V3_PRODUCTION_FIX.md). Forward-only: earlier v3 rows and
-- engine_v3_witness_receipts stay as they were; nothing v1/v2 is touched.
--
-- Trust boundary: the tick writer may only SUBMIT raw RFC 3161 tokens. Its
-- claimed genTime is ignored. A separate role, engine_witness_attestor, which the
-- writer cannot use, validates each token against the pinned roots and records a
-- verdict bound to the token hash, root bundle id, subject, provider and
-- deadline. Purchase gates read attestations only.

do $$ begin
 if not exists(select 1 from pg_roles where rolname='engine_witness_attestor') then create role engine_witness_attestor nologin; end if;
end $$;
grant usage on schema public to engine_witness_attestor;

alter table public.engine_v3_settings add column tsa_root_bundle_id bytea check (tsa_root_bundle_id is null or octet_length(tsa_root_bundle_id)=32);

-- ---------------------------------------------------------------- deadline
-- The first scheduled tradable v3 tick of the epoch, over every index in the
-- epoch's committed configuration: max(genesis+1, first tick at or after the
-- epoch start). Depends only on committed values (config hash and epoch start
-- are inside the commitment), so it cannot change after publication.
create or replace function engine_private.v3_witness_deadline(p_config_hash bytea,p_epoch_start_ms bigint) returns bigint
language sql stable security definer set search_path='' as $$
 select min(greatest(
   (x->>'t0_ms')::bigint+((x->>'genesis_tick_no')::bigint+1)*(x->>'tick_interval_ms')::bigint,
   (x->>'t0_ms')::bigint+(case when p_epoch_start_ms-(x->>'t0_ms')::bigint<=0 then -div((x->>'t0_ms')::bigint-p_epoch_start_ms,(x->>'tick_interval_ms')::bigint)
     else div(p_epoch_start_ms-(x->>'t0_ms')::bigint+(x->>'tick_interval_ms')::bigint-1,(x->>'tick_interval_ms')::bigint) end)*(x->>'tick_interval_ms')::bigint))::bigint
 from public.engine_v3_configs c cross join lateral jsonb_array_elements(c.entries) x where c.config_hash=p_config_hash $$;

-- ---------------------------------------------------------------- submissions and attestations
create table public.engine_v3_witness_submissions (
 id bigint generated always as identity primary key,
 subject_kind text not null check (subject_kind in ('epoch-commitment','checkpoint')),
 subject_hash bytea not null check (octet_length(subject_hash)=32),
 provider text not null check (provider ~ '^[a-z0-9-]{1,32}$'),
 token bytea not null check (octet_length(token) between 64 and 65536),
 token_sha256 bytea not null check (octet_length(token_sha256)=32),
 submitted_at timestamptz not null default clock_timestamp(),
 unique (subject_hash, provider, token_sha256)
);
create table public.engine_v3_witness_attestations (
 submission_id bigint primary key references public.engine_v3_witness_submissions(id),
 verdict text not null check (verdict in ('valid','invalid')),
 reason text not null check (char_length(reason) between 1 and 300),
 gen_time_ms bigint, root_bundle_id bytea not null check (octet_length(root_bundle_id)=32),
 deadline_ms bigint, before_deadline boolean not null,
 attested_by text not null, attested_at timestamptz not null default clock_timestamp(),
 check (verdict='invalid' or gen_time_ms is not null)
);
alter table public.engine_v3_witness_submissions enable row level security;
alter table public.engine_v3_witness_attestations enable row level security;
revoke all on public.engine_v3_witness_submissions,public.engine_v3_witness_attestations from public,anon,authenticated;
create trigger engine_v3_submissions_immutable before update or delete on public.engine_v3_witness_submissions for each row execute function public.engine_v3_reject_mutation();
create trigger engine_v3_attestations_immutable before update or delete on public.engine_v3_witness_attestations for each row execute function public.engine_v3_reject_mutation();

-- Status of one provider for one subject: valid, late, invalid, pending or missing.
create or replace function engine_private.v3_witness_status(p_subject bytea,p_provider text) returns text
language sql stable security definer set search_path='' as $$
 select coalesce((select case when bool_or(a.verdict='valid' and a.before_deadline) then 'valid'
   when bool_or(a.verdict='valid') then 'late'
   when bool_or(a.submission_id is null) then 'pending' else 'invalid' end
  from public.engine_v3_witness_submissions s left join public.engine_v3_witness_attestations a on a.submission_id=s.id
  where s.subject_hash=p_subject and s.provider=p_provider),'missing') $$;

-- An epoch is tradable only when every required provider has a valid receipt
-- attested before the epoch's canonical deadline.
create or replace function engine_private.v3_epoch_attested(p_mode public.execution_mode,p_epoch_start_ms bigint) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.engine_v3_epochs e where e.execution_mode=p_mode and e.epoch_start_ms=p_epoch_start_ms)
  and not exists(select 1 from public.engine_v3_settings s cross join unnest(s.required_witnesses) p(provider)
   join public.engine_v3_epochs e on e.execution_mode=p_mode and e.epoch_start_ms=p_epoch_start_ms
   where engine_private.v3_witness_status(e.commitment,p.provider)<>'valid') $$;

-- Kept for callers from 20260924110000; the before-time argument is no longer
-- trusted, the canonical deadline applies.
create or replace function engine_private.v3_epoch_witnessed(p_mode public.execution_mode,p_epoch_start_ms bigint,p_before_ms bigint) returns boolean
language sql stable security definer set search_path='' as $$ select engine_private.v3_epoch_attested(p_mode,p_epoch_start_ms) $$;

-- Writer: submit a raw token. p_gen_time is accepted for signature compatibility and ignored.
create or replace function public.engine_v3_record_witness(p_subject_kind text,p_subject_hash bytea,p_provider text,p_token bytea,p_gen_time timestamptz) returns void
language plpgsql security definer set search_path='' as $$
declare v_known boolean; v_hash bytea;
begin
 if p_subject_kind='epoch-commitment' then select exists(select 1 from public.engine_v3_epochs where commitment=p_subject_hash) into v_known;
 elsif p_subject_kind='checkpoint' then select exists(select 1 from public.engine_v3_checkpoints where checkpoint_hash=p_subject_hash) into v_known;
 else raise exception 'engine_v3_subject_kind_invalid'; end if;
 if not v_known then raise exception 'engine_v3_subject_unknown'; end if;
 if p_token is null or octet_length(p_token)<64 or octet_length(p_token)>65536 or get_byte(p_token,0)<>48 then raise exception 'engine_v3_token_malformed'; end if;
 v_hash:=public.digest(p_token,'sha256');
 if exists(select 1 from public.engine_v3_witness_submissions where subject_hash=p_subject_hash and provider=p_provider and token_sha256=v_hash) then return; end if; -- identical resubmission
 insert into public.engine_v3_witness_submissions(subject_kind,subject_hash,provider,token,token_sha256) values(p_subject_kind,p_subject_hash,p_provider,p_token,v_hash);
 perform engine_private.v3_log('worker','submit_witness',null,null,jsonb_build_object('subject',encode(p_subject_hash,'hex'),'provider',p_provider,'token_sha256',encode(v_hash,'hex')));
end; $$;

-- Attestor: work queue and verdicts.
create or replace function public.engine_v3_pending_witnesses(p_limit integer default 50)
returns table(submission_id bigint,subject_kind text,subject_hash bytea,provider text,token bytea) language sql stable security definer set search_path='' as $$
 select s.id,s.subject_kind,s.subject_hash,s.provider,s.token from public.engine_v3_witness_submissions s
 where not exists(select 1 from public.engine_v3_witness_attestations a where a.submission_id=s.id) order by s.id limit least(greatest(coalesce(p_limit,50),1),500) $$;

create or replace function public.engine_v3_attest_witness(p_submission_id bigint,p_verdict text,p_reason text,p_gen_time_ms bigint,p_root_bundle_id bytea,p_attestor text) returns text
language plpgsql security definer set search_path='' as $$
declare s public.engine_v3_witness_submissions%rowtype; v_bundle bytea; v_deadline bigint; v_before boolean;
begin
 select tsa_root_bundle_id into v_bundle from public.engine_v3_settings;
 if v_bundle is null then raise exception 'engine_v3_root_bundle_unset'; end if;
 if p_root_bundle_id is distinct from v_bundle then raise exception 'engine_v3_root_bundle_mismatch'; end if;
 select * into s from public.engine_v3_witness_submissions where id=p_submission_id;
 if not found then raise exception 'engine_v3_subject_unknown'; end if;
 if exists(select 1 from public.engine_v3_witness_attestations where submission_id=p_submission_id) then raise exception 'engine_v3_already_attested'; end if;
 if p_verdict not in ('valid','invalid') or (p_verdict='valid' and p_gen_time_ms is null) then raise exception 'validation_failed'; end if;
 if p_verdict='valid' and p_gen_time_ms>engine_private.v3_now_ms()+300000 then raise exception 'engine_v3_receipt_in_future'; end if;
 if s.subject_kind='epoch-commitment' then
  select engine_private.v3_witness_deadline(e.config_hash,e.epoch_start_ms) into v_deadline from public.engine_v3_epochs e where e.commitment=s.subject_hash;
 end if;
 v_before:=p_verdict='valid' and (s.subject_kind='checkpoint' or p_gen_time_ms<v_deadline);
 insert into public.engine_v3_witness_attestations(submission_id,verdict,reason,gen_time_ms,root_bundle_id,deadline_ms,before_deadline,attested_by)
  values(p_submission_id,p_verdict,left(coalesce(nullif(btrim(p_reason),''),p_verdict),300),p_gen_time_ms,p_root_bundle_id,v_deadline,v_before,left(p_attestor,64));
 perform engine_private.v3_log('attestor','attest_witness',null,null,jsonb_build_object('submission_id',p_submission_id,'verdict',p_verdict,'before_deadline',v_before,'reason',p_reason));
 return case when p_verdict='invalid' then 'invalid' when v_before then 'valid' else 'late' end;
end; $$;

-- ---------------------------------------------------------------- configuration (adds the root bundle id)
create or replace function public.engine_v3_configure(p_env text,p_settings jsonb,p_reason text) returns void
language plpgsql security definer set search_path='' as $$
declare v_actor public.staff_roles; s public.engine_v3_settings%rowtype; v_new public.engine_v3_settings%rowtype;
begin
 v_actor:=admin_private.require_staff('engine.manage',true);
 if char_length(btrim(coalesce(p_reason,'')))<10 then raise exception 'validation_failed'; end if;
 select * into s from public.engine_v3_settings for update;
 if s.env is not null and p_env is distinct from s.env then raise exception 'engine_v3_environment_immutable'; end if;
 if p_env not in ('production','staging','test') then raise exception 'validation_failed'; end if;
 v_new:=s; v_new.env:=p_env;
 v_new.min_commit_lead_ms:=coalesce((p_settings->>'min_commit_lead_ms')::bigint,s.min_commit_lead_ms);
 v_new.max_tick_lag_ms:=coalesce((p_settings->>'max_tick_lag_ms')::bigint,s.max_tick_lag_ms);
 v_new.max_clock_drift_ms:=coalesce((p_settings->>'max_clock_drift_ms')::bigint,s.max_clock_drift_ms);
 v_new.max_checkpoint_gap_ticks:=coalesce((p_settings->>'max_checkpoint_gap_ticks')::integer,s.max_checkpoint_gap_ticks);
 v_new.heartbeat_timeout_ms:=coalesce((p_settings->>'heartbeat_timeout_ms')::bigint,s.heartbeat_timeout_ms);
 v_new.reveal_delay_ms:=coalesce((p_settings->>'reveal_delay_ms')::bigint,s.reveal_delay_ms);
 v_new.required_witnesses:=coalesce((select array_agg(x) from jsonb_array_elements_text(p_settings->'required_witnesses') x),s.required_witnesses);
 v_new.tsa_root_bundle_id:=coalesce(decode(p_settings->>'tsa_root_bundle_id','hex'),s.tsa_root_bundle_id);
 if p_env<>'test' and (v_new.min_commit_lead_ms<3600000 or v_new.max_tick_lag_ms>6000 or v_new.max_clock_drift_ms>1000
   or v_new.max_checkpoint_gap_ticks>300 or v_new.reveal_delay_ms<600000 or cardinality(v_new.required_witnesses)<2 or v_new.tsa_root_bundle_id is null) then
  raise exception 'engine_v3_threshold_below_policy';
 end if;
 update public.engine_v3_settings set env=v_new.env,min_commit_lead_ms=v_new.min_commit_lead_ms,max_tick_lag_ms=v_new.max_tick_lag_ms,
  max_clock_drift_ms=v_new.max_clock_drift_ms,max_checkpoint_gap_ticks=v_new.max_checkpoint_gap_ticks,heartbeat_timeout_ms=v_new.heartbeat_timeout_ms,
  reveal_delay_ms=v_new.reveal_delay_ms,required_witnesses=v_new.required_witnesses,tsa_root_bundle_id=v_new.tsa_root_bundle_id,updated_at=now();
 perform engine_private.v3_log('staff:'||v_actor.user_id,'configure',null,null,jsonb_build_object('env',p_env,'settings',p_settings,'reason',btrim(p_reason)));
end; $$;

-- ---------------------------------------------------------------- purchase gate
-- Stable reasons: engine_generation_cutover, engine_v3_environment_unset,
-- index_not_available, feed_stale, engine_worker_unhealthy, engine_unwitnessed,
-- engine_checkpoint_stale.
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

-- ---------------------------------------------------------------- worker state (witness status per provider)
create or replace function public.engine_v3_writer_state(p_mode public.execution_mode) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 return jsonb_build_object(
  'now_ms',engine_private.v3_now_ms(),'env',(select env from public.engine_v3_settings),
  'settings',(select to_jsonb(s)-'singleton'-'tsa_root_bundle_id' from public.engine_v3_settings s),
  'indices',coalesce((select jsonb_agg(jsonb_build_object('index',i.code,'generation',i.engine_generation,'shadow',i.v3_shadow,'halted',i.v3_halted_at is not null,
    't0_ms',engine_private.v3_t0_ms(i.t0)::text,'tick_interval_ms',i.tick_interval_ms,'decimals',i.decimals,
    'v2_final_tick_no',i.v2_final_tick_no::text,'cutover_ms',i.v3_cutover_ms::text,'state_last_tick_no',st.last_tick_no::text,
    'last',case when i.engine_generation=3 then (select jsonb_build_object('tick_no',t.tick_no::text,'price_units',round(t.price*power(10::numeric,t.generation_decimals))::text,'tick_hash',encode(t.v3_tick_hash,'hex'))
       from public.index_ticks t where t.index_code=i.code and t.execution_mode=i.execution_mode and t.generation_version=3 order by t.tick_no desc limit 1)
      else (select jsonb_build_object('tick_no',t.tick_no::text,'price_units',round(t.price*power(10::numeric,i.decimals))::text,'tick_hash',encode(t.v3_tick_hash,'hex'))
       from public.engine_v3_shadow_ticks t where t.index_code=i.code and t.execution_mode=i.execution_mode order by t.tick_no desc limit 1) end,
    'last_checkpoint_tick_no',(select max(c.tick_no)::text from public.engine_v3_checkpoints c where c.execution_mode=i.execution_mode and c.index_code=i.code and c.shadow=(i.engine_generation=2)))
    order by i.sort_order) from public.engine_indices i join public.index_state st on st.index_code=i.code and st.execution_mode=i.execution_mode where i.execution_mode=p_mode),'[]'::jsonb),
  -- `witnesses` lists providers that need no new token: valid, late (cannot be fixed) or awaiting attestation.
  'epochs',coalesce((select jsonb_agg(jsonb_build_object('epoch_start_ms',e.epoch_start_ms::text,'commitment',encode(e.commitment,'hex'),'config_hash',encode(e.config_hash,'hex'),
    'committed_ms',engine_private.v3_t0_ms(e.committed_at)::text,'revealed',e.revealed_seed is not null,
    'witness_deadline_ms',engine_private.v3_witness_deadline(e.config_hash,e.epoch_start_ms)::text,
    'witnesses',(select coalesce(jsonb_agg(p.provider),'[]'::jsonb) from (select distinct s.provider from public.engine_v3_witness_submissions s where s.subject_hash=e.commitment
      and engine_private.v3_witness_status(e.commitment,s.provider) in ('valid','late','pending')) p)) order by e.epoch_start_ms)
    from public.engine_v3_epochs e where e.execution_mode=p_mode and (e.revealed_seed is null or e.epoch_start_ms>=engine_private.v3_now_ms()-3*86400000)),'[]'::jsonb),
  'latest_commitment',(select jsonb_build_object('epoch_start_ms',e.epoch_start_ms::text,'commitment',encode(e.commitment,'hex')) from public.engine_v3_epochs e where e.execution_mode=p_mode order by e.epoch_start_ms desc limit 1),
  'configs',coalesce((select jsonb_object_agg(encode(c.config_hash,'hex'),c.entries) from public.engine_v3_configs c where c.execution_mode=p_mode
    and exists(select 1 from public.engine_v3_epochs e where e.config_hash=c.config_hash and (e.revealed_seed is null or e.epoch_start_ms>=engine_private.v3_now_ms()-3*86400000))),'{}'::jsonb),
  'unwitnessed_checkpoints',coalesce((select jsonb_agg(jsonb_build_object('checkpoint_hash',encode(c.checkpoint_hash,'hex'),'witnesses',
     (select coalesce(jsonb_agg(distinct s.provider),'[]'::jsonb) from public.engine_v3_witness_submissions s where s.subject_hash=c.checkpoint_hash
       and engine_private.v3_witness_status(c.checkpoint_hash,s.provider) in ('valid','late','pending'))))
    from public.engine_v3_checkpoints c where c.execution_mode=p_mode and c.created_ms>engine_private.v3_now_ms()-86400000
     and exists(select 1 from public.engine_v3_settings st cross join unnest(st.required_witnesses) p(provider)
      where engine_private.v3_witness_status(c.checkpoint_hash,p.provider) in ('missing','invalid'))),'[]'::jsonb));
end; $$;

-- ---------------------------------------------------------------- proof export, package version 2
-- Every configuration the range needs (keyed by hash), the commitment chain from
-- the first v3 epoch (chain fields only outside the range), raw receipt tokens
-- for epochs holding ticks and for checkpoints, and an anchor that is either
-- genesis or a signed checkpoint. Ranges may cross configuration changes. At most
-- 5,000 ticks are returned from the anchored start; `range.truncated_to`
-- reports any shortening, and the caller requests the next page from there.
create or replace function public.get_v3_proof_package(p_account_id uuid,p_index text,p_from bigint,p_to bigint) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_mode public.execution_mode; v_env text:=engine_private.v3_env(); v_first_cfg bytea; v_genesis bigint; v_start bigint; v_to bigint;
 v_anchor public.engine_v3_checkpoints%rowtype; v_anchor_tick jsonb; v_min_epoch bigint; v_max_epoch bigint;
begin
 v_mode:=public.engine_assert_account_access(p_account_id);
 if p_from is null or p_to is null or p_from<1 or p_to<p_from then raise exception 'validation_failed'; end if;
 select t.v3_config_hash into v_first_cfg from public.index_ticks t where t.index_code=p_index and t.execution_mode=v_mode and t.generation_version=3 and t.tick_no>=p_from order by t.tick_no limit 1;
 if v_first_cfg is null then raise exception 'not_found'; end if;
 v_genesis:=(select min((x->>'genesis_tick_no')::bigint) from public.index_ticks t cross join lateral jsonb_array_elements((select entries from public.engine_v3_configs where config_hash=t.v3_config_hash)) x
   where t.index_code=p_index and t.execution_mode=v_mode and t.generation_version=3 and x->>'index'=p_index and t.tick_no=(select min(tick_no) from public.index_ticks where index_code=p_index and execution_mode=v_mode and generation_version=3));
 v_start:=greatest(p_from,v_genesis+1);
 if v_start>v_genesis+1 then
  select * into v_anchor from public.engine_v3_checkpoints c where c.execution_mode=v_mode and c.index_code=p_index and not c.shadow and c.tick_no<v_start and c.tick_no>v_genesis order by c.tick_no desc limit 1;
  if found then v_start:=v_anchor.tick_no+1; else v_start:=v_genesis+1; end if;
 end if;
 v_to:=least(p_to,v_start+4999);
 select min(v3_epoch_start_ms),max(v3_epoch_start_ms) into v_min_epoch,v_max_epoch from public.index_ticks where index_code=p_index and execution_mode=v_mode and generation_version=3 and tick_no between v_start-1 and v_to;
 if v_anchor.tick_no is not null then
  select jsonb_build_object('index',t.index_code,'tick_no',t.tick_no::text,'scheduled_ms',engine_private.v3_t0_ms(t.scheduled_at)::text,'generated_ms',t.v3_generated_ms::text,
   'epoch_start_ms',t.v3_epoch_start_ms::text,'prev_units',round(t.previous_price*power(10::numeric,t.generation_decimals))::text,'price_units',round(t.price*power(10::numeric,t.generation_decimals))::text,
   'decimals',t.generation_decimals,'digit',t.digit,'config_hash',encode(t.v3_config_hash,'hex'),'commitment',encode(t.v3_commitment,'hex'),'prev_tick_hash',encode(t.v3_prev_tick_hash,'hex'),'tick_hash',encode(t.v3_tick_hash,'hex'))
   into v_anchor_tick from public.index_ticks t where t.index_code=p_index and t.execution_mode=v_mode and t.tick_no=v_anchor.tick_no;
 end if;
 return jsonb_build_object(
  'format','smartprofit-proof/v3','package_version',2,'env',v_env,'mode',v_mode::text,
  'range',jsonb_build_object('index',p_index,'requested_from',p_from::text,'requested_to',p_to::text,'from',v_start::text,'to',v_to::text,'truncated_to',case when v_to<p_to then v_to::text end,'max_ticks',5000),
  'configs',coalesce((select jsonb_object_agg(encode(c.config_hash,'hex'),jsonb_build_object('indices',c.entries)) from public.engine_v3_configs c
    where c.config_hash in (select distinct t.v3_config_hash from public.index_ticks t where t.index_code=p_index and t.execution_mode=v_mode and t.generation_version=3 and t.tick_no between v_start-1 and v_to)),'{}'::jsonb),
  'signing_keys',coalesce((select jsonb_agg(jsonb_build_object('key_id',k.key_id,'algorithm',k.algorithm,'public_key',encode(k.public_key,'hex'))) from public.engine_v3_signing_keys k),'[]'::jsonb),
  'epochs',coalesce((select jsonb_agg(jsonb_build_object('epoch_start_ms',e.epoch_start_ms::text,'epoch_end_ms',e.epoch_end_ms::text,'seed_hash',encode(e.seed_hash,'hex'),
    'config_hash',encode(e.config_hash,'hex'),'prev_commitment',encode(e.prev_commitment,'hex'),'commitment',encode(e.commitment,'hex'),
    'signing_key_id',e.signing_key_id,'signature',encode(e.signature,'hex'),
    'revealed_seed',case when e.epoch_start_ms between v_min_epoch and v_max_epoch then encode(e.revealed_seed,'hex') end,
    'witness_deadline_ms',case when e.epoch_start_ms between v_min_epoch and v_max_epoch then engine_private.v3_witness_deadline(e.config_hash,e.epoch_start_ms)::text end,
    'witness',case when e.epoch_start_ms between v_min_epoch and v_max_epoch then coalesce((select jsonb_agg(jsonb_build_object('provider',s.provider,'token',encode(s.token,'base64')) order by s.id)
      from public.engine_v3_witness_submissions s where s.subject_hash=e.commitment),'[]'::jsonb) else '[]'::jsonb end)
    order by e.epoch_start_ms) from public.engine_v3_epochs e where e.execution_mode=v_mode and e.epoch_start_ms<=v_max_epoch),'[]'::jsonb),
  'anchors',case when v_anchor_tick is null then '{}'::jsonb else jsonb_build_object(p_index,jsonb_build_object('tick',v_anchor_tick,'checkpoint',
    jsonb_build_object('tick_no',v_anchor.tick_no::text,'tick_hash',encode(v_anchor.tick_hash,'hex'),'created_ms',v_anchor.created_ms::text,'checkpoint_hash',encode(v_anchor.checkpoint_hash,'hex'),
     'signing_key_id',v_anchor.signing_key_id,'signature',encode(v_anchor.signature,'hex'),
     'witness',coalesce((select jsonb_agg(jsonb_build_object('provider',s.provider,'token',encode(s.token,'base64')) order by s.id) from public.engine_v3_witness_submissions s where s.subject_hash=v_anchor.checkpoint_hash),'[]'::jsonb)))) end,
  'ticks',coalesce((select jsonb_agg(jsonb_build_object('index',t.index_code,'tick_no',t.tick_no::text,'scheduled_ms',engine_private.v3_t0_ms(t.scheduled_at)::text,'generated_ms',t.v3_generated_ms::text,
    'epoch_start_ms',t.v3_epoch_start_ms::text,'prev_units',round(t.previous_price*power(10::numeric,t.generation_decimals))::text,'price_units',round(t.price*power(10::numeric,t.generation_decimals))::text,
    'decimals',t.generation_decimals,'digit',t.digit,'config_hash',encode(t.v3_config_hash,'hex'),'commitment',encode(t.v3_commitment,'hex'),
    'prev_tick_hash',encode(t.v3_prev_tick_hash,'hex'),'tick_hash',encode(t.v3_tick_hash,'hex')) order by t.tick_no)
    from public.index_ticks t where t.index_code=p_index and t.execution_mode=v_mode and t.generation_version=3 and t.tick_no between v_start and v_to),'[]'::jsonb),
  'checkpoints',coalesce((select jsonb_agg(jsonb_build_object('index',c.index_code,'tick_no',c.tick_no::text,'tick_hash',encode(c.tick_hash,'hex'),'created_ms',c.created_ms::text,
    'checkpoint_hash',encode(c.checkpoint_hash,'hex'),'signing_key_id',c.signing_key_id,'signature',encode(c.signature,'hex'),
    'witness',coalesce((select jsonb_agg(jsonb_build_object('provider',s.provider,'token',encode(s.token,'base64')) order by s.id) from public.engine_v3_witness_submissions s where s.subject_hash=c.checkpoint_hash),'[]'::jsonb)) order by c.tick_no)
    from public.engine_v3_checkpoints c where c.execution_mode=v_mode and c.index_code=p_index and not c.shadow and c.tick_no between v_start and v_to),'[]'::jsonb),
  'contracts',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'index',c.index_code,'contract_type',c.contract_type,'barrier',c.barrier,
    'entry_tick_no',c.entry_tick_no::text,'settle_tick_no',c.settle_tick_no::text,'result',c.state,'exit_digit',c.exit_digit) order by c.settle_tick_no)
    from public.engine_contracts c where c.trading_account_id=p_account_id and c.index_code=p_index and c.state in ('WON','LOST','VOID') and c.settle_tick_no between v_start and v_to),'[]'::jsonb));
end; $$;

-- ---------------------------------------------------------------- admin view of witness state
create or replace function public.get_admin_engine_v3_witnesses(p_limit integer default 50) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 perform admin_private.require_staff('engine.read');
 return coalesce((select jsonb_agg(jsonb_build_object('submission_id',s.id,'subject_kind',s.subject_kind,'subject',encode(s.subject_hash,'hex'),'provider',s.provider,
   'submitted_at',s.submitted_at,'verdict',a.verdict,'reason',a.reason,'gen_time_ms',a.gen_time_ms,'deadline_ms',a.deadline_ms,'before_deadline',a.before_deadline) order by s.id desc)
  from (select * from public.engine_v3_witness_submissions order by id desc limit least(greatest(coalesce(p_limit,50),1),500)) s
  left join public.engine_v3_witness_attestations a on a.submission_id=s.id),'[]'::jsonb);
end; $$;

-- ---------------------------------------------------------------- admin health reads attestations
create or replace function public.get_admin_engine_v3_health() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_now bigint:=engine_private.v3_now_ms();
begin
 perform admin_private.require_staff('engine.read');
 return jsonb_build_object(
  'settings',(select to_jsonb(s) from public.engine_v3_settings s),
  'workers',coalesce((select jsonb_agg(to_jsonb(w) order by w.last_seen desc) from public.engine_v3_worker_heartbeats w),'[]'::jsonb),
  'epochs',coalesce((select jsonb_agg(jsonb_build_object('execution_mode',e.execution_mode,'epoch_start_ms',e.epoch_start_ms,'committed_at',e.committed_at,
     'witness_deadline_ms',engine_private.v3_witness_deadline(e.config_hash,e.epoch_start_ms),'tradable',engine_private.v3_epoch_attested(e.execution_mode,e.epoch_start_ms),
     'witnesses',(select coalesce(jsonb_object_agg(p.provider,engine_private.v3_witness_status(e.commitment,p.provider)),'{}'::jsonb) from public.engine_v3_settings st cross join unnest(st.required_witnesses) p(provider)),
     'revealed',e.revealed_seed is not null,'reveal_overdue',e.revealed_seed is null and v_now>e.epoch_end_ms+86400000) order by e.epoch_start_ms desc)
     from (select * from public.engine_v3_epochs order by epoch_start_ms desc limit 14) e),'[]'::jsonb),
  'indices',public.get_engine_v3_status(),
  'volatility',coalesce((select jsonb_agg(jsonb_build_object('index_code',i.code,'execution_mode',i.execution_mode,
     '1h',engine_private.v3_observed_volatility(i.execution_mode,i.code,1800),'1d',engine_private.v3_observed_volatility(i.execution_mode,i.code,43200),
     '7d',engine_private.v3_observed_volatility(i.execution_mode,i.code,302400)) order by i.sort_order)
     from public.engine_indices i where i.engine_generation=3),'[]'::jsonb),
  'shadow',coalesce((select jsonb_agg(jsonb_build_object('index_code',t.index_code,'last_tick_no',max_tick,'ticks',n)) from
     (select index_code,max(tick_no) max_tick,count(*) n from public.engine_v3_shadow_ticks group by index_code) t),'[]'::jsonb),
  'events',coalesce((select jsonb_agg(to_jsonb(ev) order by ev.id desc) from (select * from public.engine_v3_events order by id desc limit 50) ev),'[]'::jsonb));
end; $$;


-- ---------------------------------------------------------------- grants
do $$
declare f record;
begin
 for f in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where (n.nspname='public' and p.proname in ('engine_v3_record_witness','engine_v3_pending_witnesses','engine_v3_attest_witness','engine_v3_configure','engine_v3_writer_state','get_v3_proof_package','get_admin_engine_v3_witnesses','get_admin_engine_v3_health'))
     or (n.nspname='engine_private' and p.proname in ('v3_witness_deadline','v3_witness_status','v3_epoch_attested','v3_epoch_witnessed','v3_purchase_block')) loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',f.sig);
 end loop;
end $$;
grant execute on function public.engine_v3_record_witness(text,bytea,text,bytea,timestamptz),public.engine_v3_writer_state(public.execution_mode) to engine_tick_writer;
grant execute on function public.engine_v3_pending_witnesses(integer),public.engine_v3_attest_witness(bigint,text,text,bigint,bytea,text) to engine_witness_attestor;
grant execute on function public.engine_v3_configure(text,jsonb,text),public.get_v3_proof_package(uuid,text,bigint,bigint),public.get_admin_engine_v3_witnesses(integer),public.get_admin_engine_v3_health() to authenticated;
