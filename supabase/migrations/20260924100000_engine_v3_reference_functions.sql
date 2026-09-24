-- Engine generation version 3, SQL reference functions (docs/adr/0001-synthetic-engine-v3.md).
-- Phase 1b: these are pure functions only. Nothing calls them yet; engine_advance
-- stays on version 2 and no v1/v2 tick, epoch or contract is read or changed.
-- They live in engine_private, which no API role can use. They must reproduce
-- engine/v3/vectors.json byte for byte (scripts/test-engine-postgres.mjs).
-- Integer steps use numeric with div()/mod() only; numeric `/` rounds and is
-- never used in a normative step.

create or replace function engine_private.v3_uint(p_value numeric, p_bytes integer) returns bytea
language plpgsql immutable set search_path='' as $$
declare v_out bytea:=''::bytea; v_rest numeric:=p_value; i integer;
begin
 if p_value is null or p_value<>trunc(p_value) or p_value<0 or p_value>=power(2::numeric,8*p_bytes) then
  raise exception 'engine_v3_integer_out_of_range';
 end if;
 for i in 1..p_bytes loop
  v_out:=set_byte('\x00'::bytea,0,mod(v_rest,256)::integer)||v_out;
  v_rest:=div(v_rest,256);
 end loop;
 return v_out;
end; $$;

create or replace function engine_private.v3_label(p_text text) returns bytea
language plpgsql immutable set search_path='' as $$
begin
 if p_text is null or p_text !~ '^[A-Za-z0-9._-]{1,64}$' or octet_length(p_text)<>length(p_text) then
  raise exception 'engine_v3_label_invalid';
 end if;
 return engine_private.v3_uint(length(p_text),2)||convert_to(p_text,'UTF8');
end; $$;

create or replace function engine_private.v3_header(p_kind text) returns bytea
language sql immutable set search_path='' as $$
 select engine_private.v3_label('smartprofit-engine')||engine_private.v3_label('v3')||engine_private.v3_label(p_kind) $$;

create or replace function engine_private.v3_hash32(p_value bytea) returns bytea
language plpgsql immutable set search_path='' as $$
begin
 if p_value is null or octet_length(p_value)<>32 then raise exception 'engine_v3_hash_invalid'; end if;
 return p_value;
end; $$;

create or replace function engine_private.v3_isqrt(p_value numeric) returns numeric
language plpgsql immutable set search_path='' as $$
declare v numeric;
begin
 if p_value<0 then raise exception 'engine_v3_negative_sqrt'; end if;
 v:=floor(sqrt(p_value));
 while v*v>p_value loop v:=v-1; end loop;
 while (v+1)*(v+1)<=p_value loop v:=v+1; end loop;
 return v;
end; $$;

create or replace function engine_private.v3_sigma_e12(p_annual_vol_bp numeric,p_tick_interval_ms numeric) returns numeric
language sql immutable set search_path='' as $$
 select engine_private.v3_isqrt(div(p_annual_vol_bp*p_annual_vol_bp*power(10::numeric,16),div(365*86400000::numeric,p_tick_interval_ms))) $$;

-- RFC 5869 with one output block (L = 32). pgcrypto's hmac is hmac(data, key, type).
create or replace function engine_private.v3_hkdf32(p_salt bytea,p_ikm bytea,p_info bytea) returns bytea
language sql immutable set search_path='' as $$
 select public.hmac(p_info||'\x01'::bytea,public.hmac(p_ikm,p_salt,'sha256'),'sha256') $$;

create or replace function engine_private.v3_seed_hash(p_seed bytea) returns bytea
language plpgsql immutable set search_path='' as $$
begin
 if p_seed is null or octet_length(p_seed)<>32 then raise exception 'engine_v3_seed_invalid'; end if;
 return public.digest(engine_private.v3_header('seed-hash')||p_seed,'sha256');
end; $$;

create or replace function engine_private.v3_derive_key(p_seed bytea,p_purpose text,p_env text,p_mode text,p_index text,p_epoch_start_ms numeric) returns bytea
language plpgsql immutable set search_path='' as $$
begin
 if p_seed is null or octet_length(p_seed)<>32 then raise exception 'engine_v3_seed_invalid'; end if;
 if p_purpose is null or p_purpose not in ('price-move','price-digit') then raise exception 'engine_v3_purpose_invalid'; end if;
 if p_env is null or p_env not in ('production','staging','test') then raise exception 'engine_v3_env_invalid'; end if;
 if p_mode is null or p_mode not in ('DEMO','REAL') then raise exception 'engine_v3_mode_invalid'; end if;
 if p_index is null or p_index not in ('SPI10','SPI25','SPI50','SPI75','SPI100') then raise exception 'engine_v3_index_invalid'; end if;
 return engine_private.v3_hkdf32(convert_to('smartprofit-engine/v3/hkdf','UTF8'),p_seed,
  engine_private.v3_header('key')||engine_private.v3_label(p_purpose)||engine_private.v3_label(p_env)
  ||engine_private.v3_label(p_mode)||engine_private.v3_label(p_index)||engine_private.v3_uint(p_epoch_start_ms,8));
end; $$;

create or replace function engine_private.v3_tick_message(p_tick_no numeric,p_counter numeric) returns bytea
language sql immutable set search_path='' as $$
 select engine_private.v3_label('tick')||engine_private.v3_uint(p_tick_no,8)||engine_private.v3_uint(p_counter,4) $$;

-- ADR §5: innovation, digit residue and transition. Raises on a band breach;
-- the caller must halt the index, never reroll.
create or replace function engine_private.v3_price(
 p_move_key bytea,p_digit_key bytea,p_tick_no numeric,p_prev_units numeric,p_anchor_units numeric,
 p_sigma_e12 numeric,p_kappa_e12 numeric,p_min_units numeric,p_max_units numeric,
 out price_units numeric,out digit smallint,out z numeric,out parity integer,out residue integer,out digit_counter numeric,out coarse numeric
) language plpgsql immutable set search_path='' as $$
declare v_block bytea; v_num numeric; v_den numeric:=power(10::numeric,12)*131072; i integer;
begin
 v_block:=public.hmac(engine_private.v3_tick_message(p_tick_no,0),p_move_key,'sha256');
 z:=0;
 for i in 0..11 loop z:=z+2*(get_byte(v_block,2*i)*256+get_byte(v_block,2*i+1))-65535; end loop;
 parity:=get_byte(v_block,24)&1;
 digit_counter:=0;
 <<search>> loop
  if digit_counter>4294967295 then raise exception 'engine_v3_residue_exhausted'; end if;
  v_block:=public.hmac(engine_private.v3_tick_message(p_tick_no,digit_counter),p_digit_key,'sha256');
  for i in 0..31 loop
   if get_byte(v_block,i)<250 then residue:=mod(get_byte(v_block,i),10); exit search; end if;
  end loop;
  digit_counter:=digit_counter+1;
 end loop;
 v_num:=p_prev_units*p_sigma_e12*z+p_kappa_e12*(p_anchor_units-p_prev_units)*131072+5*v_den;
 -- floor division: div() truncates toward zero.
 coarse:=div(v_num,10*v_den)-case when v_num<0 and mod(v_num,10*v_den)<>0 then 1 else 0 end;
 price_units:=p_prev_units+10*coarse+residue-4-parity;
 if price_units<p_min_units or price_units>p_max_units then raise exception 'engine_v3_price_out_of_band'; end if;
 digit:=mod(price_units,10)::smallint;
end; $$;

-- p_entries: jsonb array of configuration entries with the ADR §4.3 field names.
create or replace function engine_private.v3_config_hash(p_env text,p_mode text,p_entries jsonb) returns bytea
language plpgsql immutable set search_path='' as $$
declare v_body bytea:=''::bytea; v_count integer:=0; e jsonb;
begin
 if p_env is null or p_env not in ('production','staging','test') then raise exception 'engine_v3_env_invalid'; end if;
 if p_mode is null or p_mode not in ('DEMO','REAL') then raise exception 'engine_v3_mode_invalid'; end if;
 if (select count(distinct x->>'index') from jsonb_array_elements(p_entries) x)<>jsonb_array_length(p_entries) then
  raise exception 'engine_v3_config_duplicate_index';
 end if;
 for e in select x from jsonb_array_elements(p_entries) x order by convert_to(x->>'index','UTF8') loop
  if (e->>'index') not in ('SPI10','SPI25','SPI50','SPI75','SPI100') then raise exception 'engine_v3_index_invalid'; end if;
  if (e->>'sigma_e12')::numeric<>engine_private.v3_sigma_e12((e->>'annual_vol_bp')::numeric,(e->>'tick_interval_ms')::numeric) then
   raise exception 'engine_v3_config_sigma_mismatch';
  end if;
  v_body:=v_body||engine_private.v3_label(e->>'index')||engine_private.v3_uint((e->>'annual_vol_bp')::numeric,4)
   ||engine_private.v3_uint((e->>'tick_interval_ms')::numeric,4)||engine_private.v3_uint((e->>'decimals')::numeric,1)
   ||engine_private.v3_uint((e->>'anchor_units')::numeric,8)||engine_private.v3_uint((e->>'sigma_e12')::numeric,8)
   ||engine_private.v3_uint((e->>'kappa_e12')::numeric,8)||engine_private.v3_uint((e->>'min_units')::numeric,8)
   ||engine_private.v3_uint((e->>'max_units')::numeric,8)||engine_private.v3_uint((e->>'t0_ms')::numeric,8)
   ||engine_private.v3_uint((e->>'genesis_tick_no')::numeric,8)||engine_private.v3_uint((e->>'genesis_units')::numeric,8);
  v_count:=v_count+1;
 end loop;
 return public.digest(engine_private.v3_header('model-config')||engine_private.v3_label(p_env)||engine_private.v3_label(p_mode)
  ||engine_private.v3_uint(v_count,4)||v_body,'sha256');
end; $$;

create or replace function engine_private.v3_epoch_commitment(p_env text,p_mode text,p_epoch_start_ms numeric,p_seed_hash bytea,p_config_hash bytea,p_prev_commitment bytea) returns bytea
language sql immutable set search_path='' as $$
 select public.digest(engine_private.v3_header('epoch-commitment')||engine_private.v3_label(p_env)||engine_private.v3_label(p_mode)
  ||engine_private.v3_uint(p_epoch_start_ms,8)||engine_private.v3_uint(p_epoch_start_ms+86400000,8)
  ||engine_private.v3_hash32(p_seed_hash)||engine_private.v3_hash32(p_config_hash)
  ||engine_private.v3_hash32(coalesce(p_prev_commitment,'\x0000000000000000000000000000000000000000000000000000000000000000'::bytea)),'sha256') $$;

create or replace function engine_private.v3_genesis_hash(p_env text,p_mode text,p_index text,p_genesis_tick_no numeric,p_genesis_units numeric,p_config_hash bytea) returns bytea
language sql immutable set search_path='' as $$
 select public.digest(engine_private.v3_header('genesis')||engine_private.v3_label(p_env)||engine_private.v3_label(p_mode)||engine_private.v3_label(p_index)
  ||engine_private.v3_uint(p_genesis_tick_no,8)||engine_private.v3_uint(p_genesis_units,8)||engine_private.v3_hash32(p_config_hash),'sha256') $$;

create or replace function engine_private.v3_tick_hash(
 p_env text,p_mode text,p_index text,p_tick_no numeric,p_scheduled_ms numeric,p_generated_ms numeric,p_epoch_start_ms numeric,
 p_prev_units numeric,p_price_units numeric,p_decimals numeric,p_digit numeric,p_config_hash bytea,p_commitment bytea,p_prev_tick_hash bytea
) returns bytea language sql immutable set search_path='' as $$
 select public.digest(engine_private.v3_header('tick')||engine_private.v3_label(p_env)||engine_private.v3_label(p_mode)||engine_private.v3_label(p_index)
  ||engine_private.v3_uint(p_tick_no,8)||engine_private.v3_uint(p_scheduled_ms,8)||engine_private.v3_uint(p_generated_ms,8)
  ||engine_private.v3_uint(p_epoch_start_ms,8)||engine_private.v3_uint(p_prev_units,8)||engine_private.v3_uint(p_price_units,8)
  ||engine_private.v3_uint(p_decimals,1)||engine_private.v3_uint(p_digit,1)||engine_private.v3_hash32(p_config_hash)
  ||engine_private.v3_hash32(p_commitment)||engine_private.v3_hash32(p_prev_tick_hash),'sha256') $$;

do $$
declare f record;
begin
 for f in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='engine_private' and p.proname like 'v3\_%' loop
  execute format('revoke all on function %s from public',f.sig);
  if exists(select 1 from pg_roles where rolname='anon') then execute format('revoke all on function %s from anon',f.sig); end if;
  if exists(select 1 from pg_roles where rolname='authenticated') then execute format('revoke all on function %s from authenticated',f.sig); end if;
 end loop;
end $$;
