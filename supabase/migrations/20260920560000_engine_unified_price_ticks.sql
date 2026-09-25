-- Version 2 generates a price first. Its final decimal digit is the contract
-- outcome. Keep version 1 ticks and their published proofs intact.
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

create or replace function public.engine_advance() returns integer language plpgsql security definer set search_path='' as $$
declare r record; v_due bigint; v_tick bigint; v_epoch uuid; v_seed bytea;
        v_units bigint; v_previous numeric; v_factor numeric; v_price numeric;
        v_digit smallint; v_generated integer:=0;
begin
 perform public.engine_ensure_epochs();
 for r in select i.*,s.last_tick_no,s.last_price from public.engine_indices i
  join public.index_state s on s.index_code=i.code and s.execution_mode=i.execution_mode
  where i.status in ('ACTIVE','PAUSED') loop
  continue when not pg_try_advisory_xact_lock(hashtextextended('engine:'||r.code||':'||r.execution_mode::text,0));
  v_due:=floor(extract(epoch from(clock_timestamp()-r.t0)*1000/r.tick_interval_ms));
  v_factor:=power(10::numeric,r.decimals);
  for v_tick in r.last_tick_no+1..least(v_due,r.last_tick_no+50) loop
   v_epoch:=public.engine_ensure_epoch(r.execution_mode,r.t0+(v_tick*r.tick_interval_ms)*interval '1 millisecond');
   select s.seed into v_seed from engine_private.epoch_seeds s where s.epoch_id=v_epoch;
   if v_seed is null then raise exception 'engine_epoch_seed_missing'; end if;
   v_previous:=coalesce(r.last_price,r.base_price);
   v_units:=public.engine_price_units_v2(v_seed,r.execution_mode,r.code,v_tick,
    round(v_previous*v_factor)::bigint,round(r.base_price*v_factor)::bigint,
    round(r.base_price*r.sigma_per_tick*v_factor)::bigint,r.kappa);
   v_price:=v_units/v_factor;
   v_digit:=mod(v_units,10)::smallint;
   insert into public.index_ticks(index_code,execution_mode,tick_no,epoch_id,scheduled_at,price,digit,generation_version,previous_price,generation_base_price,generation_sigma,generation_kappa,generation_decimals)
    values(r.code,r.execution_mode,v_tick,v_epoch,r.t0+(v_tick*r.tick_interval_ms)*interval '1 millisecond',v_price,v_digit,2,v_previous,r.base_price,r.sigma_per_tick,r.kappa,r.decimals)
    on conflict do nothing;
   update public.index_state set last_tick_no=v_tick,last_x=ln(v_price),last_price=v_price,updated_at=now()
    where index_code=r.code and execution_mode=r.execution_mode;
   r.last_price:=v_price; v_generated:=v_generated+1;
   perform public.engine_settle_tick(r.code,r.execution_mode,v_tick);
  end loop;
 end loop;
 return v_generated;
end; $$;

-- A stronger anchor limits long excursions. The five series retain ordered,
-- distinct movement levels; names are levels, not annualised percentages.
update public.engine_indices set kappa=.003,
 sigma_per_tick=case code when 'SPI10' then .0002 when 'SPI25' then .00035
  when 'SPI50' then .0005 when 'SPI75' then .00075 else .001 end
 where execution_mode='DEMO';

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
