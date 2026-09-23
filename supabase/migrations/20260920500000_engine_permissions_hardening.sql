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

revoke all on function public.enable_real_accounts(text,jsonb,text), public.disable_real_accounts(text) from public, anon;
grant execute on function public.enable_real_accounts(text,jsonb,text), public.disable_real_accounts(text) to authenticated;

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

create or replace function public.enable_real_accounts(p_checklist_version text,p_evidence jsonb,p_reason text) returns uuid language plpgsql security definer set search_path='' as $$
declare v_checklist public.real_readiness_checklists%rowtype; v_actor public.staff_roles%rowtype; v_required text[]:=array['seed_custody','funding_reconciliation','real_policy','step_up_authentication','conformance_parity','owner_signoff']; v_key text; v_value text; v_audit uuid;
begin
  v_actor:=admin_private.require_staff('platform.enable_real',true);
  if v_actor.role <> 'owner' then raise exception 'forbidden'; end if;
  select * into v_checklist from public.real_readiness_checklists order by published_at desc limit 1;
  if not found or v_checklist.version <> p_checklist_version then raise exception 'checklist_outdated'; end if;
  if jsonb_typeof(v_checklist.items) <> 'object' or not (v_checklist.items ?& v_required) or jsonb_typeof(p_evidence) <> 'object' or not (p_evidence ?& v_required) then raise exception 'evidence_incomplete'; end if;
  foreach v_key in array v_required loop
    v_value:=btrim(coalesce(p_evidence->>v_key,''));
    if v_value !~ '^(https?://|PR-[0-9]+$|run:[A-Za-z0-9._-]+$)' then raise exception 'evidence_incomplete: %',v_key; end if;
  end loop;
  if char_length(btrim(coalesce(p_reason,''))) < 20 then raise exception 'validation_failed'; end if;
  update public.platform_modules set enabled=true,changed_at=now(),reason=btrim(p_reason) where module_key='real_accounts';
  insert into public.admin_audit_events(actor_id,actor_type,action,target_type,target_id,correlation_id,reason,after_state)
  values(auth.uid(),'staff','platform.enable_real','platform',public.gen_random_uuid(),public.gen_random_uuid(),btrim(p_reason),jsonb_build_object('checklist_version',v_checklist.version,'evidence',p_evidence,'owner',v_actor.user_id)) returning id into v_audit;
  return v_audit;
end;
$$;

create or replace function public.disable_real_accounts(p_reason text) returns uuid language plpgsql security definer set search_path='' as $$
declare v_actor public.staff_roles%rowtype; v_audit uuid;
begin
  v_actor:=admin_private.require_staff('platform.enable_real',true);
  if v_actor.role <> 'owner' then raise exception 'forbidden'; end if;
  if char_length(btrim(coalesce(p_reason,''))) < 20 then raise exception 'validation_failed'; end if;
  update public.platform_modules set enabled=false,changed_at=now(),reason=btrim(p_reason) where module_key='real_accounts';
  insert into public.admin_audit_events(actor_id,actor_type,action,target_type,target_id,correlation_id,reason,after_state)
  values(auth.uid(),'staff','platform.disable_real','platform',public.gen_random_uuid(),public.gen_random_uuid(),btrim(p_reason),jsonb_build_object('owner',v_actor.user_id)) returning id into v_audit;
  return v_audit;
end;
$$;

revoke all on table engine_private.epoch_seeds from public, anon, authenticated;
revoke all on table public.real_readiness_checklists from public, anon, authenticated;
