-- Version 2 generates a price first. Its final decimal digit is the contract
-- outcome. Keep version 1 ticks and their published proofs intact.
--
-- Applying this migration changes no live price. Each index keeps generating
-- version 1 ticks, with its version 1 parameters, until its scheduled
-- v2_start_tick_no. The start is set by an engine manager (or a SQL operator)
-- for the start of a UTC day at least 12 hours ahead, so it can be announced.
-- The engine_advance cron job runs every second and locks engine_indices before
-- index_state and index_ticks. Take every lock this migration needs up front, in
-- that order, so it waits for an in-flight tick instead of deadlocking with it.
-- New ticks queue behind it for the moment it runs; a busy database fails the
-- migration cleanly after 15 s and it can be pushed again.
set local lock_timeout = '15s';
lock table public.engine_indices, public.index_state, public.index_ticks in access exclusive mode;

alter table public.index_ticks
 add column generation_version smallint not null default 1 check (generation_version in (1,2)),
 add column previous_price numeric,
 add column generation_base_price numeric,
 add column generation_sigma numeric,
 add column generation_kappa numeric,
 add column generation_decimals smallint;
alter table public.index_ticks add constraint index_ticks_v2_previous_price
 check (generation_version <> 2 or (previous_price > 0 and generation_base_price > 0
  and generation_sigma > 0 and generation_kappa >= 0 and generation_kappa < 1
  and generation_decimals between 2 and 5));

-- Version 2 parameters are separate from version 1's sigma_per_tick and kappa,
-- which stay in force until the index's first version 2 tick.
alter table public.engine_indices
 add column v2_start_tick_no bigint check (v2_start_tick_no > 0),
 add column v2_sigma_per_tick numeric check (v2_sigma_per_tick > 0),
 add column v2_kappa numeric check (v2_kappa >= 0 and v2_kappa < 1),
 add constraint engine_indices_v2_parameters check (v2_start_tick_no is null or (v2_sigma_per_tick is not null and v2_kappa is not null));

create or replace function public.engine_price_units_v2(
 p_seed bytea,p_mode public.execution_mode,p_index text,p_tick_no bigint,
 p_previous_units bigint,p_base_units bigint,p_sigma_units bigint,p_kappa numeric
) returns bigint language plpgsql immutable security definer set search_path='' as $$
declare v_block bytea; v_sum integer:=0; v_i integer; v_counter integer:=0;
        v_residue integer:=null; v_coarse bigint; v_pull bigint; v_jitter integer;
begin
 if p_previous_units<=0 or p_base_units<=0 or p_sigma_units<1 or p_kappa<0 or p_kappa>=1 then
  raise exception 'engine_price_parameters_invalid';
 end if;
 v_block:=public.hmac(convert_to('price-v2|'||p_mode::text||'|'||p_index||'|'||p_tick_no::text||'|0','utf8'),p_seed,'sha256');
 for v_i in 0..11 loop v_sum:=v_sum+get_byte(v_block,v_i); end loop;
 -- The twelve bytes give a bounded, approximately normal coarse price move.
 -- A rejection-sampled residue makes every final price digit exactly uniform.
 loop
  for v_i in 12..30 loop
   if get_byte(v_block,v_i)<250 then v_residue:=mod(get_byte(v_block,v_i),10); exit; end if;
  end loop;
  exit when v_residue is not null;
  v_counter:=v_counter+1;
  v_block:=public.hmac(convert_to('price-v2|'||p_mode::text||'|'||p_index||'|'||p_tick_no::text||'|'||v_counter::text,'utf8'),p_seed,'sha256');
 end loop;
 v_coarse:=trunc((v_sum-1530)::numeric*p_sigma_units/2560)::bigint;
 v_pull:=trunc(p_kappa*(p_base_units-p_previous_units))::bigint;
 v_jitter:=v_residue-case when mod(get_byte(v_block,31),2)=0 then 4 else 5 end;
 if p_previous_units+v_pull+10*v_coarse+v_jitter<=0 then raise exception 'engine_price_out_of_range'; end if;
 return p_previous_units+v_pull+10*v_coarse+v_jitter;
end; $$;

-- Ticks before an index's v2_start_tick_no (or all ticks, while it is unset) are
-- produced exactly as by the version 1 engine_advance. The first version 2 tick
-- continues from the last version 1 price.
create or replace function public.engine_advance() returns integer language plpgsql security definer set search_path='' as $$
declare r record; v_due bigint; v_tick bigint; v_epoch uuid; v_seed bytea;
        v_units bigint; v_previous numeric; v_factor numeric; v_price numeric; v_x numeric;
        v_digit smallint; v_generated integer:=0;
begin
 perform public.engine_ensure_epochs();
 for r in select i.*,s.last_tick_no,s.last_x,s.last_price from public.engine_indices i
  join public.index_state s on s.index_code=i.code and s.execution_mode=i.execution_mode
  where i.status in ('ACTIVE','PAUSED') loop
  continue when not pg_try_advisory_xact_lock(hashtextextended('engine:'||r.code||':'||r.execution_mode::text,0));
  v_due:=floor(extract(epoch from(clock_timestamp()-r.t0)*1000/r.tick_interval_ms));
  v_factor:=power(10::numeric,r.decimals);
  for v_tick in r.last_tick_no+1..least(v_due,r.last_tick_no+50) loop
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

-- Version 2 parameters: a stronger anchor limits long excursions. The five
-- series retain ordered, distinct movement levels; names are levels, not
-- annualised percentages. They take effect only from each index's first
-- version 2 tick.
update public.engine_indices set v2_kappa=.003,
 v2_sigma_per_tick=case code when 'SPI10' then .0002 when 'SPI25' then .00035
  when 'SPI50' then .0005 when 'SPI75' then .00075 else .001 end
 where execution_mode='DEMO';

-- Validates and records a version 2 start. Returns the first version 2 tick,
-- the first tick scheduled at or after p_start.
create or replace function engine_private.v2_schedule_start(p_mode public.execution_mode,p_index text,p_start timestamptz)
returns bigint language plpgsql security definer set search_path='' as $$
declare i public.engine_indices%rowtype; v_last bigint; v_tick bigint;
begin
 select * into i from public.engine_indices where code=p_index and execution_mode=p_mode for update;
 if not found then raise exception 'index_not_available'; end if;
 if i.v2_sigma_per_tick is null or i.v2_kappa is null then raise exception 'engine_v2_parameters_missing'; end if;
 if p_start is null or mod((extract(epoch from p_start)*1000)::numeric,86400000)<>0 then raise exception 'engine_v2_start_not_boundary'; end if;
 if p_start<now()+interval '12 hours' then raise exception 'engine_v2_notice_too_short'; end if;
 select last_tick_no into v_last from public.index_state where index_code=p_index and execution_mode=p_mode;
 if i.v2_start_tick_no is not null and coalesce(v_last,0)>=i.v2_start_tick_no then raise exception 'engine_v2_already_started'; end if;
 v_tick:=ceil((extract(epoch from p_start-i.t0)*1000)::numeric/i.tick_interval_ms)::bigint;
 if v_tick<=coalesce(v_last,0) then raise exception 'engine_v2_start_too_late'; end if;
 update public.engine_indices set v2_start_tick_no=v_tick where code=p_index and execution_mode=p_mode;
 return v_tick;
end; $$;

-- Engine manager, from the app, with a TOTP verification in the last 10 minutes.
create or replace function public.engine_schedule_v2_start(p_mode public.execution_mode,p_index text,p_start timestamptz,p_reason text)
returns bigint language plpgsql security definer set search_path='' as $$
declare v_actor record; v_before bigint; v_tick bigint;
begin
 v_actor:=admin_private.require_staff('engine.manage',true);
 if char_length(btrim(coalesce(p_reason,''))) not between 10 and 500 then raise exception 'validation_failed'; end if;
 select v2_start_tick_no into v_before from public.engine_indices where code=p_index and execution_mode=p_mode;
 v_tick:=engine_private.v2_schedule_start(p_mode,p_index,p_start);
 insert into public.admin_audit_events(actor_id,actor_type,action,target_type,target_id,correlation_id,reason,before_state,after_state)
 values(v_actor.user_id,'staff','engine.schedule_v2_start','engine_index',md5('engine_index:'||p_mode::text||':'||p_index)::uuid,gen_random_uuid(),btrim(p_reason),
  jsonb_build_object('v2_start_tick_no',v_before),jsonb_build_object('index',p_index,'mode',p_mode,'starts_at',p_start,'v2_start_tick_no',v_tick));
 return v_tick;
end; $$;

-- Trusted SQL operator (database owner session, e.g. the Supabase SQL editor).
-- Not executable through the API.
create or replace function engine_private.operator_schedule_v2_start(p_mode public.execution_mode,p_index text,p_start timestamptz,p_reason text)
returns bigint language plpgsql security definer set search_path='' as $$
declare v_before bigint; v_tick bigint;
begin
 if char_length(btrim(coalesce(p_reason,''))) not between 10 and 500 then raise exception 'validation_failed'; end if;
 select v2_start_tick_no into v_before from public.engine_indices where code=p_index and execution_mode=p_mode;
 v_tick:=engine_private.v2_schedule_start(p_mode,p_index,p_start);
 insert into public.admin_audit_events(actor_type,action,target_type,target_id,correlation_id,reason,before_state,after_state)
 values('operator','engine.schedule_v2_start','engine_index',md5('engine_index:'||p_mode::text||':'||p_index)::uuid,gen_random_uuid(),btrim(p_reason),
  jsonb_build_object('v2_start_tick_no',v_before),jsonb_build_object('index',p_index,'mode',p_mode,'starts_at',p_start,'v2_start_tick_no',v_tick));
 return v_tick;
end; $$;

-- Customers see each index's scheduled version 2 start (the scheduled time of its first version 2 tick).
create or replace function public.get_engine_config() returns jsonb language sql security definer set search_path='' as $$
with current_policy as (select * from public.engine_policy_versions order by version desc limit 1)
select jsonb_build_object(
 'ledger_asset',public.engine_ledger_asset(),
 'real_enabled',public.module_enabled('real_accounts'),
 'server_time',now(),
 'policy_version',(select version from current_policy),
 'enabled_contract_types',(select enabled_contract_types from current_policy),
 'indices',coalesce((select jsonb_agg(jsonb_build_object('code',i.code,'display_name',i.display_name,'interval_ms',i.tick_interval_ms,'decimals',i.decimals,'status',i.status,'execution_mode',i.execution_mode,
  'v2_starts_at',case when i.v2_start_tick_no is not null then i.t0+(i.v2_start_tick_no*i.tick_interval_ms)*interval '1 millisecond' end) order by i.execution_mode,i.sort_order) from public.engine_indices i where i.execution_mode='DEMO'),'[]'::jsonb),
 'accounts',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'execution_mode',a.execution_mode,'currency',public.engine_ledger_asset(),'status',a.status,'limits',jsonb_build_object('min_stake',l.min_stake,'max_stake',l.max_stake,'max_open_contracts',l.max_open_contracts,'max_buys_per_minute',l.max_buys_per_minute,'max_liability_per_tick',l.max_liability_per_tick)) order by a.execution_mode) from public.trading_accounts a left join public.engine_policy_limits l on l.execution_mode=a.execution_mode and l.policy_version=(select version from current_policy) where a.user_id=auth.uid()),'[]'::jsonb)
) $$;

create function public.get_tick_verification_data(p_account_id uuid,p_index text,p_after_tick_no bigint,p_limit integer default 500)
returns table(index_code text,tick_no bigint,scheduled_at timestamptz,price numeric,digit smallint,
 generation_version smallint,previous_price numeric,generation_base_price numeric,
 generation_sigma numeric,generation_kappa numeric,generation_decimals smallint)
language plpgsql security definer set search_path='' as $$
declare v_mode public.execution_mode;
begin
 v_mode:=public.engine_assert_account_access(p_account_id);
 if not exists(select 1 from public.engine_indices where code=p_index and execution_mode=v_mode) then raise exception 'index_not_available'; end if;
 return query select t.index_code,t.tick_no,t.scheduled_at,t.price,t.digit,t.generation_version,
  t.previous_price,t.generation_base_price,t.generation_sigma,t.generation_kappa,t.generation_decimals
  from public.index_ticks t where t.index_code=p_index and t.execution_mode=v_mode
   and t.tick_no>coalesce(p_after_tick_no,0) order by t.tick_no
  limit least(greatest(coalesce(p_limit,500),1),500);
end; $$;
revoke all on function public.get_tick_verification_data(uuid,text,bigint,integer) from public,anon;
grant execute on function public.get_tick_verification_data(uuid,text,bigint,integer) to authenticated;

revoke all on function public.engine_price_units_v2(bytea,public.execution_mode,text,bigint,bigint,bigint,bigint,numeric)
 from public,anon,authenticated;
revoke all on function engine_private.v2_schedule_start(public.execution_mode,text,timestamptz) from public,anon,authenticated,service_role;
revoke all on function engine_private.operator_schedule_v2_start(public.execution_mode,text,timestamptz,text) from public,anon,authenticated,service_role;
revoke all on function public.engine_schedule_v2_start(public.execution_mode,text,timestamptz,text) from public,anon,service_role;
grant execute on function public.engine_schedule_v2_start(public.execution_mode,text,timestamptz,text) to authenticated;
