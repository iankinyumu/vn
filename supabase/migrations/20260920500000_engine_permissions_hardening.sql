-- Internal engine routines are cron/definer implementation details.  PostgreSQL
-- otherwise grants EXECUTE to PUBLIC when each routine is created.
do $$
declare v_function regprocedure;
begin
  for v_function in
    select p.oid::regprocedure
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and left(p.proname, 7) = 'engine_'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_function);
  end loop;
end;
$$;

-- Re-grant only the authenticated customer entry points.  These enforce account
-- ownership themselves; engine_assert_account_access remains definer-internal.
grant execute on function public.engine_quote_contract(uuid,text,text,smallint,numeric,integer),
  public.engine_buy_contract(uuid,text,text,smallint,numeric,integer,text)
  to authenticated;

-- Keep the capability registry aligned with the engine RPC surface.  Owner is
-- deliberately the only role that can void contracts or pass the Real gate.
create or replace function admin_private.role_capabilities(p_role text) returns text[]
language sql immutable set search_path = '' as $$
  select case p_role
    when 'support_agent' then array['staff.enter', 'support.read_assigned', 'support.reply', 'support.note', 'support.transition', 'customers.restrict.notice']
    when 'administrator' then array['staff.enter', 'support.read_all', 'support.reply', 'support.note', 'support.transition', 'support.assign', 'support.close', 'engine.read', 'engine.manage', 'contracts.read', 'customers.restrict.notice', 'customers.restrict.limit', 'customers.restrict.block']
    when 'owner' then array['staff.enter', 'support.read_all', 'support.reply', 'support.note', 'support.transition', 'support.assign', 'support.close', 'staff.manage', 'audit.read', 'engine.read', 'engine.manage', 'contracts.read', 'contracts.void', 'platform.enable_real', 'customers.restrict.notice', 'customers.restrict.limit', 'customers.restrict.block', 'customers.restrict.block_severe']
    else array[]::text[] end;
$$;

create or replace function public.set_index_trading_status(p_index text,p_mode public.execution_mode,p_status text,p_reason text) returns void language plpgsql security definer set search_path='' as $$
begin
  perform admin_private.require_staff('engine.manage');
  if p_status not in ('ACTIVE','PAUSED') or char_length(btrim(coalesce(p_reason,''))) < 10 then
    raise exception 'validation_failed';
  end if;
  update public.engine_indices set status=p_status where code=p_index and execution_mode=p_mode;
  if not found then raise exception 'not_found'; end if;
  insert into public.admin_audit_events(actor_id,actor_type,action,target_type,target_id,correlation_id,reason,after_state)
  values(auth.uid(),'staff','engine.index_status','engine_index',public.gen_random_uuid(),public.gen_random_uuid(),btrim(p_reason),jsonb_build_object('index_code',p_index,'execution_mode',p_mode,'status',p_status));
end;
$$;

revoke all on table engine_private.epoch_seeds from public, anon, authenticated;
