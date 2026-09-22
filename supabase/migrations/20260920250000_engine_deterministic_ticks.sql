create or replace function public.engine_digit(p_seed bytea,p_mode public.execution_mode,p_index text,p_tick_no bigint) returns smallint language plpgsql immutable security definer set search_path='' as $$
declare k integer:=0; b bytea; i integer; value integer;
begin
 loop
  b:=hmac(convert_to('digit|'||p_mode::text||'|'||p_index||'|'||p_tick_no::text||'|'||k::text,'utf8'),p_seed,'sha256');
  for i in 0..31 loop value:=get_byte(b,i); if value<250 then return (value%10)::smallint; end if; end loop;
  k:=k+1;
 end loop;
end; $$;

create or replace function public.engine_tick_price(p_base numeric,p_decimals smallint,p_x numeric,p_digit smallint) returns numeric language sql immutable security definer set search_path='' as $$
 select (floor(exp(p_x)/(10*power(10::numeric,-p_decimals)))*10+p_digit)*power(10::numeric,-p_decimals) $$;

create or replace function public.engine_ensure_epoch(p_mode public.execution_mode,p_time timestamptz) returns uuid language plpgsql security definer set search_path='' as $$
declare start_time timestamptz:=date_trunc('day',p_time); epoch_id uuid; seed bytea; commitment text; previous text;
begin
 select id into epoch_id from public.engine_epochs where execution_mode=p_mode and starts_at=start_time; if found then return epoch_id; end if;
 seed:=public.gen_random_bytes(32); commitment:=encode(digest(seed,'sha256'),'hex'); select chain_hash into previous from public.engine_epochs where execution_mode=p_mode order by starts_at desc limit 1;
 insert into public.engine_epochs(execution_mode,starts_at,ends_at,seed_commitment,prev_chain_hash,chain_hash) values(p_mode,start_time,start_time+interval '1 day',commitment,previous,encode(digest(coalesce(previous,'')||p_mode::text||commitment,'sha256'),'hex')) returning id into epoch_id;
 insert into engine_private.epoch_seeds(epoch_id,execution_mode,seed) values(epoch_id,p_mode,seed); return epoch_id;
end; $$;

create or replace function public.engine_advance() returns integer language plpgsql security definer set search_path='' as $$
declare r record; due bigint; n bigint; epoch_id uuid; seed bytea; d smallint; x numeric; generated integer:=0;
begin
 for r in select i.*,s.last_tick_no,s.last_x from public.engine_indices i join public.index_state s on s.index_code=i.code and s.execution_mode=i.execution_mode where i.status in ('ACTIVE','PAUSED') loop
  continue when not pg_try_advisory_xact_lock(hashtextextended('engine:'||r.code||':'||r.execution_mode::text,0));
  due:=floor(extract(epoch from(clock_timestamp()-r.t0)*1000/r.tick_interval_ms));
  for n in r.last_tick_no+1..least(due,r.last_tick_no+50) loop
   epoch_id:=public.engine_ensure_epoch(r.execution_mode,r.t0+(n*r.tick_interval_ms)*interval '1 millisecond'); select seed into seed from engine_private.epoch_seeds where epoch_id=epoch_id;
   d:=public.engine_digit(seed,r.execution_mode,r.code,n); x:=coalesce(r.last_x,ln(r.base_price));
   insert into public.index_ticks(index_code,execution_mode,tick_no,epoch_id,scheduled_at,price,digit) values(r.code,r.execution_mode,n,epoch_id,r.t0+(n*r.tick_interval_ms)*interval '1 millisecond',public.engine_tick_price(r.base_price,r.decimals,x,d),d);
   update public.index_state set last_tick_no=n,last_x=x,last_price=public.engine_tick_price(r.base_price,r.decimals,x,d),updated_at=now() where index_code=r.code and execution_mode=r.execution_mode; r.last_x:=x; generated:=generated+1;
   perform public.engine_settle_tick(r.code,r.execution_mode,n);
  end loop;
 end loop; return generated;
end; $$;
revoke all on function public.engine_advance() from public,anon,authenticated;
