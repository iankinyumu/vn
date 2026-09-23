create or replace function public.engine_ensure_epoch(p_mode public.execution_mode,p_time timestamptz) returns uuid language plpgsql security definer set search_path='' as $$
declare v_start timestamptz:=date_trunc('day',p_time); v_id uuid; v_seed bytea; v_commitment text; v_previous text;
begin
 perform pg_advisory_xact_lock(hashtextextended('engine-epoch:'||p_mode::text||':'||v_start::text,0));
 select id into v_id from public.engine_epochs where execution_mode=p_mode and starts_at=v_start;
 if found then return v_id; end if;
 v_id:=public.gen_random_uuid();
 v_seed:=public.gen_random_bytes(32); v_commitment:=encode(public.digest(v_seed,'sha256'),'hex');
 select chain_hash into v_previous from public.engine_epochs where execution_mode=p_mode order by starts_at desc limit 1;
 insert into public.engine_epochs(id,execution_mode,starts_at,ends_at,seed_commitment,prev_chain_hash,chain_hash)
 values(v_id,p_mode,v_start,v_start+interval '1 day',v_commitment,v_previous,encode(public.digest(coalesce(v_previous,'')||v_id::text||p_mode::text||v_commitment,'sha256'),'hex'));
 insert into engine_private.epoch_seeds(epoch_id,execution_mode,seed) values(v_id,p_mode,v_seed);
 return v_id;
end; $$;
