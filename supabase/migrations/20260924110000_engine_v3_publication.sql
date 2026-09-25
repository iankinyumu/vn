-- Engine v3 publication, custody boundary and fail-closed gates (ADR 0002).
-- Forward-only. Version 1/2 ticks, epochs and contracts are not modified.
-- Active v3 seeds never enter this database: the external worker (role
-- engine_tick_writer) publishes ticks; the database checks sequence, schedule,
-- chain and hash, and stores only seed ciphertext it cannot decrypt.

-- ---------------------------------------------------------------- roles
do $$ begin
 if not exists(select 1 from pg_roles where rolname='engine_tick_writer') then create role engine_tick_writer nologin; end if;
end $$;
grant usage on schema public to engine_tick_writer;

-- ---------------------------------------------------------------- helpers
create or replace function engine_private.v3_now_ms() returns bigint language sql volatile set search_path='' as $$
 select floor(extract(epoch from clock_timestamp())*1000)::bigint $$;

create or replace function engine_private.v3_checkpoint_hash(p_env text,p_mode text,p_index text,p_tick_no numeric,p_tick_hash bytea,p_created_ms numeric) returns bytea
language sql immutable set search_path='' as $$
 select public.digest(engine_private.v3_header('checkpoint')||engine_private.v3_label(p_env)||engine_private.v3_label(p_mode)||engine_private.v3_label(p_index)
  ||engine_private.v3_uint(p_tick_no,8)||engine_private.v3_hash32(p_tick_hash)||engine_private.v3_uint(p_created_ms,8),'sha256') $$;

create or replace function engine_private.v3_signed_message(p_kind text,p_key_id text,p_subject bytea) returns bytea
language plpgsql immutable set search_path='' as $$
begin
 if p_kind not in ('epoch-commitment','checkpoint') then raise exception 'engine_v3_signature_kind_invalid'; end if;
 return engine_private.v3_header('signed')||engine_private.v3_label(p_kind)||engine_private.v3_label(p_key_id)||engine_private.v3_hash32(p_subject);
end; $$;

-- ---------------------------------------------------------------- schema
create table public.engine_v3_settings (
 singleton boolean primary key default true check (singleton),
 env text check (env in ('production','staging','test')),
 min_commit_lead_ms bigint not null default 3600000,
 max_tick_lag_ms bigint not null default 6000,
 max_clock_drift_ms bigint not null default 1000,
 max_checkpoint_gap_ticks integer not null default 300 check (max_checkpoint_gap_ticks > 0),
 heartbeat_timeout_ms bigint not null default 10000,
 reveal_delay_ms bigint not null default 600000,
 required_witnesses text[] not null default array['digicert','sectigo'],
 updated_at timestamptz not null default now()
);
insert into public.engine_v3_settings default values;

-- The engine_advance cron job runs every second and locks engine_indices before
-- index_state and index_ticks. Take every lock this migration needs up front, in
-- that order, so it waits for an in-flight tick instead of deadlocking with it.
-- New ticks queue behind it for the moment it runs; a busy database fails the
-- migration cleanly after 15 s and it can be pushed again.
set local lock_timeout = '15s';
lock table public.engine_indices, public.index_state, public.index_ticks, public.engine_contracts in access exclusive mode;

alter table public.engine_indices
 add column engine_generation smallint not null default 2 check (engine_generation in (2,3)),
 add column v3_shadow boolean not null default false,
 add column v2_final_tick_no bigint,
 add column v3_cutover_ms bigint,
 add column v3_halted_at timestamptz,
 add column v3_halt_reason text;

alter table public.index_ticks drop constraint if exists index_ticks_generation_version_check;
alter table public.index_ticks add constraint index_ticks_generation_version_check check (generation_version in (1,2,3));
alter table public.index_ticks alter column epoch_id drop not null;
alter table public.index_ticks
 add column v3_epoch_start_ms bigint,
 add column v3_generated_ms bigint,
 add column v3_config_hash bytea,
 add column v3_commitment bytea,
 add column v3_prev_tick_hash bytea,
 add column v3_tick_hash bytea;
alter table public.index_ticks add constraint index_ticks_version_fields check (
 (generation_version < 3 and epoch_id is not null) or
 (generation_version = 3 and v3_epoch_start_ms is not null and v3_generated_ms is not null and octet_length(v3_config_hash)=32
  and octet_length(v3_commitment)=32 and octet_length(v3_prev_tick_hash)=32 and octet_length(v3_tick_hash)=32 and previous_price > 0));

create table public.engine_v3_configs (
 config_hash bytea primary key check (octet_length(config_hash)=32),
 env text not null, execution_mode public.execution_mode not null,
 entries jsonb not null, created_at timestamptz not null default now()
);
create table public.engine_v3_signing_keys (
 key_id text primary key check (key_id ~ '^[A-Za-z0-9._-]{1,64}$'),
 algorithm text not null default 'Ed25519' check (algorithm='Ed25519'),
 public_key bytea not null unique check (octet_length(public_key)=32),
 valid_from timestamptz not null default now(), retired_at timestamptz
);
create table public.engine_v3_epochs (
 execution_mode public.execution_mode not null, epoch_start_ms bigint not null check (epoch_start_ms % 86400000 = 0),
 epoch_end_ms bigint not null, config_hash bytea not null references public.engine_v3_configs(config_hash),
 seed_hash bytea not null check (octet_length(seed_hash)=32), prev_commitment bytea not null check (octet_length(prev_commitment)=32),
 commitment bytea not null unique check (octet_length(commitment)=32),
 signing_key_id text not null references public.engine_v3_signing_keys(key_id), signature bytea not null check (octet_length(signature)=64),
 committed_at timestamptz not null default clock_timestamp(), revealed_seed bytea, revealed_at timestamptz,
 primary key (execution_mode, epoch_start_ms), check (epoch_end_ms = epoch_start_ms + 86400000)
);
create table engine_private.v3_wrapped_seeds (
 execution_mode public.execution_mode not null, epoch_start_ms bigint not null,
 custody_provider text not null, key_ref text not null, ciphertext bytea not null,
 primary key (execution_mode, epoch_start_ms), foreign key (execution_mode, epoch_start_ms) references public.engine_v3_epochs(execution_mode, epoch_start_ms)
);
create table public.engine_v3_witness_receipts (
 subject_kind text not null check (subject_kind in ('epoch-commitment','checkpoint')),
 subject_hash bytea not null check (octet_length(subject_hash)=32),
 provider text not null check (provider ~ '^[a-z0-9-]{1,32}$'),
 token bytea not null, gen_time timestamptz not null, recorded_at timestamptz not null default now(),
 primary key (subject_hash, provider)
);
create table public.engine_v3_shadow_ticks (
 index_code text not null, execution_mode public.execution_mode not null, tick_no bigint not null,
 scheduled_at timestamptz not null, generated_at timestamptz not null default now(), price numeric not null, digit smallint not null,
 previous_price numeric not null, v3_epoch_start_ms bigint not null, v3_generated_ms bigint not null,
 v3_config_hash bytea not null, v3_commitment bytea not null, v3_prev_tick_hash bytea not null, v3_tick_hash bytea not null,
 primary key (index_code, execution_mode, tick_no)
);
create table public.engine_v3_checkpoints (
 execution_mode public.execution_mode not null, index_code text not null, tick_no bigint not null, shadow boolean not null,
 tick_hash bytea not null, created_ms bigint not null, checkpoint_hash bytea not null unique,
 signing_key_id text not null references public.engine_v3_signing_keys(key_id), signature bytea not null check (octet_length(signature)=64),
 primary key (execution_mode, index_code, shadow, tick_no)
);
create table public.engine_v3_worker_heartbeats (
 worker_id text primary key check (worker_id ~ '^[A-Za-z0-9._-]{1,64}$'),
 last_seen timestamptz not null, clock_drift_ms bigint not null, custody_provider text not null, runtime text not null
);
create table public.engine_v3_events (
 id bigint generated always as identity primary key, created_at timestamptz not null default now(),
 actor text not null, action text not null, execution_mode public.execution_mode, index_code text, detail jsonb not null default '{}'::jsonb
);

alter table public.engine_v3_settings enable row level security;
alter table public.engine_v3_configs enable row level security;
alter table public.engine_v3_signing_keys enable row level security;
alter table public.engine_v3_epochs enable row level security;
alter table public.engine_v3_witness_receipts enable row level security;
alter table public.engine_v3_shadow_ticks enable row level security;
alter table public.engine_v3_checkpoints enable row level security;
alter table public.engine_v3_worker_heartbeats enable row level security;
alter table public.engine_v3_events enable row level security;
revoke all on public.engine_v3_settings,public.engine_v3_configs,public.engine_v3_signing_keys,public.engine_v3_epochs,
 public.engine_v3_witness_receipts,public.engine_v3_shadow_ticks,public.engine_v3_checkpoints,public.engine_v3_worker_heartbeats,
 public.engine_v3_events from public,anon,authenticated;
revoke all on engine_private.v3_wrapped_seeds from public;

-- Published records are append-only; an epoch may change once, to reveal.
create or replace function public.engine_v3_reject_mutation() returns trigger language plpgsql set search_path='' as $$
begin raise exception 'engine_v3_immutable'; end; $$;
create trigger engine_v3_configs_immutable before update or delete on public.engine_v3_configs for each row execute function public.engine_v3_reject_mutation();
create trigger engine_v3_receipts_immutable before update or delete on public.engine_v3_witness_receipts for each row execute function public.engine_v3_reject_mutation();
create trigger engine_v3_shadow_immutable before update or delete on public.engine_v3_shadow_ticks for each row execute function public.engine_v3_reject_mutation();
create trigger engine_v3_checkpoints_immutable before update or delete on public.engine_v3_checkpoints for each row execute function public.engine_v3_reject_mutation();
create trigger engine_v3_events_immutable before update or delete on public.engine_v3_events for each row execute function public.engine_v3_reject_mutation();
create trigger engine_v3_wrapped_immutable before update or delete on engine_private.v3_wrapped_seeds for each row execute function public.engine_v3_reject_mutation();

create or replace function public.engine_v3_epoch_reveal_only() returns trigger language plpgsql set search_path='' as $$
declare v_expected public.engine_v3_epochs;
begin
 if tg_op='DELETE' then raise exception 'engine_v3_immutable'; end if;
 v_expected:=old; v_expected.revealed_seed:=new.revealed_seed; v_expected.revealed_at:=new.revealed_at;
 if new is distinct from v_expected or old.revealed_seed is not null or new.revealed_seed is null then raise exception 'engine_v3_immutable'; end if;
 return new;
end; $$;
create trigger engine_v3_epochs_reveal_only before update or delete on public.engine_v3_epochs for each row execute function public.engine_v3_epoch_reveal_only();

create or replace function public.engine_v3_signing_key_guard() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op='DELETE' or new.key_id<>old.key_id or new.public_key<>old.public_key or new.valid_from<>old.valid_from or old.retired_at is not null then raise exception 'engine_v3_immutable'; end if;
 return new;
end; $$;
create trigger engine_v3_signing_keys_guard before update or delete on public.engine_v3_signing_keys for each row execute function public.engine_v3_signing_key_guard();

-- ---------------------------------------------------------------- internal helpers
create or replace function engine_private.v3_env() returns text language plpgsql stable security definer set search_path='' as $$
declare v text;
begin
 select env into v from public.engine_v3_settings;
 if v is null then raise exception 'engine_v3_environment_unset'; end if;
 return v;
end; $$;

create or replace function engine_private.v3_log(p_actor text,p_action text,p_mode public.execution_mode,p_index text,p_detail jsonb) returns void
language sql security definer set search_path='' as $$
 insert into public.engine_v3_events(actor,action,execution_mode,index_code,detail) values(p_actor,p_action,p_mode,p_index,coalesce(p_detail,'{}'::jsonb)) $$;

create or replace function engine_private.v3_entry(p_config_hash bytea,p_index text) returns jsonb language sql stable security definer set search_path='' as $$
 select x from public.engine_v3_configs c cross join lateral jsonb_array_elements(c.entries) x where c.config_hash=p_config_hash and x->>'index'=p_index $$;

create or replace function engine_private.v3_t0_ms(p_t0 timestamptz) returns bigint language sql immutable set search_path='' as $$
 select floor(extract(epoch from p_t0)*1000)::bigint $$;

-- True when every required TSA has a receipt for the epoch commitment whose
-- genTime is before p_before_ms.
create or replace function engine_private.v3_epoch_witnessed(p_mode public.execution_mode,p_epoch_start_ms bigint,p_before_ms bigint) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.engine_v3_epochs e where e.execution_mode=p_mode and e.epoch_start_ms=p_epoch_start_ms)
  and not exists(
   select 1 from public.engine_v3_settings s cross join unnest(s.required_witnesses) p(provider)
   where not exists(select 1 from public.engine_v3_witness_receipts r join public.engine_v3_epochs e on e.commitment=r.subject_hash
    where e.execution_mode=p_mode and e.epoch_start_ms=p_epoch_start_ms and r.provider=p.provider
     and floor(extract(epoch from r.gen_time)*1000)<p_before_ms)) $$;

-- ---------------------------------------------------------------- staff configuration
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
 -- ADR 0002 §3 floors cannot be relaxed outside test.
 if p_env<>'test' and (v_new.min_commit_lead_ms<3600000 or v_new.max_tick_lag_ms>6000 or v_new.max_clock_drift_ms>1000
   or v_new.max_checkpoint_gap_ticks>300 or v_new.reveal_delay_ms<600000 or cardinality(v_new.required_witnesses)<2) then
  raise exception 'engine_v3_threshold_below_policy';
 end if;
 update public.engine_v3_settings set env=v_new.env,min_commit_lead_ms=v_new.min_commit_lead_ms,max_tick_lag_ms=v_new.max_tick_lag_ms,
  max_clock_drift_ms=v_new.max_clock_drift_ms,max_checkpoint_gap_ticks=v_new.max_checkpoint_gap_ticks,heartbeat_timeout_ms=v_new.heartbeat_timeout_ms,
  reveal_delay_ms=v_new.reveal_delay_ms,required_witnesses=v_new.required_witnesses,updated_at=now();
 perform engine_private.v3_log('staff:'||v_actor.user_id,'configure',null,null,jsonb_build_object('env',p_env,'settings',p_settings,'reason',btrim(p_reason)));
end; $$;

create or replace function public.engine_v3_set_shadow(p_mode public.execution_mode,p_index text,p_enabled boolean,p_reason text) returns void
language plpgsql security definer set search_path='' as $$
declare v_actor public.staff_roles;
begin
 v_actor:=admin_private.require_staff('engine.manage',true);
 if char_length(btrim(coalesce(p_reason,'')))<10 then raise exception 'validation_failed'; end if;
 update public.engine_indices set v3_shadow=p_enabled where code=p_index and execution_mode=p_mode and engine_generation=2;
 if not found then raise exception 'index_not_available'; end if;
 perform engine_private.v3_log('staff:'||v_actor.user_id,'set_shadow',p_mode,p_index,jsonb_build_object('enabled',p_enabled,'reason',btrim(p_reason)));
end; $$;

-- Cutover at UTC day boundary p_cutover_ms (ADR 0002 §5). The epoch starting
-- there must already be committed under a configuration whose genesis for this
-- index is the last tick before the boundary.
create or replace function public.engine_v3_schedule_cutover(p_mode public.execution_mode,p_index text,p_cutover_ms bigint,p_reason text) returns bigint
language plpgsql security definer set search_path='' as $$
declare v_actor public.staff_roles; i public.engine_indices%rowtype; s public.index_state%rowtype; e public.engine_v3_epochs%rowtype; v_entry jsonb; v_final bigint; v_t0 bigint;
begin
 v_actor:=admin_private.require_staff('engine.manage',true);
 if char_length(btrim(coalesce(p_reason,'')))<10 then raise exception 'validation_failed'; end if;
 if p_mode<>'DEMO' then raise exception 'engine_v3_practice_only'; end if;
 select * into i from public.engine_indices where code=p_index and execution_mode=p_mode for update;
 if not found or i.engine_generation<>2 then raise exception 'index_not_available'; end if;
 if p_cutover_ms % 86400000<>0 then raise exception 'engine_v3_cutover_not_boundary'; end if;
 v_t0:=engine_private.v3_t0_ms(i.t0);
 v_final:=floor((p_cutover_ms-1-v_t0)::numeric/i.tick_interval_ms)::bigint;
 select * into s from public.index_state where index_code=p_index and execution_mode=p_mode;
 if s.last_tick_no>=v_final then raise exception 'engine_v3_cutover_too_late'; end if;
 select * into e from public.engine_v3_epochs where execution_mode=p_mode and epoch_start_ms=p_cutover_ms;
 if not found then raise exception 'engine_v3_epoch_uncommitted'; end if;
 v_entry:=engine_private.v3_entry(e.config_hash,p_index);
 if v_entry is null or (v_entry->>'genesis_tick_no')::bigint<>v_final or (v_entry->>'t0_ms')::bigint<>v_t0 then raise exception 'engine_v3_genesis_mismatch'; end if;
 update public.engine_indices set v2_final_tick_no=v_final,v3_cutover_ms=p_cutover_ms where code=p_index and execution_mode=p_mode;
 perform engine_private.v3_log('staff:'||v_actor.user_id,'schedule_cutover',p_mode,p_index,jsonb_build_object('cutover_ms',p_cutover_ms,'v2_final_tick_no',v_final,'config_hash',encode(e.config_hash,'hex'),'reason',btrim(p_reason)));
 return v_final;
end; $$;

-- ---------------------------------------------------------------- worker RPCs (engine_tick_writer only)
create or replace function public.engine_v3_heartbeat(p_worker_id text,p_worker_now_ms bigint,p_custody_provider text,p_runtime text) returns bigint
language plpgsql security definer set search_path='' as $$
declare v_now bigint:=engine_private.v3_now_ms(); v_env text:=engine_private.v3_env();
begin
 if v_env='production' and p_custody_provider not like 'kms:%' then raise exception 'engine_v3_custody_not_allowed'; end if;
 insert into public.engine_v3_worker_heartbeats(worker_id,last_seen,clock_drift_ms,custody_provider,runtime) values(p_worker_id,now(),p_worker_now_ms-v_now,p_custody_provider,left(p_runtime,200))
 on conflict(worker_id) do update set last_seen=excluded.last_seen,clock_drift_ms=excluded.clock_drift_ms,custody_provider=excluded.custody_provider,runtime=excluded.runtime;
 return v_now;
end; $$;

create or replace function public.engine_v3_register_signing_key(p_key_id text,p_public_key bytea) returns void
language plpgsql security definer set search_path='' as $$
begin
 insert into public.engine_v3_signing_keys(key_id,public_key) values(p_key_id,p_public_key) on conflict do nothing;
 if not exists(select 1 from public.engine_v3_signing_keys where key_id=p_key_id and public_key=p_public_key and retired_at is null) then raise exception 'engine_v3_signing_key_conflict'; end if;
end; $$;

create or replace function public.engine_v3_register_config(p_mode public.execution_mode,p_entries jsonb) returns bytea
language plpgsql security definer set search_path='' as $$
declare v_env text:=engine_private.v3_env(); v_hash bytea; e jsonb; i public.engine_indices%rowtype; v_count integer;
begin
 if jsonb_typeof(p_entries)<>'array' then raise exception 'validation_failed'; end if;
 select count(*) into v_count from public.engine_indices where execution_mode=p_mode;
 if v_count<>jsonb_array_length(p_entries) then raise exception 'engine_v3_config_incomplete'; end if;
 for e in select x from jsonb_array_elements(p_entries) x loop
  select * into i from public.engine_indices where code=e->>'index' and execution_mode=p_mode;
  if not found or i.tick_interval_ms<>(e->>'tick_interval_ms')::integer or i.decimals<>(e->>'decimals')::smallint
   or engine_private.v3_t0_ms(i.t0)<>(e->>'t0_ms')::bigint then raise exception 'engine_v3_config_index_mismatch'; end if;
 end loop;
 v_hash:=engine_private.v3_config_hash(v_env,p_mode::text,p_entries);
 insert into public.engine_v3_configs(config_hash,env,execution_mode,entries) values(v_hash,v_env,p_mode,p_entries) on conflict do nothing;
 return v_hash;
end; $$;

create or replace function public.engine_v3_commit_epoch(
 p_mode public.execution_mode,p_epoch_start_ms bigint,p_config_hash bytea,p_seed_hash bytea,p_prev_commitment bytea,p_commitment bytea,
 p_signing_key_id text,p_signature bytea,p_custody_provider text,p_key_ref text,p_ciphertext bytea
) returns void language plpgsql security definer set search_path='' as $$
declare v_env text:=engine_private.v3_env(); s public.engine_v3_settings%rowtype; last public.engine_v3_epochs%rowtype; existing public.engine_v3_epochs%rowtype; v_known boolean;
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
 insert into public.engine_v3_epochs(execution_mode,epoch_start_ms,epoch_end_ms,config_hash,seed_hash,prev_commitment,commitment,signing_key_id,signature)
  values(p_mode,p_epoch_start_ms,p_epoch_start_ms+86400000,p_config_hash,p_seed_hash,p_prev_commitment,p_commitment,p_signing_key_id,p_signature);
 insert into engine_private.v3_wrapped_seeds values(p_mode,p_epoch_start_ms,p_custody_provider,p_key_ref,p_ciphertext);
 perform engine_private.v3_log('worker','commit_epoch',p_mode,null,jsonb_build_object('epoch_start_ms',p_epoch_start_ms,'commitment',encode(p_commitment,'hex')));
end; $$;

create or replace function public.engine_v3_record_witness(p_subject_kind text,p_subject_hash bytea,p_provider text,p_token bytea,p_gen_time timestamptz) returns void
language plpgsql security definer set search_path='' as $$
begin
 if p_subject_kind='epoch-commitment' and not exists(select 1 from public.engine_v3_epochs where commitment=p_subject_hash) then raise exception 'engine_v3_subject_unknown'; end if;
 if p_subject_kind='checkpoint' and not exists(select 1 from public.engine_v3_checkpoints where checkpoint_hash=p_subject_hash) then raise exception 'engine_v3_subject_unknown'; end if;
 if p_gen_time>now()+interval '5 minutes' then raise exception 'engine_v3_receipt_in_future'; end if;
 insert into public.engine_v3_witness_receipts(subject_kind,subject_hash,provider,token,gen_time) values(p_subject_kind,p_subject_hash,p_provider,p_token,p_gen_time) on conflict do nothing;
end; $$;

-- Ciphertext is released only for an epoch that has started and is not revealed.
create or replace function public.engine_v3_wrapped_seed(p_mode public.execution_mode,p_epoch_start_ms bigint)
returns table(custody_provider text,key_ref text,ciphertext bytea) language plpgsql security definer set search_path='' as $$
begin
 if p_epoch_start_ms>engine_private.v3_now_ms() then raise exception 'engine_v3_epoch_not_due'; end if;
 return query select w.custody_provider,w.key_ref,w.ciphertext from engine_private.v3_wrapped_seeds w join public.engine_v3_epochs e using(execution_mode,epoch_start_ms)
  where w.execution_mode=p_mode and w.epoch_start_ms=p_epoch_start_ms and e.revealed_seed is null;
end; $$;

create or replace function public.engine_v3_publish_tick(
 p_mode public.execution_mode,p_index text,p_tick_no bigint,p_scheduled_ms bigint,p_generated_ms bigint,
 p_prev_units bigint,p_price_units bigint,p_digit smallint,p_tick_hash bytea
) returns text language plpgsql security definer set search_path='' as $$
declare v_env text:=engine_private.v3_env(); s public.engine_v3_settings%rowtype; i public.engine_indices%rowtype; e public.engine_v3_epochs%rowtype;
 v_now bigint:=engine_private.v3_now_ms(); v_shadow boolean; v_entry jsonb; v_epoch bigint; v_existing bytea; v_prev_units bigint; v_prev_hash bytea;
 v_hash bytea; v_factor numeric; v_decimals smallint; v_genesis bigint; v_state_last bigint;
begin
 select * into s from public.engine_v3_settings;
 select * into i from public.engine_indices where code=p_index and execution_mode=p_mode for update;
 if not found then raise exception 'index_not_available'; end if;
 if i.engine_generation=3 then v_shadow:=false; elsif i.v3_shadow then v_shadow:=true; else raise exception 'engine_v3_not_enabled'; end if;
 if i.v3_halted_at is not null then raise exception 'engine_v3_halted'; end if;
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
  if v_state_last<>p_tick_no-1 then raise exception 'engine_v3_sequence_gap'; end if;
 end if;
 if p_prev_units<>v_prev_units then raise exception 'engine_v3_prev_mismatch'; end if;
 if p_digit<>p_price_units%10 then raise exception 'engine_tick_digit_mismatch'; end if;
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
 perform public.engine_settle_tick(p_index,p_mode,p_tick_no);
 return 'published';
end; $$;

create or replace function public.engine_v3_publish_checkpoint(p_mode public.execution_mode,p_index text,p_tick_no bigint,p_created_ms bigint,p_checkpoint_hash bytea,p_signing_key_id text,p_signature bytea) returns void
language plpgsql security definer set search_path='' as $$
declare v_env text:=engine_private.v3_env(); v_tick_hash bytea; v_shadow boolean;
begin
 select t.v3_tick_hash into v_tick_hash from public.index_ticks t where t.index_code=p_index and t.execution_mode=p_mode and t.tick_no=p_tick_no and t.generation_version=3;
 v_shadow:=v_tick_hash is null;
 if v_shadow then
  select t.v3_tick_hash into v_tick_hash from public.engine_v3_shadow_ticks t where t.index_code=p_index and t.execution_mode=p_mode and t.tick_no=p_tick_no;
 end if;
 if v_tick_hash is null then raise exception 'engine_v3_subject_unknown'; end if;
 if abs(p_created_ms-engine_private.v3_now_ms())>60000 then raise exception 'engine_v3_clock_drift'; end if;
 if engine_private.v3_checkpoint_hash(v_env,p_mode::text,p_index,p_tick_no,v_tick_hash,p_created_ms)<>p_checkpoint_hash then raise exception 'engine_v3_checkpoint_mismatch'; end if;
 if not exists(select 1 from public.engine_v3_signing_keys where key_id=p_signing_key_id and retired_at is null) then raise exception 'engine_v3_signing_key_unknown'; end if;
 insert into public.engine_v3_checkpoints values(p_mode,p_index,p_tick_no,v_shadow,v_tick_hash,p_created_ms,p_checkpoint_hash,p_signing_key_id,p_signature)
  on conflict do nothing;
end; $$;

create or replace function public.engine_v3_reveal_epoch(p_mode public.execution_mode,p_epoch_start_ms bigint,p_seed bytea) returns void
language plpgsql security definer set search_path='' as $$
declare e public.engine_v3_epochs%rowtype; s public.engine_v3_settings%rowtype; v_blocked boolean;
begin
 select * into s from public.engine_v3_settings;
 select * into e from public.engine_v3_epochs where execution_mode=p_mode and epoch_start_ms=p_epoch_start_ms for update;
 if not found then raise exception 'engine_v3_subject_unknown'; end if;
 if e.revealed_seed is not null then return; end if;
 if engine_private.v3_now_ms()<e.epoch_end_ms+s.reveal_delay_ms then raise exception 'engine_v3_reveal_too_early'; end if;
 select exists(select 1 from public.engine_contracts c join public.engine_indices i on i.code=c.index_code and i.execution_mode=c.execution_mode
   where c.execution_mode=p_mode and c.state='OPEN' and i.engine_generation=3
   and (engine_private.v3_t0_ms(i.t0)+c.settle_tick_no*i.tick_interval_ms>=e.epoch_start_ms and engine_private.v3_t0_ms(i.t0)+c.entry_tick_no*i.tick_interval_ms<e.epoch_end_ms)) into v_blocked;
 if v_blocked then raise exception 'engine_v3_reveal_blocked_by_open_contracts'; end if;
 if engine_private.v3_seed_hash(p_seed)<>e.seed_hash then raise exception 'engine_v3_seed_mismatch'; end if;
 update public.engine_v3_epochs set revealed_seed=p_seed,revealed_at=now() where execution_mode=p_mode and epoch_start_ms=p_epoch_start_ms;
 perform engine_private.v3_log('worker','reveal_epoch',p_mode,null,jsonb_build_object('epoch_start_ms',p_epoch_start_ms));
end; $$;

create or replace function public.engine_v3_activate_cutover(p_mode public.execution_mode,p_index text) returns void
language plpgsql security definer set search_path='' as $$
declare i public.engine_indices%rowtype; s public.index_state%rowtype; v_open boolean;
begin
 select * into i from public.engine_indices where code=p_index and execution_mode=p_mode for update;
 if not found or i.engine_generation<>2 or i.v2_final_tick_no is null then raise exception 'engine_v3_cutover_not_scheduled'; end if;
 if engine_private.v3_now_ms()<i.v3_cutover_ms then raise exception 'engine_v3_cutover_not_due'; end if;
 select * into s from public.index_state where index_code=p_index and execution_mode=p_mode;
 if s.last_tick_no<>i.v2_final_tick_no then raise exception 'engine_v3_v2_not_final'; end if;
 select exists(select 1 from public.engine_contracts where index_code=p_index and execution_mode=p_mode and state='OPEN') into v_open;
 if v_open then raise exception 'engine_v3_v2_contracts_open'; end if;
 update public.engine_indices set engine_generation=3,v3_shadow=false where code=p_index and execution_mode=p_mode;
 perform engine_private.v3_log('worker','activate_cutover',p_mode,p_index,jsonb_build_object('genesis_tick_no',i.v2_final_tick_no));
end; $$;

create or replace function public.engine_v3_halt(p_mode public.execution_mode,p_index text,p_reason text) returns void
language plpgsql security definer set search_path='' as $$
begin
 update public.engine_indices set v3_halted_at=coalesce(v3_halted_at,now()),v3_halt_reason=coalesce(v3_halt_reason,left(p_reason,500))
  where code=p_index and execution_mode=p_mode;
 perform engine_private.v3_log('worker','halt',p_mode,p_index,jsonb_build_object('reason',p_reason));
end; $$;

-- Refunds contracts whose exit tick can never be produced on a halted index.
create or replace function public.engine_v3_void_unproducible(p_mode public.execution_mode,p_index text,p_reason text) returns integer
language plpgsql security definer set search_path='' as $$
declare c public.engine_contracts%rowtype; s public.index_state%rowtype; v_count integer:=0; v_halted boolean;
begin
 select exists(select 1 from public.engine_indices where code=p_index and execution_mode=p_mode and engine_generation=3 and v3_halted_at is not null) into v_halted;
 if not v_halted then raise exception 'engine_v3_not_halted'; end if;
 select * into s from public.index_state where index_code=p_index and execution_mode=p_mode;
 for c in select * from public.engine_contracts where index_code=p_index and execution_mode=p_mode and state='OPEN' and settle_tick_no>s.last_tick_no for update loop
  update public.engine_contracts set state='VOID',settled_at=now(),last_error=null where id=c.id;
  perform public.engine_post_ledger(c.trading_account_id,'void-'||c.id,'Void contract: exit tick cannot be produced',jsonb_build_array(jsonb_build_object('kind','RESERVED','amount',-c.stake),jsonb_build_object('kind','AVAILABLE','amount',c.stake)));
  insert into public.contract_events(contract_id,trading_account_id,execution_mode,event_type,reason,metadata) values(c.id,c.trading_account_id,c.execution_mode,'VOID','ENGINE_UNPRODUCIBLE',jsonb_build_object('reason',left(p_reason,500)));
  v_count:=v_count+1;
 end loop;
 perform engine_private.v3_log('worker','void_unproducible',p_mode,p_index,jsonb_build_object('count',v_count,'reason',p_reason));
 return v_count;
end; $$;

-- Everything the worker needs in one read, so the writer role holds no table grants.
create or replace function public.engine_v3_writer_state(p_mode public.execution_mode) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 return jsonb_build_object(
  'now_ms',engine_private.v3_now_ms(),'env',(select env from public.engine_v3_settings),
  'settings',(select to_jsonb(s)-'singleton' from public.engine_v3_settings s),
  'indices',coalesce((select jsonb_agg(jsonb_build_object('index',i.code,'generation',i.engine_generation,'shadow',i.v3_shadow,'halted',i.v3_halted_at is not null,
    't0_ms',engine_private.v3_t0_ms(i.t0)::text,'tick_interval_ms',i.tick_interval_ms,'decimals',i.decimals,
    'v2_final_tick_no',i.v2_final_tick_no::text,'cutover_ms',i.v3_cutover_ms::text,'state_last_tick_no',st.last_tick_no::text,
    'last',case when i.engine_generation=3 then (select jsonb_build_object('tick_no',t.tick_no::text,'price_units',round(t.price*power(10::numeric,t.generation_decimals))::text,'tick_hash',encode(t.v3_tick_hash,'hex'))
       from public.index_ticks t where t.index_code=i.code and t.execution_mode=i.execution_mode and t.generation_version=3 order by t.tick_no desc limit 1)
      else (select jsonb_build_object('tick_no',t.tick_no::text,'price_units',round(t.price*power(10::numeric,i.decimals))::text,'tick_hash',encode(t.v3_tick_hash,'hex'))
       from public.engine_v3_shadow_ticks t where t.index_code=i.code and t.execution_mode=i.execution_mode order by t.tick_no desc limit 1) end,
    'last_checkpoint_tick_no',(select max(c.tick_no)::text from public.engine_v3_checkpoints c where c.execution_mode=i.execution_mode and c.index_code=i.code and c.shadow=(i.engine_generation=2)))
    order by i.sort_order) from public.engine_indices i join public.index_state st on st.index_code=i.code and st.execution_mode=i.execution_mode where i.execution_mode=p_mode),'[]'::jsonb),
  'epochs',coalesce((select jsonb_agg(jsonb_build_object('epoch_start_ms',e.epoch_start_ms::text,'commitment',encode(e.commitment,'hex'),'config_hash',encode(e.config_hash,'hex'),
    'committed_ms',engine_private.v3_t0_ms(e.committed_at)::text,'revealed',e.revealed_seed is not null,
    'witnesses',(select coalesce(jsonb_agg(r.provider),'[]'::jsonb) from public.engine_v3_witness_receipts r where r.subject_hash=e.commitment)) order by e.epoch_start_ms)
    from public.engine_v3_epochs e where e.execution_mode=p_mode and (e.revealed_seed is null or e.epoch_start_ms>=engine_private.v3_now_ms()-3*86400000)),'[]'::jsonb),
  'latest_commitment',(select jsonb_build_object('epoch_start_ms',e.epoch_start_ms::text,'commitment',encode(e.commitment,'hex')) from public.engine_v3_epochs e where e.execution_mode=p_mode order by e.epoch_start_ms desc limit 1),
  'configs',coalesce((select jsonb_object_agg(encode(c.config_hash,'hex'),c.entries) from public.engine_v3_configs c where c.execution_mode=p_mode
    and exists(select 1 from public.engine_v3_epochs e where e.config_hash=c.config_hash and (e.revealed_seed is null or e.epoch_start_ms>=engine_private.v3_now_ms()-3*86400000))),'{}'::jsonb),
  'unwitnessed_checkpoints',coalesce((select jsonb_agg(jsonb_build_object('checkpoint_hash',encode(c.checkpoint_hash,'hex'),'witnesses',
     (select coalesce(jsonb_agg(r.provider),'[]'::jsonb) from public.engine_v3_witness_receipts r where r.subject_hash=c.checkpoint_hash)))
    from public.engine_v3_checkpoints c where c.execution_mode=p_mode and c.created_ms>engine_private.v3_now_ms()-86400000
     and (select count(*) from public.engine_v3_witness_receipts r where r.subject_hash=c.checkpoint_hash)<(select cardinality(required_witnesses) from public.engine_v3_settings)),'[]'::jsonb));
end; $$;

-- ---------------------------------------------------------------- fail-closed purchase gate
create or replace function engine_private.v3_purchase_block(p_mode public.execution_mode,p_index text,p_entry_tick bigint,p_settle_tick bigint) returns text
language plpgsql stable security definer set search_path='' as $$
declare i public.engine_indices%rowtype; st public.index_state%rowtype; s public.engine_v3_settings%rowtype; v_t0 bigint; v_now bigint:=engine_private.v3_now_ms();
 v_entry_ms bigint; v_settle_ms bigint; v_cp bigint; v_genesis bigint;
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
 if not exists(select 1 from public.engine_v3_worker_heartbeats where last_seen>now()-make_interval(secs=>s.heartbeat_timeout_ms/1000.0) and abs(clock_drift_ms)<=s.max_clock_drift_ms) then return 'engine_worker_unhealthy'; end if;
 v_entry_ms:=v_t0+p_entry_tick*i.tick_interval_ms; v_settle_ms:=v_t0+p_settle_tick*i.tick_interval_ms;
 if not engine_private.v3_epoch_witnessed(p_mode,v_entry_ms/86400000*86400000,v_entry_ms)
  or not engine_private.v3_epoch_witnessed(p_mode,v_settle_ms/86400000*86400000,v_entry_ms) then return 'engine_unwitnessed'; end if;
 select max(tick_no) into v_cp from public.engine_v3_checkpoints where execution_mode=p_mode and index_code=p_index and not shadow;
 select (engine_private.v3_entry(e.config_hash,p_index)->>'genesis_tick_no')::bigint into v_genesis from public.engine_v3_epochs e
  where e.execution_mode=p_mode and e.epoch_start_ms=v_entry_ms/86400000*86400000;
 if st.last_tick_no-coalesce(v_cp,v_genesis,st.last_tick_no)>s.max_checkpoint_gap_ticks then return 'engine_checkpoint_stale'; end if;
 return null;
end; $$;

create or replace function public.engine_v3_contract_gate() returns trigger language plpgsql security definer set search_path='' as $$
declare v_block text;
begin
 if new.state<>'OPEN' then return new; end if;
 v_block:=engine_private.v3_purchase_block(new.execution_mode,new.index_code,new.entry_tick_no,new.settle_tick_no);
 if v_block is not null then raise exception '%',v_block; end if;
 return new;
end; $$;
drop trigger if exists engine_contract_v3_gate on public.engine_contracts;
create trigger engine_contract_v3_gate before insert on public.engine_contracts for each row execute function public.engine_v3_contract_gate();

-- ---------------------------------------------------------------- v2 generator: stop at cutover, skip v3 indices
-- Same as 20260920560000 (version 1 until each index's scheduled version 2 start),
-- limited to generation-2 indices and stopped at a scheduled v3 cutover.
create or replace function public.engine_advance() returns integer language plpgsql security definer set search_path='' as $$
declare r record; v_due bigint; v_tick bigint; v_epoch uuid; v_seed bytea;
        v_units bigint; v_previous numeric; v_factor numeric; v_price numeric; v_x numeric;
        v_digit smallint; v_generated integer:=0;
begin
 perform public.engine_ensure_epochs();
 for r in select i.*,s.last_tick_no,s.last_x,s.last_price from public.engine_indices i
  join public.index_state s on s.index_code=i.code and s.execution_mode=i.execution_mode
  where i.status in ('ACTIVE','PAUSED') and i.engine_generation=2 loop
  continue when not pg_try_advisory_xact_lock(hashtextextended('engine:'||r.code||':'||r.execution_mode::text,0));
  v_due:=floor(extract(epoch from(clock_timestamp()-r.t0)*1000/r.tick_interval_ms));
  v_factor:=power(10::numeric,r.decimals);
  for v_tick in r.last_tick_no+1..least(v_due,r.last_tick_no+50,coalesce(r.v2_final_tick_no,v_due)) loop
   v_epoch:=public.engine_ensure_epoch(r.execution_mode,r.t0+(v_tick*r.tick_interval_ms)*interval '1 millisecond');
   select s.seed into v_seed from engine_private.epoch_seeds s where s.epoch_id=v_epoch;
   if v_seed is null then raise exception 'engine_epoch_seed_missing'; end if;
   if r.v2_start_tick_no is not null and v_tick>=r.v2_start_tick_no then
    v_previous:=coalesce(r.last_price,r.base_price);
    v_units:=public.engine_price_units_v2(v_seed,r.execution_mode,r.code,v_tick,
     round(v_previous*v_factor)::bigint,round(r.base_price*v_factor)::bigint,
     round(r.base_price*r.v2_sigma_per_tick*v_factor)::bigint,r.v2_kappa);
    v_price:=v_units/v_factor;
    v_digit:=mod(v_units,10)::smallint;
    v_x:=ln(v_price);
    insert into public.index_ticks(index_code,execution_mode,tick_no,epoch_id,scheduled_at,price,digit,generation_version,previous_price,generation_base_price,generation_sigma,generation_kappa,generation_decimals)
     values(r.code,r.execution_mode,v_tick,v_epoch,r.t0+(v_tick*r.tick_interval_ms)*interval '1 millisecond',v_price,v_digit,2,v_previous,r.base_price,r.v2_sigma_per_tick,r.v2_kappa,r.decimals)
     on conflict do nothing;
   else
    v_digit:=public.engine_digit(v_seed,r.execution_mode,r.code,v_tick);
    v_x:=coalesce(r.last_x,ln(r.base_price))+r.kappa*(ln(r.base_price)-coalesce(r.last_x,ln(r.base_price)))+r.sigma_per_tick*public.engine_walk_normal(v_seed,r.execution_mode,r.code,v_tick);
    v_price:=public.engine_tick_price(r.base_price,r.decimals,v_x,v_digit);
    insert into public.index_ticks(index_code,execution_mode,tick_no,epoch_id,scheduled_at,price,digit)
     values(r.code,r.execution_mode,v_tick,v_epoch,r.t0+(v_tick*r.tick_interval_ms)*interval '1 millisecond',v_price,v_digit)
     on conflict do nothing;
   end if;
   update public.index_state set last_tick_no=v_tick,last_x=v_x,last_price=v_price,updated_at=now()
    where index_code=r.code and execution_mode=r.execution_mode;
   r.last_x:=v_x; r.last_price:=v_price; v_generated:=v_generated+1;
   perform public.engine_settle_tick(r.code,r.execution_mode,v_tick);
  end loop;
 end loop;
 return v_generated;
end; $$;

-- ---------------------------------------------------------------- read surfaces
create or replace function public.get_engine_v3_status() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_now bigint:=engine_private.v3_now_ms();
begin
 if auth.uid() is null then raise exception 'unauthenticated'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object(
  'index_code',i.code,'execution_mode',i.execution_mode,'engine_generation',i.engine_generation,'shadow',i.v3_shadow,
  'cutover_ms',i.v3_cutover_ms,'v2_final_tick_no',i.v2_final_tick_no,'halted',i.v3_halted_at is not null,
  'current_epoch_witnessed',engine_private.v3_epoch_witnessed(i.execution_mode,v_now/86400000*86400000,v_now),
  'purchase_block',case when i.engine_generation=3 then engine_private.v3_purchase_block(i.execution_mode,i.code,s.last_tick_no+1,s.last_tick_no+1) end
 ) order by i.execution_mode,i.sort_order) from public.engine_indices i join public.index_state s on s.index_code=i.code and s.execution_mode=i.execution_mode),'[]'::jsonb);
end; $$;

create or replace function public.get_admin_engine_v3_health() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_now bigint:=engine_private.v3_now_ms();
begin
 perform admin_private.require_staff('engine.read');
 return jsonb_build_object(
  'settings',(select to_jsonb(s) from public.engine_v3_settings s),
  'workers',coalesce((select jsonb_agg(to_jsonb(w) order by w.last_seen desc) from public.engine_v3_worker_heartbeats w),'[]'::jsonb),
  'epochs',coalesce((select jsonb_agg(jsonb_build_object('execution_mode',e.execution_mode,'epoch_start_ms',e.epoch_start_ms,'committed_at',e.committed_at,
     'witnesses',(select coalesce(jsonb_agg(jsonb_build_object('provider',r.provider,'gen_time',r.gen_time)),'[]'::jsonb) from public.engine_v3_witness_receipts r where r.subject_hash=e.commitment),
     'revealed',e.revealed_seed is not null,'reveal_overdue',e.revealed_seed is null and v_now>e.epoch_end_ms+86400000) order by e.epoch_start_ms desc)
     from (select * from public.engine_v3_epochs order by epoch_start_ms desc limit 14) e),'[]'::jsonb),
  'indices',public.get_engine_v3_status(),
  'shadow',coalesce((select jsonb_agg(jsonb_build_object('index_code',t.index_code,'last_tick_no',max_tick,'ticks',n)) from
     (select index_code,max(tick_no) max_tick,count(*) n from public.engine_v3_shadow_ticks group by index_code) t),'[]'::jsonb),
  'events',coalesce((select jsonb_agg(to_jsonb(ev) order by ev.id desc) from (select * from public.engine_v3_events order by id desc limit 50) ev),'[]'::jsonb));
end; $$;

-- Proof package for the offline verifier (verifier/v3). Ranges start at an
-- anchored point: genesis, or the latest signed checkpoint before p_from.
create or replace function public.get_v3_proof_package(p_account_id uuid,p_index text,p_from bigint,p_to bigint) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v_mode public.execution_mode; v_env text:=engine_private.v3_env(); v_first record; v_config bytea; v_genesis bigint; v_start bigint;
 v_anchor public.engine_v3_checkpoints%rowtype; v_anchor_tick jsonb; v_min_epoch bigint; v_max_epoch bigint; v_result jsonb;
begin
 v_mode:=public.engine_assert_account_access(p_account_id);
 if p_from is null or p_to is null or p_from<1 or p_to<p_from or p_to-p_from>=5000 then raise exception 'validation_failed'; end if;
 select t.v3_config_hash cfg into v_first from public.index_ticks t where t.index_code=p_index and t.execution_mode=v_mode and t.generation_version=3 and t.tick_no>=p_from order by t.tick_no limit 1;
 if v_first is null then raise exception 'not_found'; end if;
 v_config:=v_first.cfg;
 if (select count(distinct t.v3_config_hash) from public.index_ticks t where t.index_code=p_index and t.execution_mode=v_mode and t.generation_version=3 and t.tick_no between p_from and p_to)>1 then
  raise exception 'engine_v3_range_spans_config_change';
 end if;
 v_genesis:=(engine_private.v3_entry(v_config,p_index)->>'genesis_tick_no')::bigint;
 v_start:=greatest(p_from,v_genesis+1);
 if v_start>v_genesis+1 then
  select * into v_anchor from public.engine_v3_checkpoints c where c.execution_mode=v_mode and c.index_code=p_index and not c.shadow and c.tick_no<v_start and c.tick_no>v_genesis order by c.tick_no desc limit 1;
  if found then v_start:=v_anchor.tick_no+1; else v_start:=v_genesis+1; end if;
 end if;
 if p_to-v_start>=5500 then raise exception 'validation_failed'; end if;
 select min(v3_epoch_start_ms),max(v3_epoch_start_ms) into v_min_epoch,v_max_epoch from public.index_ticks where index_code=p_index and execution_mode=v_mode and generation_version=3 and tick_no between v_start-1 and p_to;
 if v_anchor.tick_no is not null then
  select jsonb_build_object('index',t.index_code,'tick_no',t.tick_no::text,'scheduled_ms',engine_private.v3_t0_ms(t.scheduled_at)::text,'generated_ms',t.v3_generated_ms::text,
   'epoch_start_ms',t.v3_epoch_start_ms::text,'prev_units',round(t.previous_price*power(10::numeric,t.generation_decimals))::text,'price_units',round(t.price*power(10::numeric,t.generation_decimals))::text,'decimals',t.generation_decimals,'digit',t.digit,
   'config_hash',encode(t.v3_config_hash,'hex'),'commitment',encode(t.v3_commitment,'hex'),'prev_tick_hash',encode(t.v3_prev_tick_hash,'hex'),'tick_hash',encode(t.v3_tick_hash,'hex'))
   into v_anchor_tick from public.index_ticks t where t.index_code=p_index and t.execution_mode=v_mode and t.tick_no=v_anchor.tick_no;
 end if;
 select jsonb_build_object(
  'format','smartprofit-proof/v3','env',v_env,'mode',v_mode::text,
  'config',jsonb_build_object('indices',(select entries from public.engine_v3_configs where config_hash=v_config)),
  'signing_keys',coalesce((select jsonb_agg(jsonb_build_object('key_id',k.key_id,'algorithm',k.algorithm,'public_key',encode(k.public_key,'hex'))) from public.engine_v3_signing_keys k),'[]'::jsonb),
  'epochs',coalesce((select jsonb_agg(jsonb_build_object('epoch_start_ms',e.epoch_start_ms::text,'epoch_end_ms',e.epoch_end_ms::text,'seed_hash',encode(e.seed_hash,'hex'),
    'config_hash',encode(e.config_hash,'hex'),'prev_commitment',encode(e.prev_commitment,'hex'),'commitment',encode(e.commitment,'hex'),
    'revealed_seed',case when e.epoch_start_ms between v_min_epoch and v_max_epoch then encode(e.revealed_seed,'hex') end,
    'signing_key_id',e.signing_key_id,'signature',encode(e.signature,'hex'),
    'witness',coalesce((select jsonb_agg(jsonb_build_object('provider',r.provider,'token',encode(r.token,'base64'),'gen_time',r.gen_time)) from public.engine_v3_witness_receipts r where r.subject_hash=e.commitment),'[]'::jsonb))
    order by e.epoch_start_ms) from public.engine_v3_epochs e where e.execution_mode=v_mode and e.epoch_start_ms<=v_max_epoch),'[]'::jsonb),
  'anchors',case when v_anchor_tick is null then '{}'::jsonb else jsonb_build_object(p_index,jsonb_build_object('tick',v_anchor_tick,'checkpoint',
    jsonb_build_object('tick_no',v_anchor.tick_no::text,'tick_hash',encode(v_anchor.tick_hash,'hex'),'created_ms',v_anchor.created_ms::text,'checkpoint_hash',encode(v_anchor.checkpoint_hash,'hex'),
     'signing_key_id',v_anchor.signing_key_id,'signature',encode(v_anchor.signature,'hex'),
     'witness',coalesce((select jsonb_agg(jsonb_build_object('provider',r.provider,'token',encode(r.token,'base64'),'gen_time',r.gen_time)) from public.engine_v3_witness_receipts r where r.subject_hash=v_anchor.checkpoint_hash),'[]'::jsonb)))) end,
  'ticks',coalesce((select jsonb_agg(jsonb_build_object('index',t.index_code,'tick_no',t.tick_no::text,'scheduled_ms',engine_private.v3_t0_ms(t.scheduled_at)::text,'generated_ms',t.v3_generated_ms::text,
    'epoch_start_ms',t.v3_epoch_start_ms::text,'prev_units',round(t.previous_price*power(10::numeric,t.generation_decimals))::text,'price_units',round(t.price*power(10::numeric,t.generation_decimals))::text,
    'decimals',t.generation_decimals,'digit',t.digit,'config_hash',encode(t.v3_config_hash,'hex'),'commitment',encode(t.v3_commitment,'hex'),
    'prev_tick_hash',encode(t.v3_prev_tick_hash,'hex'),'tick_hash',encode(t.v3_tick_hash,'hex')) order by t.tick_no)
    from public.index_ticks t where t.index_code=p_index and t.execution_mode=v_mode and t.generation_version=3 and t.tick_no between v_start and p_to),'[]'::jsonb),
  'checkpoints',coalesce((select jsonb_agg(jsonb_build_object('index',c.index_code,'tick_no',c.tick_no::text,'tick_hash',encode(c.tick_hash,'hex'),'created_ms',c.created_ms::text,
    'checkpoint_hash',encode(c.checkpoint_hash,'hex'),'signing_key_id',c.signing_key_id,'signature',encode(c.signature,'hex')) order by c.tick_no)
    from public.engine_v3_checkpoints c where c.execution_mode=v_mode and c.index_code=p_index and not c.shadow and c.tick_no between v_start and p_to),'[]'::jsonb),
  'contracts',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'index',c.index_code,'contract_type',c.contract_type,'barrier',c.barrier,
    'entry_tick_no',c.entry_tick_no::text,'settle_tick_no',c.settle_tick_no::text,'result',c.state) order by c.settle_tick_no)
    from public.engine_contracts c where c.trading_account_id=p_account_id and c.index_code=p_index and c.state in ('WON','LOST','VOID') and c.settle_tick_no between v_start and p_to),'[]'::jsonb)
 ) into v_result;
 return v_result;
end; $$;

-- ---------------------------------------------------------------- grants
do $$
declare f record;
begin
 for f in select p.oid::regprocedure sig,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where (n.nspname='public' and (p.proname like 'engine\_v3\_%' or p.proname in ('get_engine_v3_status','get_admin_engine_v3_health','get_v3_proof_package')))
     or (n.nspname='engine_private' and p.proname like 'v3\_%') loop
  execute format('revoke all on function %s from public,anon,authenticated,service_role',f.sig);
 end loop;
end $$;
grant execute on function
 public.engine_v3_heartbeat(text,bigint,text,text),public.engine_v3_writer_state(public.execution_mode),public.engine_v3_register_signing_key(text,bytea),public.engine_v3_register_config(public.execution_mode,jsonb),
 public.engine_v3_commit_epoch(public.execution_mode,bigint,bytea,bytea,bytea,bytea,text,bytea,text,text,bytea),
 public.engine_v3_record_witness(text,bytea,text,bytea,timestamptz),public.engine_v3_wrapped_seed(public.execution_mode,bigint),
 public.engine_v3_publish_tick(public.execution_mode,text,bigint,bigint,bigint,bigint,bigint,smallint,bytea),
 public.engine_v3_publish_checkpoint(public.execution_mode,text,bigint,bigint,bytea,text,bytea),
 public.engine_v3_reveal_epoch(public.execution_mode,bigint,bytea),public.engine_v3_activate_cutover(public.execution_mode,text),
 public.engine_v3_halt(public.execution_mode,text,text),public.engine_v3_void_unproducible(public.execution_mode,text,text)
 to engine_tick_writer;
grant execute on function public.engine_v3_configure(text,jsonb,text),public.engine_v3_set_shadow(public.execution_mode,text,boolean,text),
 public.engine_v3_schedule_cutover(public.execution_mode,text,bigint,text),public.get_engine_v3_status(),public.get_admin_engine_v3_health(),
 public.get_v3_proof_package(uuid,text,bigint,bigint) to authenticated;
