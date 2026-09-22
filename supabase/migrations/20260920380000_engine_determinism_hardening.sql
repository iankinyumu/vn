-- Correctness hardening for the proprietary deterministic engine.  This is a
-- forward-only migration: prior engine migrations remain an audit record.

create or replace function public.engine_u53(p_block bytea, p_offset integer) returns numeric language plpgsql immutable security definer set search_path='' as $$
declare v numeric:=0; i integer;
begin
 if octet_length(p_block)<p_offset+7 then raise exception 'engine_random_block_too_short'; end if;
 for i in p_offset..p_offset+6 loop v:=v*256+get_byte(p_block,i); end loop;
 return floor(v/8);
end; $$;

create or replace function public.engine_digit(p_seed bytea,p_mode public.execution_mode,p_index text,p_tick_no bigint) returns smallint language plpgsql immutable security definer set search_path='' as $$
declare k integer:=0; b bytea; i integer; value integer;
begin
 loop
  b:=public.hmac(convert_to('digit|'||p_mode::text||'|'||p_index||'|'||p_tick_no::text||'|'||k::text,'utf8'),p_seed,'sha256');
  for i in 0..31 loop value:=get_byte(b,i); if value<250 then return (value%10)::smallint; end if; end loop;
  k:=k+1;
 end loop;
end; $$;

create or replace function public.engine_walk_normal(p_seed bytea,p_mode public.execution_mode,p_index text,p_tick_no bigint) returns numeric language plpgsql immutable security definer set search_path='' as $$
declare b bytea; u1 numeric; u2 numeric;
begin
 b:=public.hmac(convert_to('walk|'||p_mode::text||'|'||p_index||'|'||p_tick_no::text||'|0','utf8'),p_seed,'sha256');
 u1:=(public.engine_u53(b,0)+.5)/9007199254740992::numeric;
 u2:=(public.engine_u53(b,7)+.5)/9007199254740992::numeric;
 return sqrt(-2*ln(u1))*cos(2*pi()*u2);
end; $$;

create or replace function public.engine_tick_price(p_base numeric,p_decimals smallint,p_x numeric,p_digit smallint) returns numeric language sql immutable security definer set search_path='' as $$
 select (floor(exp(p_x)/(10*power(10::numeric,-p_decimals))*1)::numeric*10+p_digit)*power(10::numeric,-p_decimals) $$;

create or replace function public.assert_engine_tick_digit() returns trigger language plpgsql set search_path='' as $$
declare v_decimals smallint; v_units numeric;
begin
 select decimals into v_decimals from public.engine_indices where code=new.index_code and execution_mode=new.execution_mode;
 if v_decimals is null then raise exception 'engine_index_missing'; end if;
 v_units:=round(new.price/power(10::numeric,-v_decimals));
 if mod(v_units::bigint,10)<>new.digit then raise exception 'engine_tick_digit_mismatch'; end if;
 return new;
end; $$;

drop trigger if exists index_ticks_digit_invariant on public.index_ticks;
create trigger index_ticks_digit_invariant before insert on public.index_ticks for each row execute function public.assert_engine_tick_digit();

create or replace function public.assert_engine_epoch_immutable() returns trigger language plpgsql set search_path='' as $$
begin
 if new.id is distinct from old.id or new.execution_mode is distinct from old.execution_mode or new.starts_at is distinct from old.starts_at or new.ends_at is distinct from old.ends_at or new.seed_commitment is distinct from old.seed_commitment or new.prev_chain_hash is distinct from old.prev_chain_hash or new.chain_hash is distinct from old.chain_hash or new.committed_at is distinct from old.committed_at then raise exception 'engine_epoch_immutable'; end if;
 if old.revealed_at is not null then raise exception 'engine_epoch_already_revealed'; end if;
 if new.revealed_at is null or new.revealed_seed is null then raise exception 'engine_epoch_reveal_required'; end if;
 return new;
end; $$;

drop trigger if exists engine_epochs_immutable on public.engine_epochs;
create trigger engine_epochs_immutable before update or delete on public.engine_epochs for each row execute function public.assert_engine_epoch_immutable();

create or replace function public.engine_ensure_epoch(p_mode public.execution_mode,p_time timestamptz) returns uuid language plpgsql security definer set search_path='' as $$
declare v_start timestamptz:=date_trunc('day',p_time); v_id uuid:=public.gen_random_uuid(); v_seed bytea; v_commitment text; v_previous text;
begin
 perform pg_advisory_xact_lock(hashtextextended('engine-epoch:'||p_mode::text||':'||v_start::text,0));
 select id into v_id from public.engine_epochs where execution_mode=p_mode and starts_at=v_start;
 if found then return v_id; end if;
 v_seed:=public.gen_random_bytes(32); v_commitment:=encode(public.digest(v_seed,'sha256'),'hex');
 select chain_hash into v_previous from public.engine_epochs where execution_mode=p_mode order by starts_at desc limit 1;
 insert into public.engine_epochs(id,execution_mode,starts_at,ends_at,seed_commitment,prev_chain_hash,chain_hash)
 values(v_id,p_mode,v_start,v_start+interval '1 day',v_commitment,v_previous,encode(public.digest(coalesce(v_previous,'')||v_id::text||p_mode::text||v_commitment,'sha256'),'hex'));
 insert into engine_private.epoch_seeds(epoch_id,execution_mode,seed) values(v_id,p_mode,v_seed);
 return v_id;
end; $$;

create or replace function public.engine_ensure_epochs() returns integer language plpgsql security definer set search_path='' as $$
declare r record; v_count integer:=0;
begin
 for r in select distinct execution_mode from public.engine_indices where status in ('ACTIVE','PAUSED') loop
  perform public.engine_ensure_epoch(r.execution_mode,now());
  perform public.engine_ensure_epoch(r.execution_mode,now()+interval '1 day');
  v_count:=v_count+2;
 end loop;
 return v_count;
end; $$;

create or replace function public.engine_advance() returns integer language plpgsql security definer set search_path='' as $$
declare r record; v_due bigint; v_tick bigint; v_epoch uuid; v_seed bytea; v_digit smallint; v_x numeric; v_price numeric; v_generated integer:=0;
begin
 perform public.engine_ensure_epochs();
 for r in select i.*,s.last_tick_no,s.last_x from public.engine_indices i join public.index_state s on s.index_code=i.code and s.execution_mode=i.execution_mode where i.status in ('ACTIVE','PAUSED') loop
  continue when not pg_try_advisory_xact_lock(hashtextextended('engine:'||r.code||':'||r.execution_mode::text,0));
  v_due:=floor(extract(epoch from(clock_timestamp()-r.t0)*1000/r.tick_interval_ms));
  for v_tick in r.last_tick_no+1..least(v_due,r.last_tick_no+50) loop
   v_epoch:=public.engine_ensure_epoch(r.execution_mode,r.t0+(v_tick*r.tick_interval_ms)*interval '1 millisecond');
   select s.seed into v_seed from engine_private.epoch_seeds s where s.epoch_id=v_epoch;
   if v_seed is null then raise exception 'engine_epoch_seed_missing'; end if;
   v_digit:=public.engine_digit(v_seed,r.execution_mode,r.code,v_tick);
   v_x:=coalesce(r.last_x,ln(r.base_price))+r.kappa*(ln(r.base_price)-coalesce(r.last_x,ln(r.base_price)))+r.sigma_per_tick*public.engine_walk_normal(v_seed,r.execution_mode,r.code,v_tick);
   v_price:=public.engine_tick_price(r.base_price,r.decimals,v_x,v_digit);
   insert into public.index_ticks(index_code,execution_mode,tick_no,epoch_id,scheduled_at,price,digit) values(r.code,r.execution_mode,v_tick,v_epoch,r.t0+(v_tick*r.tick_interval_ms)*interval '1 millisecond',v_price,v_digit) on conflict do nothing;
   update public.index_state set last_tick_no=v_tick,last_x=v_x,last_price=v_price,updated_at=now() where index_code=r.code and execution_mode=r.execution_mode;
   r.last_x:=v_x; v_generated:=v_generated+1;
   perform public.engine_settle_tick(r.code,r.execution_mode,v_tick);
  end loop;
 end loop;
 return v_generated;
end; $$;

create or replace function public.engine_reveal_due_epochs() returns integer language plpgsql security definer set search_path='' as $$
declare r record; v_count integer:=0;
begin
 for r in select e.id,s.seed from public.engine_epochs e join engine_private.epoch_seeds s on s.epoch_id=e.id where e.revealed_at is null and e.ends_at+interval '10 minutes'<now() and not exists(select 1 from public.engine_contracts c join public.engine_indices i on i.code=c.index_code and i.execution_mode=c.execution_mode where c.execution_mode=e.execution_mode and c.state='OPEN' and (i.t0+(c.entry_tick_no*i.tick_interval_ms)*interval '1 millisecond' between e.starts_at and e.ends_at or i.t0+(c.settle_tick_no*i.tick_interval_ms)*interval '1 millisecond' between e.starts_at and e.ends_at)) loop
  update public.engine_epochs set revealed_seed=encode(r.seed,'hex'),revealed_at=now() where id=r.id;
  v_count:=v_count+1;
 end loop;
 return v_count;
end; $$;

create or replace function public.engine_purge_ticks() returns integer language plpgsql security definer set search_path='' as $$
declare v_removed integer; v_retention integer;
begin
 select tick_retention_days into v_retention from public.engine_policy_versions order by version desc limit 1;
 perform set_config('engine.allow_tick_purge','true',true);
 delete from public.index_ticks t using public.engine_epochs e where e.id=t.epoch_id and e.revealed_at is not null and t.generated_at<now()-(coalesce(v_retention,30)||' days')::interval and not exists(select 1 from public.engine_contracts c where c.index_code=t.index_code and c.execution_mode=t.execution_mode and (c.entry_tick_no=t.tick_no or c.settle_tick_no=t.tick_no));
 get diagnostics v_removed=row_count;
 return v_removed;
end; $$;

create or replace function public.reject_index_tick_mutation() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op='DELETE' and current_setting('engine.allow_tick_purge',true)='true' then return old; end if;
 raise exception 'index_ticks_immutable';
end; $$;

revoke all on function public.engine_u53(bytea,integer),public.engine_walk_normal(bytea,public.execution_mode,text,bigint),public.engine_ensure_epoch(public.execution_mode,timestamptz),public.engine_ensure_epochs(),public.engine_advance(),public.engine_reveal_due_epochs(),public.engine_purge_ticks() from public,anon,authenticated;
